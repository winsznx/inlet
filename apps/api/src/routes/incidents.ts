import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { fixturesEnabled, inferenceConfigured, isProduction } from "@inlet/config";
import { audit, enqueue, investigationChannel, startSiteCheck, transitionIncident, SanitizedWorktree } from "@inlet/control";
import { approvals, and, asc, checkRuns, db, deployments, desc, destinations, eq, gitPullRequests, gt, incidentTransitions, incidents, investigationEvents, investigations, isNull, modelCalls, patchChecks, patchComments, patches, sites, sourceConnections, toolCalls, users } from "@inlet/database";
import { AppError, canStartInvestigation, INCIDENT_STATE_LABELS, newId, RUN_RESULT_LABELS } from "@inlet/domain";
import type { InvestigationEventType, InvestigationEventView } from "@inlet/domain";
import { assertGithubConfigured, createPullRequest, installationToken } from "@inlet/integrations";
import { requireOrg } from "../plumbing/auth";
import type { OrgContext } from "../plumbing/auth";
import { streamEvents } from "../plumbing/sse";

const idParams = z.object({ id: z.uuid() });

async function loadIncident(context: OrgContext, id: string): Promise<typeof incidents.$inferSelect> {
  const [incident] = await db().select().from(incidents).where(and(eq(incidents.id, id), eq(incidents.organizationId, context.organizationId)));
  if (!incident) throw new AppError("NOT_FOUND", "That incident does not exist.");
  return incident;
}

async function loadPatch(context: OrgContext, id: string): Promise<typeof patches.$inferSelect> {
  const [patch] = await db().select().from(patches).where(and(eq(patches.id, id), eq(patches.organizationId, context.organizationId)));
  if (!patch) throw new AppError("NOT_FOUND", "That patch does not exist.");
  return patch;
}

function investigationEventView(row: typeof investigationEvents.$inferSelect): InvestigationEventView {
  return {
    eventId: row.id,
    investigationId: row.investigationId,
    sequence: row.sequence,
    timestamp: row.timestamp.toISOString(),
    type: row.eventType as InvestigationEventType,
    summary: row.summary,
    attempt: row.attempt,
    safeMetadata: row.payload ?? undefined,
  };
}

async function checksFor(patchId: string) {
  const rows = await db().select().from(patchChecks).where(eq(patchChecks.patchId, patchId)).orderBy(asc(patchChecks.startedAt));
  return rows.map((row) => ({ id: row.id, name: row.name, variant: row.variant, commandProfile: row.commandProfile, pass: row.pass, exitCode: row.exitCode, detail: row.detail, startedAt: row.startedAt, endedAt: row.endedAt, logArtifactId: row.logArtifactId }));
}

function patchSummary(patch: typeof patches.$inferSelect) {
  return {
    id: patch.id,
    attempt: patch.attempt,
    origin: patch.origin,
    status: patch.status,
    baseCommitSha: patch.baseCommitSha,
    changedFiles: patch.changedFiles,
    changedFileCount: patch.changedFileCount,
    changedLineCount: patch.changedLineCount,
    riskLevel: patch.riskLevel,
    riskNotes: patch.riskNotes,
    rationale: patch.rationale,
    guardFailures: patch.guardFailures,
    sha256: patch.sha256,
    previewEvidence: patch.previewRunEvidence,
    createdAt: patch.createdAt,
  };
}

function runBrief(run: typeof checkRuns.$inferSelect | undefined) {
  if (!run) return null;
  return { id: run.id, state: run.state, result: run.result, resultLabel: run.result ? RUN_RESULT_LABELS[run.result] : null, summary: run.resultSummary, startedAt: run.startedAt, completedAt: run.completedAt, tokenSuffix: run.tokenSuffix };
}

function buildPatchFile(patch: typeof patches.$inferSelect): string {
  return `# Inlet patch ${patch.id}\n# Base commit: ${patch.baseCommitSha}\n# SHA-256: ${patch.sha256}\n# Check before applying: git apply --check inlet-${patch.id}.patch\n${patch.diffText}`;
}

