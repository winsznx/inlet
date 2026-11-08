import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { appendRunEvent, runChannel, startSiteCheck } from "@inlet/control";
import { and, asc, checkRuns, db, deliveryObservations, desc, destinations, eq, gt, gte, ilike, isNull, lt, lte, policyDecisions, runArtifacts, runEvents, sandboxSessions, sites, sql } from "@inlet/database";
import { AppError, can, maskToken, RUN_RESULTS } from "@inlet/domain";
import type { BrowserOutcome, Role, RunEventType, RunEventView } from "@inlet/domain";
import { buildEvidenceZip, decryptSecret, getObject, signDownload, verifyDownload } from "@inlet/evidence";
import { requireOrg } from "../plumbing/auth";
import type { OrgContext } from "../plumbing/auth";
import { streamEvents } from "../plumbing/sse";
import { loadSite } from "./sites";

const runParams = z.object({ runId: z.uuid() });

export async function loadRun(organizationId: string, runId: string): Promise<typeof checkRuns.$inferSelect> {
  const [run] = await db().select().from(checkRuns).where(and(eq(checkRuns.id, runId), eq(checkRuns.organizationId, organizationId)));
  if (!run) throw new AppError("NOT_FOUND", "That check does not exist.");
  return run;
}

export function eventView(row: typeof runEvents.$inferSelect): RunEventView & { stage: string } {
  return {
    eventId: row.id,
    runId: row.runId,
    sequence: row.sequence,
    timestamp: row.timestamp.toISOString(),
    type: row.eventType as RunEventType,
    stage: row.stage,
    summary: row.safePublicSummary,
    artifactIds: row.artifactIds ?? undefined,
    safeMetadata: row.redactedPayload ?? undefined,
  };
}

export async function runDetail(run: typeof checkRuns.$inferSelect, options: { revealToken: boolean; includePolicy: boolean }) {
  const [site] = run.siteId ? await db().select().from(sites).where(eq(sites.id, run.siteId)) : [];
  const [observation] = await db().select().from(deliveryObservations).where(eq(deliveryObservations.runId, run.id));
  const [destination] = run.destinationId ? await db().select().from(destinations).where(eq(destinations.id, run.destinationId)) : [];
  const artifacts = await db().select().from(runArtifacts).where(and(eq(runArtifacts.runId, run.id), isNull(runArtifacts.deletedAt))).orderBy(asc(runArtifacts.createdAt));
  const events = await db().select().from(runEvents).where(eq(runEvents.runId, run.id)).orderBy(asc(runEvents.sequence));
  const sandboxes = await db().select().from(sandboxSessions).where(eq(sandboxSessions.runId, run.id));
  const decisions = options.includePolicy
    ? await db()
        .select()
        .from(policyDecisions)
        .where(sql`${policyDecisions.sandboxId} in (select id from sandbox_sessions where run_id = ${run.id})`)
        .orderBy(asc(policyDecisions.timestamp))
        .limit(400)
    : [];
  const outcome = run.browserOutcome as BrowserOutcome | null;
  const token = decryptSecret(run.testTokenEncrypted);
  return {
    runId: run.id,
    siteId: run.siteId,
    siteName: site?.name ?? null,
    siteOrigin: site?.verifiedOrigin ?? null,
    isControlledFixture: Boolean(site?.fixtureSlot),
    kind: run.kind,
    scenario: run.scenario,
    trigger: run.trigger,
    state: run.state,
    result: run.result,
    summary: run.resultSummary,
    incidentId: run.incidentId,
    testToken: options.revealToken ? token : maskToken(token),
    browser: outcome
      ? {
          navigated: outcome.navigated,
          httpStatus: outcome.httpStatus,
          fieldsFilled: outcome.fieldsFilled,
          submissionObserved: outcome.submitObserved,
          submitClicked: outcome.submitClicked,
          successUiObserved: outcome.successUiObserved,
          successUiText: outcome.successUiText,
          captchaDetected: outcome.captchaDetected,
          failure: outcome.failure,
          failureDetail: outcome.failureDetail,
          network: outcome.network,
        }
      : null,
    delivery: {
      destinationName: destination?.displayName ?? null,
      destinationType: destination?.type ?? null,
      accessible: observation ? observation.status !== "unavailable" : null,
      correlatedReceiptFound: observation?.matchFound ?? false,
      status: observation?.status ?? null,
      matchedAt: observation?.matchedAt ?? null,
      matchSource: observation?.matchSource ?? null,
      recipient: observation?.matchedRecipient ?? null,
      subject: observation?.matchedSubject ?? null,
      remoteMessageIdHash: observation?.remoteMessageIdHash ?? null,
      pollCount: observation?.pollCount ?? 0,
      searchStartedAt: observation?.searchStartedAt ?? null,
      searchEndedAt: observation?.searchEndedAt ?? null,
      errorCode: observation?.errorCode ?? null,
      verifierVersion: observation?.verifierVersion ?? null,
      observationSeconds: run.observationWindowSeconds,
      deadlineAt: run.observationDeadlineAt,
    },
    evidence: artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, mime: artifact.mime, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256, createdAt: artifact.createdAt })),
    events: events.map(eventView),
    sandboxes: sandboxes.map((sandbox) => ({
      id: sandbox.id,
      role: sandbox.role,
      provider: sandbox.provider,
      ociRuntime: sandbox.ociRuntime,
      containerName: sandbox.containerName,
      containerId: sandbox.containerId,
      imageDigest: sandbox.runtimeImageDigest,
      cpuLimit: Number(sandbox.cpuLimit),
      memoryLimitMb: sandbox.memoryLimitMb,
      pidsLimit: sandbox.pidsLimit,
      wallLimitSeconds: sandbox.wallLimitSeconds,
      networkPolicy: sandbox.networkPolicy,
      networkPolicyHash: sandbox.networkPolicyHash,
      hardening: sandbox.hardening,
      startedAt: sandbox.startedAt,
      stoppedAt: sandbox.stoppedAt,
      exitCode: sandbox.exitCode,
      exitReason: sandbox.exitReason,
      oomKilled: sandbox.oomKilled,
      cleanupVerified: sandbox.cleanupVerified,
      cleanupVerifiedAt: sandbox.cleanupVerifiedAt,
      denialCount: sandbox.denialCount,
    })),
    policyDecisions: decisions.map((decision) => ({ id: decision.id, layer: decision.layer, actionType: decision.actionType, target: decision.actionTargetRedacted, allowed: decision.allowed, reasonCode: decision.reasonCode, timestamp: decision.timestamp })),
    startedAt: run.startedAt,
    submittedAt: run.submittedAt,
    completedAt: run.completedAt,
    cleanupAt: run.cleanupAt,
    durationMs: run.durationMs,
    createdAt: run.createdAt,
    canCancel: !run.submissionIntentAt && ["queued", "provisioning", "opening_form", "mapping_fields"].includes(run.state),
  };
}

