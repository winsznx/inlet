import { estimateCostUsd, fetchCatalog, NON_AI_HARNESS_ID, PROMPT_VERSION, runAgentLoop, runNonAiHarness, selectAgentModel, VultrInferenceClient } from "@inlet/agent";
import type { LoopResult, ModelCapabilities } from "@inlet/agent";
import { env, inferenceConfigured } from "@inlet/config";
import { audit, enqueue, transitionIncident } from "@inlet/control";
import { and, checkRuns, db, desc, eq, formConfigs, incidents, investigations, isNull, organizations, sites, sourceConnections } from "@inlet/database";
import { BUILD_PROFILES } from "@inlet/policy";
import { log } from "../context";
import { appendInvestigationEvent, ControllerToolHost, destinationNameFor, RepairEnvironmentError } from "../repair/tool-host";
import { refreshFixtureRepository, SanitizedWorktree } from "@inlet/control";

type Investigation = typeof investigations.$inferSelect;
type IncidentState = (typeof incidents.$inferSelect)["state"];

async function settle(
  investigation: Investigation,
  state: Investigation["state"],
  incidentState: IncidentState,
  detail: { errorCode?: string; errorDetail?: string; reason: string },
): Promise<void> {
  await db()
    .update(investigations)
    .set({ state, completedAt: new Date(), leaseExpiresAt: null, errorCode: detail.errorCode, errorDetail: detail.errorDetail })
    .where(eq(investigations.id, investigation.id));
  const [incident] = await db().select().from(incidents).where(eq(incidents.id, investigation.incidentId));
  if (!incident || incident.state === incidentState) return;
  if (incident.state === "patch_proposed" || incident.state === "patch_testing") {
    if (incidentState === "investigation_failed") {
      await transitionIncident(incident.id, "investigation_failed", { actor: "agent", reason: detail.reason });
      return;
    }
    await transitionIncident(incident.id, "patch_failed", { actor: "agent", reason: detail.reason });
    return;
  }
  await transitionIncident(incident.id, incidentState, { actor: "agent", reason: detail.reason });
}