export const incidentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/incidents", { schema: { querystring: z.object({ state: z.string().max(40).optional(), siteId: z.uuid().optional() }) } }, async (request) => {
    const context = await requireOrg(request);
    const { state, siteId } = request.query;
    const rows = await db()
      .select({ incident: incidents, siteName: sites.name })
      .from(incidents)
      .innerJoin(sites, eq(incidents.siteId, sites.id))
      .where(and(eq(incidents.organizationId, context.organizationId), state ? eq(incidents.state, state as typeof incidents.$inferSelect.state) : undefined, siteId ? eq(incidents.siteId, siteId) : undefined))
      .orderBy(desc(incidents.updatedAt))
      .limit(200);
    return { incidents: rows.map(({ incident, siteName }) => ({ id: incident.id, title: incident.title, siteId: incident.siteId, siteName, state: incident.state, stateLabel: INCIDENT_STATE_LABELS[incident.state], severity: incident.severity, createdAt: incident.createdAt, updatedAt: incident.updatedAt })) };
  });

  app.get("/incidents/:id", { schema: { params: idParams } }, async (request) => {
    const context = await requireOrg(request);
    const incident = await loadIncident(context, request.params.id);
    const [site] = await db().select().from(sites).where(eq(sites.id, incident.siteId));
    const [openedBy] = await db().select().from(checkRuns).where(eq(checkRuns.id, incident.openedByRunId));
    const [recovery] = incident.recoveryRunId ? await db().select().from(checkRuns).where(eq(checkRuns.id, incident.recoveryRunId)) : [];
    const [destination] = await db().select().from(destinations).where(and(eq(destinations.siteId, incident.siteId), isNull(destinations.deletedAt))).limit(1);
    const [connection] = await db().select().from(sourceConnections).where(and(eq(sourceConnections.siteId, incident.siteId), isNull(sourceConnections.deletedAt))).limit(1);
    const relatedRuns = await db().select().from(checkRuns).where(eq(checkRuns.incidentId, incident.id)).orderBy(desc(checkRuns.createdAt)).limit(20);
    const investigationRows = await db().select().from(investigations).where(eq(investigations.incidentId, incident.id)).orderBy(desc(investigations.createdAt));
    const patchRows = await db().select().from(patches).where(eq(patches.incidentId, incident.id)).orderBy(desc(patches.createdAt));
    const transitions = await db().select().from(incidentTransitions).where(eq(incidentTransitions.incidentId, incident.id)).orderBy(asc(incidentTransitions.createdAt));
    const deploymentRows = await db().select().from(deployments).where(eq(deployments.incidentId, incident.id)).orderBy(desc(deployments.createdAt));
    const current = patchRows.find((patch) => patch.id === incident.currentPatchId);
    return {
      id: incident.id,
      title: incident.title,
      state: incident.state,
      stateLabel: INCIDENT_STATE_LABELS[incident.state],
      version: incident.version,
      siteId: incident.siteId,
      siteName: site?.name,
      isControlledFixture: Boolean(site?.fixtureSlot),
      fixtureRepairable: site?.fixtureSlot === "broken",
      destinationName: destination?.displayName ?? null,
      causeCategory: incident.causeCategory,
      humanDiagnosis: incident.humanDiagnosis,
      closeReason: incident.closeReason,
      publicTrace: incident.publicTrace,
      repositoryConnected: Boolean(connection),
      inferenceConfigured: inferenceConfigured(),
      harnessAvailable: !isProduction() && Boolean(connection?.isControlledFixture),
      openedByRun: runBrief(openedBy),
      recoveryRun: runBrief(recovery),
      relatedRuns: relatedRuns.map(runBrief),
      investigations: investigationRows.map((row) => ({ id: row.id, origin: row.origin, modelId: row.modelId, state: row.state, attempts: row.attempts, maxAttempts: row.maxAttempts, hypothesis: row.hypothesis, nonCodeCause: row.nonCodeCause, errorCode: row.errorCode, startedAt: row.startedAt, completedAt: row.completedAt, promptTokens: row.promptTokens, completionTokens: row.completionTokens, costEstimateUsd: row.costEstimateUsd })),
      patches: patchRows.map(patchSummary),
      currentPatch: current ? { ...patchSummary(current), checks: await checksFor(current.id) } : null,
      transitions: transitions.map((row) => ({ from: row.fromState, to: row.toState, actor: row.actor, reason: row.reason, at: row.createdAt })),
      deployments: deploymentRows.map((row) => ({ id: row.id, trigger: row.trigger, environment: row.environment, deploymentRef: row.deploymentRef, deployedAt: row.deployedAt, webhookVerified: row.webhookVerified })),
      createdAt: incident.createdAt,
      updatedAt: incident.updatedAt,
    };
  });

  app.post(
    "/incidents/:id/investigations",
    { config: { rateLimit: { max: 6, timeWindow: "1 minute" } }, schema: { params: idParams, body: z.object({ mode: z.enum(["agent", "non_ai_harness"]).default("agent") }) } },
    async (request, reply) => {
      const context = await requireOrg(request, "investigation:start");
      const incident = await loadIncident(context, request.params.id);
      const [connection] = await db().select().from(sourceConnections).where(and(eq(sourceConnections.siteId, incident.siteId), isNull(sourceConnections.deletedAt))).limit(1);
      if (!connection) throw new AppError("REPOSITORY_REQUIRED", "Connect the source repository to investigate code.", { nextAction: "Add a repository in this website's settings." });
      const harness = request.body.mode === "non_ai_harness";
      if (harness && (isProduction() || !connection.isControlledFixture)) {
        throw new AppError("FORBIDDEN", "The non-AI test harness only runs against the controlled sample in development.");
      }
      if (!harness && !inferenceConfigured()) {
        throw new AppError("INFERENCE_NOT_CONFIGURED", "Connect inference to investigate code.", { nextAction: "Set VULTR_INFERENCE_API_KEY on the server." });
      }
      if (!canStartInvestigation(incident.state)) throw new AppError("INVALID_TRANSITION", "An investigation can't start from this state.");
      const id = newId();
      await db().transaction(async (tx) => {
        await transitionIncident(incident.id, "investigating", { actor: `user:${context.user.id}`, actorUserId: context.user.id, expectedVersion: incident.version, patch: { currentPatchId: null } }, tx);
        await tx.insert(investigations).values({ id, organizationId: context.organizationId, incidentId: incident.id, origin: harness ? "non_ai_harness" : "vultr_inference", promptVersion: "pending", actorUserId: context.user.id });
        await enqueue("investigation", id, { investigationId: id }, tx);
      });
      return reply.status(202).send({ investigationId: id });
    },
  );

  app.get("/investigations/:id", { schema: { params: idParams } }, async (request) => {
    const context = await requireOrg(request);
    const [row] = await db().select().from(investigations).where(and(eq(investigations.id, request.params.id), eq(investigations.organizationId, context.organizationId)));
    if (!row) throw new AppError("NOT_FOUND", "That investigation does not exist.");
    const events = await db().select().from(investigationEvents).where(eq(investigationEvents.investigationId, row.id)).orderBy(asc(investigationEvents.sequence));
    const calls = await db().select().from(modelCalls).where(eq(modelCalls.investigationId, row.id)).orderBy(asc(modelCalls.startedAt));
    const tools = await db().select().from(toolCalls).where(eq(toolCalls.investigationId, row.id)).orderBy(asc(toolCalls.createdAt));
    return {
      id: row.id,
      incidentId: row.incidentId,
      origin: row.origin,
      modelId: row.modelId,
      state: row.state,
      attempts: row.attempts,
      hypothesis: row.hypothesis,
      errorCode: row.errorCode,
      baseCommitSha: row.baseCommitSha,
      events: events.map(investigationEventView),
      modelCalls: calls.map((call) => ({ id: call.id, provider: call.provider, modelId: call.modelId, requestId: call.requestId, responseId: call.responseId, startedAt: call.startedAt, durationMs: call.durationMs, promptTokens: call.promptTokens, completionTokens: call.completionTokens, finishReason: call.finishReason, tools: call.toolNames, httpStatus: call.httpStatus, errorCode: call.errorCode })),
      toolCalls: tools.map((tool) => ({ id: tool.id, attempt: tool.attempt, tool: tool.toolName, allowed: tool.allowed, reasonCode: tool.reasonCode, durationMs: tool.durationMs, resultSha256: tool.resultSha256, args: tool.redactedArgs, at: tool.createdAt })),
    };
  });

  app.get("/investigations/:id/events", { schema: { params: idParams } }, async (request, reply) => {
    const context = await requireOrg(request);
    const [row] = await db().select().from(investigations).where(and(eq(investigations.id, request.params.id), eq(investigations.organizationId, context.organizationId)));
    if (!row) throw new AppError("NOT_FOUND", "That investigation does not exist.");
    await streamEvents(request, reply, {
      channel: investigationChannel(row.id),
      load: async (after) => (await db().select().from(investigationEvents).where(and(eq(investigationEvents.investigationId, row.id), gt(investigationEvents.sequence, after))).orderBy(asc(investigationEvents.sequence)).limit(200)).map(investigationEventView),
      isFinished: async () => {
        const [current] = await db().select({ state: investigations.state }).from(investigations).where(eq(investigations.id, row.id));
        return !["queued", "running"].includes(current?.state ?? "");
      },
    });
  });

  app.get("/incidents/:id/patches", { schema: { params: idParams } }, async (request) => {
    const context = await requireOrg(request);
    const incident = await loadIncident(context, request.params.id);
    const rows = await db().select().from(patches).where(eq(patches.incidentId, incident.id)).orderBy(desc(patches.createdAt));
    return { patches: rows.map(patchSummary) };
  });

  app.get("/patches/:id", { schema: { params: idParams } }, async (request) => {
    const context = await requireOrg(request);
    const patch = await loadPatch(context, request.params.id);
    const [incident] = await db().select().from(incidents).where(eq(incidents.id, patch.incidentId));
    const approvalRows = await db().select({ approval: approvals, actorName: users.name }).from(approvals).innerJoin(users, eq(approvals.actorUserId, users.id)).where(eq(approvals.patchId, patch.id)).orderBy(desc(approvals.createdAt));
    const comments = await db().select({ comment: patchComments, authorName: users.name }).from(patchComments).leftJoin(users, eq(patchComments.authorUserId, users.id)).where(eq(patchComments.patchId, patch.id)).orderBy(asc(patchComments.createdAt));
    const pulls = await db().select().from(gitPullRequests).where(eq(gitPullRequests.patchId, patch.id));
    const [connection] = incident ? await db().select().from(sourceConnections).where(and(eq(sourceConnections.siteId, incident.siteId), isNull(sourceConnections.deletedAt))).limit(1) : [];
    return {
      ...patchSummary(patch),
      diff: patch.diffText,
      incidentId: patch.incidentId,
      incidentState: incident?.state,
      checks: await checksFor(patch.id),
      approvals: approvalRows.map(({ approval, actorName }) => ({ id: approval.id, decision: approval.decision, reason: approval.decisionReason, actorName, at: approval.createdAt })),
      comments: comments.map(({ comment, authorName }) => ({ id: comment.id, body: comment.body, authorName, at: comment.createdAt })),
      pullRequests: pulls.map((pull) => ({ url: pull.prUrl, number: pull.prNumber, branch: pull.branch, state: pull.currentState })),
      canCreatePullRequest: connection?.provider === "github",
      decisionAllowed: incident?.state === "awaiting_approval" && patch.status === "ready" && patch.id === incident.currentPatchId,
    };
  });

  app.get("/patches/:id/diff", { schema: { params: idParams } }, async (request, reply) => {
    const context = await requireOrg(request);
    const patch = await loadPatch(context, request.params.id);
    reply.header("content-type", "text/plain; charset=utf-8");
    return reply.send(patch.diffText);
  });

  app.post("/patches/:id/download", { schema: { params: idParams } }, async (request, reply) => {
    const context = await requireOrg(request);
    const patch = await loadPatch(context, request.params.id);
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "patch", entityId: patch.id, action: "patch.downloaded" });
    reply.header("content-type", "text/x-patch; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="inlet-${patch.id}.patch"`);
    return reply.send(buildPatchFile(patch));
  });

  app.post("/patches/:id/comments", { schema: { params: idParams, body: z.object({ body: z.string().trim().min(1).max(2000) }) } }, async (request, reply) => {
    const context = await requireOrg(request, "site:edit");
    const patch = await loadPatch(context, request.params.id);
    const id = newId();
    await db().insert(patchComments).values({ id, patchId: patch.id, authorUserId: context.user.id, body: request.body.body });
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "patch", entityId: patch.id, action: "patch.commented" });
    return reply.status(201).send({ id });
  });

  const decisionBody = z.object({ reason: z.string().trim().min(3).max(1000), riskAcknowledged: z.boolean().optional() });

  async function decide(context: OrgContext, patchId: string, decision: "approved" | "rejected", reason: string, riskAcknowledged: boolean): Promise<void> {
    const patch = await loadPatch(context, patchId);
    const incident = await loadIncident(context, patch.incidentId);
    if (patch.status !== "ready" || incident.currentPatchId !== patch.id || incident.state !== "awaiting_approval") {
      throw new AppError("INVALID_TRANSITION", "This patch isn't awaiting a decision.");
    }
    if (decision === "approved" && !riskAcknowledged) throw new AppError("INVALID_INPUT", "Confirm you have reviewed the change and its risks.");
    await db().transaction(async (tx) => {
      await tx.insert(approvals).values({ id: newId(), patchId: patch.id, actorUserId: context.user.id, decision, decisionReason: reason, riskAcknowledgedAt: riskAcknowledged ? new Date() : null });
      await tx.update(patches).set({ status: decision === "approved" ? "approved" : "rejected" }).where(eq(patches.id, patch.id));
      await transitionIncident(incident.id, decision, { actor: `user:${context.user.id}`, actorUserId: context.user.id, reason, expectedVersion: incident.version }, tx);
      if (decision === "approved") {
        await transitionIncident(incident.id, "awaiting_deployment", { actor: "system", reason: "Patch approved. Waiting for a human deployment." }, tx);
      }
      await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "patch", entityId: patch.id, action: `patch.${decision}` }, tx);
    });
  }

  app.post("/patches/:id/approve", { schema: { params: idParams, body: decisionBody } }, async (request) => {
    await decide(await requireOrg(request, "patch:decide"), request.params.id, "approved", request.body.reason, request.body.riskAcknowledged === true);
    return { ok: true };
  });

  app.post("/patches/:id/reject", { schema: { params: idParams, body: decisionBody } }, async (request) => {
    await decide(await requireOrg(request, "patch:decide"), request.params.id, "rejected", request.body.reason, false);
    return { ok: true };
  });

  app.post("/patches/:id/pull-request", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } }, schema: { params: idParams } }, async (request, reply) => {
    const context = await requireOrg(request, "secret:manage");
    const patch = await loadPatch(context, request.params.id);
    if (patch.status !== "approved") throw new AppError("INVALID_TRANSITION", "Approve this patch before opening a pull request.");
    const incident = await loadIncident(context, patch.incidentId);
    const [connection] = await db().select().from(sourceConnections).where(and(eq(sourceConnections.siteId, incident.siteId), isNull(sourceConnections.deletedAt))).limit(1);
    if (connection?.provider !== "github" || !connection.installationId) throw new AppError("REPOSITORY_REQUIRED", "This website isn't connected to GitHub.", { nextAction: "Download the patch instead." });
    assertGithubConfigured();
    const worktree = await SanitizedWorktree.create(connection);
    let files: { path: string; content: string | null }[];
    try {
      const failure = await worktree.applyUnifiedDiff(patch.diffText);
      if (failure) throw new AppError("BASE_MOVED", "This patch no longer applies to the stored source.");
      files = await Promise.all(patch.changedFiles.map(async (path) => ({ path, content: await worktree.read(path) })));
    } finally {
      await worktree.dispose();
    }
    const token = await installationToken(connection.installationId);
    const branch = `inlet/fix-${incident.id.slice(0, 13)}`;
    const checks = await checksFor(patch.id);
    const pull = await createPullRequest({
      token,
      repo: connection.repoSlug,
      baseBranch: connection.baseBranch,
      baseSha: connection.baseCommitSha ?? patch.baseCommitSha,
      branch,
      title: "Fix enquiry notification delivery",
      files,
      body: [`Proposed by Inlet for incident ${incident.id}.`, "", patch.rationale ?? "", "", "Checks:", ...checks.filter((check) => check.variant === "patched").map((check) => `- ${check.name}: ${check.pass ? "passed" : "failed"}`), "", "Review before merging. Inlet never merges or deploys."].join("\n"),
    });
    await db().insert(gitPullRequests).values({ id: newId(), patchId: patch.id, provider: "github", repoRef: connection.repoSlug, branch, prNumber: pull.number, prUrl: pull.url, currentState: pull.state, createdBy: context.user.id });
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "patch", entityId: patch.id, action: "patch.pull_request_created", safeMetadata: { url: pull.url } });
    return reply.status(201).send({ url: pull.url, number: pull.number });
  });

  app.post("/incidents/:id/fixture/apply", { schema: { params: idParams, body: z.object({ confirm: z.literal(true) }) } }, async (request, reply) => {
    const context = await requireOrg(request, "patch:decide");
    const incident = await loadIncident(context, request.params.id);
    const [site] = await db().select().from(sites).where(eq(sites.id, incident.siteId));
    if (!fixturesEnabled() || site?.fixtureSlot !== "broken") throw new AppError("FORBIDDEN", "Only the controlled sample site can be changed from here.");
    if (incident.state !== "awaiting_deployment" || !incident.currentPatchId) throw new AppError("INVALID_TRANSITION", "Approve the patch first.");
    await enqueue("fixture-deploy", incident.id, { incidentId: incident.id, patchId: incident.currentPatchId, actorUserId: context.user.id });
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "incident", entityId: incident.id, action: "fixture.deploy_requested" });
    return reply.status(202).send({ ok: true });
  });

  app.post("/incidents/:id/deployment/confirm", { schema: { params: idParams, body: z.object({ deploymentRef: z.string().max(200).optional() }) } }, async (request, reply) => {
    const context = await requireOrg(request, "run:start");
    const incident = await loadIncident(context, request.params.id);
    if (incident.state !== "awaiting_deployment" || !incident.currentPatchId) throw new AppError("INVALID_TRANSITION", "There is no approved change waiting for deployment.");
    await db().insert(deployments).values({ id: newId(), incidentId: incident.id, patchId: incident.currentPatchId, environment: "production", trigger: "manual", deploymentRef: request.body.deploymentRef, deployedAt: new Date(), attestedByUserId: context.user.id });
    const runId = await startRecheck(context, incident);
    return reply.status(202).send({ runId });
  });

  async function startRecheck(context: OrgContext, incident: typeof incidents.$inferSelect): Promise<string> {
    if (!["awaiting_deployment", "still_failing"].includes(incident.state)) throw new AppError("INVALID_TRANSITION", "This incident isn't waiting for a recheck.");
    await transitionIncident(incident.id, "rechecking", { actor: `user:${context.user.id}`, actorUserId: context.user.id, expectedVersion: incident.version });
    const { runId } = await startSiteCheck({ organizationId: context.organizationId, siteId: incident.siteId, trigger: "recheck", reason: "post-deployment recheck", actorUserId: context.user.id, incidentId: incident.id, idempotencyKey: `recheck-${incident.id}-${incident.version}` });
    return runId;
  }

  app.post("/incidents/:id/recheck", { schema: { params: idParams, body: z.object({}).default({}) } }, async (request, reply) => {
    const context = await requireOrg(request, "run:start");
    const incident = await loadIncident(context, request.params.id);
    const deployed = incident.currentPatchId ? await db().select({ id: deployments.id }).from(deployments).where(and(eq(deployments.incidentId, incident.id), eq(deployments.patchId, incident.currentPatchId))).limit(1) : [];
    if (deployed.length === 0) throw new AppError("INVALID_TRANSITION", "Confirm the deployment before rechecking.");
    return reply.status(202).send({ runId: await startRecheck(context, incident) });
  });

  app.post("/incidents/:id/close", { schema: { params: idParams, body: z.object({ reason: z.string().trim().min(3).max(1000) }) } }, async (request) => {
    const context = await requireOrg(request, "site:edit");
    const incident = await loadIncident(context, request.params.id);
    await transitionIncident(incident.id, "closed", { actor: `user:${context.user.id}`, actorUserId: context.user.id, reason: request.body.reason, patch: { closedAt: new Date(), closeReason: request.body.reason } });
    return { ok: true };
  });

  app.post("/incidents/:id/reopen", { schema: { params: idParams, body: z.object({ reason: z.string().trim().min(3).max(1000) }) } }, async (request) => {
    const context = await requireOrg(request, "site:edit");
    const incident = await loadIncident(context, request.params.id);
    await transitionIncident(incident.id, "open", { actor: `user:${context.user.id}`, actorUserId: context.user.id, reason: request.body.reason, patch: { closedAt: null, closeReason: null } });
    return { ok: true };
  });

  app.post("/incidents/:id/publish-trace", { schema: { params: idParams, body: z.object({ published: z.boolean() }) } }, async (request) => {
    const context = await requireOrg(request, "member:manage");
    const incident = await loadIncident(context, request.params.id);
    const [site] = await db().select().from(sites).where(eq(sites.id, incident.siteId));
    if (!site?.fixtureSlot || incident.state !== "verified_recovered") throw new AppError("FORBIDDEN", "Only a verified recovery on a controlled sample site can be shown publicly.");
    await db().update(incidents).set({ publicTrace: request.body.published }).where(eq(incidents.id, incident.id));
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "incident", entityId: incident.id, action: request.body.published ? "incident.trace_published" : "incident.trace_unpublished" });
    return { ok: true };
  });
};