function detailOptions(context: OrgContext): { revealToken: boolean; includePolicy: boolean } {
  return { revealToken: can(context.role as Role, "run:start"), includePolicy: can(context.role as Role, "policy:view") };
}

const listQuery = z.object({
  siteId: z.uuid().optional(),
  status: z.enum([...RUN_RESULTS, "active"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().max(80).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function listFilter(context: OrgContext, query: z.infer<typeof listQuery>) {
  return and(
    eq(checkRuns.organizationId, context.organizationId),
    eq(checkRuns.kind, "delivery"),
    query.siteId ? eq(checkRuns.siteId, query.siteId) : undefined,
    query.status === "active" ? isNull(checkRuns.result) : query.status ? eq(checkRuns.result, query.status) : undefined,
    query.from ? gte(checkRuns.createdAt, query.from) : undefined,
    query.to ? lte(checkRuns.createdAt, query.to) : undefined,
    query.search ? ilike(sql`${checkRuns.id}::text`, `${query.search.replace(/[%_]/g, "")}%`) : undefined,
  );
}

const csvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;

export const runRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/sites/:siteId/runs",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, schema: { params: z.object({ siteId: z.uuid() }), body: z.object({ trigger: z.enum(["manual", "first_check"]).default("manual"), reason: z.string().max(120).optional() }) } },
    async (request, reply) => {
      const context = await requireOrg(request, "run:start");
      const site = await loadSite(context, request.params.siteId);
      const key = request.headers["idempotency-key"];
      if (key !== undefined && (typeof key !== "string" || key.length > 120)) throw new AppError("INVALID_INPUT", "Invalid Idempotency-Key header.");
      const { runId } = await startSiteCheck({ organizationId: context.organizationId, siteId: site.id, trigger: request.body.trigger, reason: request.body.reason, idempotencyKey: key, actorUserId: context.user.id });
      const [run] = await db().select({ state: checkRuns.state }).from(checkRuns).where(eq(checkRuns.id, runId));
      return reply.status(202).send({ runId, state: run?.state ?? "queued", statusUrl: `/api/v1/runs/${runId}`, eventsUrl: `/api/v1/runs/${runId}/events` });
    },
  );

  app.get("/runs", { schema: { querystring: listQuery } }, async (request) => {
    const context = await requireOrg(request);
    const query = request.query;
    const rows = await db()
      .select({ run: checkRuns, siteName: sites.name, formUrl: sites.formUrl })
      .from(checkRuns)
      .leftJoin(sites, eq(checkRuns.siteId, sites.id))
      .where(and(listFilter(context, query), query.cursor ? lt(checkRuns.id, query.cursor) : undefined))
      .orderBy(desc(checkRuns.id))
      .limit(query.limit + 1);
    return {
      runs: rows.slice(0, query.limit).map(({ run, siteName, formUrl }) => ({
        runId: run.id,
        siteId: run.siteId,
        siteName,
        formPath: formUrl ? new URL(formUrl).pathname : null,
        state: run.state,
        result: run.result,
        trigger: run.trigger,
        startedAt: run.startedAt,
        durationMs: run.durationMs,
        hasEvidence: Boolean(run.browserOutcome),
      })),
      nextCursor: rows.length > query.limit ? rows[query.limit - 1]?.run.id : null,
    };
  });

  app.get("/runs.csv", { schema: { querystring: listQuery } }, async (request, reply) => {
    const context = await requireOrg(request);
    const rows = await db()
      .select({ run: checkRuns, siteName: sites.name, formUrl: sites.formUrl })
      .from(checkRuns)
      .leftJoin(sites, eq(checkRuns.siteId, sites.id))
      .where(listFilter(context, request.query))
      .orderBy(desc(checkRuns.id))
      .limit(5000);
    const header = ["Run ID", "Site", "Form", "Result", "State", "Trigger", "Started", "Duration (ms)"];
    const lines = rows.map(({ run, siteName, formUrl }) => [run.id, siteName, formUrl, run.result, run.state, run.trigger, run.startedAt?.toISOString(), run.durationMs].map(csvCell).join(","));
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="inlet-checks.csv"');
    return reply.send([header.map(csvCell).join(","), ...lines].join("\n"));
  });

  app.get("/runs/:runId", { schema: { params: runParams } }, async (request) => {
    const context = await requireOrg(request);
    return runDetail(await loadRun(context.organizationId, request.params.runId), detailOptions(context));
  });

  app.get("/runs/:runId/events", { schema: { params: runParams } }, async (request, reply) => {
    const context = await requireOrg(request);
    const run = await loadRun(context.organizationId, request.params.runId);
    await streamEvents(request, reply, {
      channel: runChannel(run.id),
      load: async (after) => (await db().select().from(runEvents).where(and(eq(runEvents.runId, run.id), gt(runEvents.sequence, after))).orderBy(asc(runEvents.sequence)).limit(200)).map(eventView),
      isFinished: async () => (await db().select({ state: checkRuns.state }).from(checkRuns).where(eq(checkRuns.id, run.id)))[0]?.state === "cleanup_complete",
    });
  });

  app.post("/runs/:runId/cancel", { schema: { params: runParams } }, async (request) => {
    const context = await requireOrg(request, "run:start");
    const run = await loadRun(context.organizationId, request.params.runId);
    if (run.submissionIntentAt) {
      throw new AppError("SUBMISSION_ALREADY_EXECUTED", "The test enquiry has already been submitted, so this check can't be canceled.", { nextAction: "Wait for the delivery result." });
    }
    if (run.result) throw new AppError("INVALID_TRANSITION", "This check has already finished.");
    await db().update(checkRuns).set({ cancelRequestedAt: new Date() }).where(eq(checkRuns.id, run.id));
    await appendRunEvent(run.id, { type: "run.canceled", stage: "canceling", summary: "Cancellation requested before submission." });
    return { ok: true };
  });

  app.get("/runs/:runId/artifacts", { schema: { params: runParams } }, async (request) => {
    const context = await requireOrg(request);
    const run = await loadRun(context.organizationId, request.params.runId);
    const artifacts = await db().select().from(runArtifacts).where(and(eq(runArtifacts.runId, run.id), isNull(runArtifacts.deletedAt)));
    return {
      artifacts: artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, mime: artifact.mime, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256, downloadUrl: `/api/v1/artifacts/${artifact.id}/download?token=${signDownload(artifact.id, context.user.id)}` })),
    };
  });

  app.get("/artifacts/:id/download", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } }, schema: { params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().optional() }) } }, async (request, reply) => {
    const context = await requireOrg(request);
    const [artifact] = await db().select().from(runArtifacts).where(and(eq(runArtifacts.id, request.params.id), eq(runArtifacts.organizationId, context.organizationId), isNull(runArtifacts.deletedAt)));
    if (!artifact) throw new AppError("NOT_FOUND", "That file does not exist.");
    if (request.query.token && !verifyDownload(artifact.id, context.user.id, request.query.token)) {
      throw new AppError("FORBIDDEN", "That download link has expired.");
    }
    reply.header("content-type", artifact.mime);
    reply.header("cache-control", "private, max-age=300");
    reply.header("content-disposition", artifact.mime === "image/png" ? "inline" : `attachment; filename="${artifact.kind}.txt"`);
    return reply.send(await getObject(artifact.objectKey));
  });

  app.get("/runs/:runId/evidence.zip", { schema: { params: runParams } }, async (request, reply) => {
    const context = await requireOrg(request);
    const run = await loadRun(context.organizationId, request.params.runId);
    const detail = await runDetail(run, { revealToken: false, includePolicy: can(context.role as Role, "policy:view") });
    const artifacts = await db().select().from(runArtifacts).where(and(eq(runArtifacts.runId, run.id), isNull(runArtifacts.deletedAt)));
    const files = await Promise.all(artifacts.map(async (artifact) => ({ name: artifact.objectKey.split("/").pop() ?? artifact.id, data: new Uint8Array(await getObject(artifact.objectKey)), kind: artifact.kind })));
    files.push({ name: "run.json", data: new TextEncoder().encode(JSON.stringify(detail, null, 2)), kind: "run-record" });
    const zip = buildEvidenceZip(files, { runId: run.id, result: run.result, state: run.state, completedAt: run.completedAt });
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename="inlet-evidence-${run.id}.zip"`);
    return reply.send(Buffer.from(zip));
  });
};