export async function processInvestigation(investigationId: string): Promise<void> {
  const [investigation] = await db().select().from(investigations).where(eq(investigations.id, investigationId));
  if (!investigation || investigation.state !== "queued") return;

  const [incident] = await db().select().from(incidents).where(eq(incidents.id, investigation.incidentId));
  if (!incident) return;

  await db()
    .update(investigations)
    .set({ state: "running", startedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 600_000), promptVersion: PROMPT_VERSION })
    .where(eq(investigations.id, investigationId));

  const [site] = await db().select().from(sites).where(eq(sites.id, incident.siteId));
  const [connection] = await db()
    .select()
    .from(sourceConnections)
    .where(and(eq(sourceConnections.siteId, incident.siteId), isNull(sourceConnections.deletedAt)))
    .limit(1);
  const [config] = await db().select().from(formConfigs).where(eq(formConfigs.siteId, incident.siteId)).orderBy(desc(formConfigs.version)).limit(1);
  const [org] = await db().select().from(organizations).where(eq(organizations.id, incident.organizationId));

  if (!site || !org || !config) {
    await settle(investigation, "failed", "investigation_failed", { errorCode: "site_missing", reason: "The website configuration is missing." });
    return;
  }
  if (!connection) {
    await settle(investigation, "needs_configuration", "needs_configuration", { errorCode: "repository_required", reason: "Connect the source repository to investigate code." });
    return;
  }

  let client: VultrInferenceClient | null = null;
  let model: ModelCapabilities | null = null;
  if (investigation.origin === "vultr_inference") {
    if (!inferenceConfigured()) {
      await settle(investigation, "needs_configuration", "needs_configuration", { errorCode: "inference_not_configured", reason: "Connect inference to investigate code." });
      return;
    }
    try {
      const catalog = await fetchCatalog();
      model = selectAgentModel(catalog, env().VULTR_INFERENCE_MODEL);
      if (!model) throw new Error("No tool-capable model is available in the live catalog.");
      client = new VultrInferenceClient(model.id);
      await db().update(investigations).set({ modelId: model.id }).where(eq(investigations.id, investigationId));
    } catch (error) {
      await settle(investigation, "failed", "investigation_failed", {
        errorCode: "model_unavailable",
        errorDetail: error instanceof Error ? error.message : "catalog error",
        reason: "The inference catalog could not supply a usable model.",
      });
      return;
    }
  } else {
    await db().update(investigations).set({ modelId: NON_AI_HARNESS_ID }).where(eq(investigations.id, investigationId));
  }

  await appendInvestigationEvent(investigationId, "investigation.started", investigation.origin === "vultr_inference" ? "Investigation started." : "Non-AI test harness started. No model is used in this run.", null, {
    origin: investigation.origin,
    ...(model ? { modelId: model.id } : {}),
  });

  let worktree: SanitizedWorktree | null = null;
  let host: ControllerToolHost | null = null;
  try {
    if (connection.isControlledFixture) await refreshFixtureRepository(connection);
    const [fresh] = await db().select().from(sourceConnections).where(eq(sourceConnections.id, connection.id));
    worktree = await SanitizedWorktree.create(fresh ?? connection);
    await db().update(investigations).set({ baseCommitSha: worktree.baseCommitSha }).where(eq(investigations.id, investigationId));

    const destinationName = await destinationNameFor(site.id);
    host = new ControllerToolHost({
      investigation,
      incident,
      site,
      connection: fresh ?? connection,
      config,
      destinationName,
      retentionDays: org.retentionDays,
      worktree,
    });

    const [openedBy] = await db().select({ window: checkRuns.observationWindowSeconds }).from(checkRuns).where(eq(checkRuns.id, incident.openedByRunId));
    const profile = BUILD_PROFILES[connection.buildProfile];
    const result: LoopResult = client
      ? await runAgentLoop(
          client,
          {
            siteName: site.name,
            destinationName,
            observationWindowSeconds: openedBy?.window ?? 30,
            approvedPaths: connection.approvedPaths,
            buildProfile: connection.buildProfile,
            requiredChecks: [...(profile?.requiredChecks ?? []), "fixture-delivery"],
          },
          host,
        )
      : await runNonAiHarness(host);

    await host.dispose();
    if (result.status !== "patch_ready") await host.markCurrentFailed();
    await settleLoop(investigation, result, model);
    if (result.status === "patch_ready") {
      await enqueue("notifications", incident.id, { kind: "action_required", incidentId: incident.id, siteId: site.id });
      await audit({ organizationId: incident.organizationId, entityType: "investigation", entityId: investigationId, action: "investigation.patch_ready", safeMetadata: { origin: investigation.origin, modelId: model?.id } });
    }
  } catch (error) {
    log.error({ err: error, investigationId }, "investigation failed");
    const environment = error instanceof RepairEnvironmentError;
    await host?.dispose().catch(() => undefined);
    await host?.markCurrentFailed().catch(() => undefined);
    await appendInvestigationEvent(
      investigationId,
      "investigation.failed",
      environment ? "The test environment couldn't start. Your website and repository were not changed." : "The investigation stopped unexpectedly. Your website and repository were not changed.",
      null,
    );
    await settle(investigation, "interrupted", "investigation_failed", {
      errorCode: environment ? "sandbox_failed" : "unexpected",
      errorDetail: error instanceof Error ? error.message.slice(0, 500) : "error",
      reason: "The investigation was interrupted.",
    });
  } finally {
    await host?.dispose();
    await worktree?.dispose();
  }
}

async function settleLoop(investigation: Investigation, result: LoopResult, model: ModelCapabilities | null): Promise<void> {
  const [usage] = await db().select().from(investigations).where(eq(investigations.id, investigation.id));
  const cost = usage ? estimateCostUsd(model, usage.promptTokens, usage.completionTokens) : null;
  if (cost !== null) {
    await db().update(investigations).set({ costEstimateUsd: cost.toFixed(6) }).where(eq(investigations.id, investigation.id));
  }
  switch (result.status) {
    case "patch_ready":
      await db().update(investigations).set({ state: "patch_ready", completedAt: new Date(), leaseExpiresAt: null }).where(eq(investigations.id, investigation.id));
      return;
    case "non_code_cause":
      await settle(investigation, "no_code_cause", "repair_unavailable", { reason: "The evidence points outside the application code." });
      return;
    case "inference_error":
      await appendInvestigationEvent(investigation.id, "investigation.failed", "The inference service could not complete the investigation.", null, { code: result.code });
      await settle(investigation, "failed", "investigation_failed", { errorCode: result.code, errorDetail: result.detail, reason: "Inference failed." });
      return;
    default:
      await appendInvestigationEvent(investigation.id, "investigation.failed", "We couldn't verify a code repair.", null);
      await settle(investigation, "failed", "patch_failed", { errorCode: result.status, errorDetail: result.detail, reason: "No candidate passed every check." });
  }
}
