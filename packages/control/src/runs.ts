import { and, checkRuns, db, destinations, eq, formConfigs, gte, inArray, runEvents, sites, sql, desc, count } from "@inlet/database";
import type { DbExecutor, Transaction } from "@inlet/database";
import { AppError, canTransitionRun, newCorrelationToken, newId } from "@inlet/domain";
import type { RunEventType, RunKind, RunResult, RunState, RunTrigger } from "@inlet/domain";
import { env } from "@inlet/config";
import { encryptSecret, sha256 } from "@inlet/evidence";
import { enqueue } from "./outbox";
import { publish, runChannel } from "./realtime";

export const ACTIVE_RUN_STATES: RunState[] = [
  "queued",
  "provisioning",
  "opening_form",
  "mapping_fields",
  "submitting",
  "observing_destination",
  "complete",
];

export async function appendRunEvent(
  runId: string,
  event: {
    type: RunEventType;
    stage: string;
    summary: string;
    payload?: Record<string, string | number | boolean>;
    artifactIds?: string[];
    timestamp?: Date;
  },
  executor: DbExecutor = db(),
): Promise<number> {
  const [row] = await executor
    .update(checkRuns)
    .set({ stageVersion: sql`${checkRuns.stageVersion} + 1` })
    .where(eq(checkRuns.id, runId))
    .returning({ sequence: checkRuns.stageVersion });
  if (!row) throw new Error(`Run ${runId} does not exist`);
  await executor.insert(runEvents).values({
    id: newId(),
    runId,
    sequence: row.sequence,
    eventType: event.type,
    stage: event.stage,
    safePublicSummary: event.summary,
    redactedPayload: event.payload,
    artifactIds: event.artifactIds,
    timestamp: event.timestamp ?? new Date(),
  });
  publish(runChannel(runId), row.sequence);
  return row.sequence;
}

export async function transitionRun(
  runId: string,
  from: RunState | RunState[],
  to: RunState,
  patch: Partial<typeof checkRuns.$inferInsert> = {},
  executor: DbExecutor = db(),
): Promise<boolean> {
  const sources = Array.isArray(from) ? from : [from];
  const allowed = sources.filter((state) => state === to || canTransitionRun(state, to));
  if (allowed.length === 0) return false;
  const updated = await executor
    .update(checkRuns)
    .set({ ...patch, state: to })
    .where(and(eq(checkRuns.id, runId), inArray(checkRuns.state, allowed)))
    .returning({ id: checkRuns.id });
  return updated.length === 1;
}

export type CreateRunInput = {
  organizationId: string;
  siteId: string | null;
  kind?: RunKind;
  scenario?: string;
  trigger: RunTrigger;
  reason?: string;
  idempotencyKey?: string;
  actorUserId?: string | null;
  incidentId?: string;
  demoSessionId?: string;
  destinationId?: string | null;
  formConfigId?: string | null;
};

export async function insertRun(tx: Transaction, input: CreateRunInput): Promise<string> {
  const id = newId();
  const token = newCorrelationToken();
  await tx.insert(checkRuns).values({
    id,
    organizationId: input.organizationId,
    siteId: input.siteId,
    kind: input.kind ?? "delivery",
    scenario: input.scenario,
    trigger: input.trigger,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    actorUserId: input.actorUserId,
    incidentId: input.incidentId,
    demoSessionId: input.demoSessionId,
    destinationId: input.destinationId,
    formConfigId: input.formConfigId,
    testTokenHash: sha256(token),
    testTokenEncrypted: encryptSecret(token),
    tokenSuffix: token.slice(-4),
    observationWindowSeconds: env().OBSERVATION_WINDOW_SECONDS,
    leaseExpiresAt: new Date(Date.now() + 300_000),
  });
  await appendRunEvent(id, { type: "run.queued", stage: "queued", summary: "Check queued." }, tx);
  await enqueue("site-check", id, { runId: id }, tx);
  return id;
}

const MIN_SITE_INTERVAL_EXEMPT_TRIGGERS: RunTrigger[] = ["recheck"];

export type StartCheckInput = {
  organizationId: string;
  siteId: string;
  trigger: RunTrigger;
  reason?: string;
  idempotencyKey?: string;
  actorUserId?: string | null;
  incidentId?: string;
};

export async function startSiteCheck(input: StartCheckInput): Promise<{ runId: string; existing: boolean }> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`site-check:${input.siteId}`}))`);

    if (input.idempotencyKey) {
      const [prior] = await tx
        .select({ id: checkRuns.id })
        .from(checkRuns)
        .where(and(eq(checkRuns.siteId, input.siteId), eq(checkRuns.idempotencyKey, input.idempotencyKey)));
      if (prior) return { runId: prior.id, existing: true };
    }

    const [site] = await tx
      .select()
      .from(sites)
      .where(and(eq(sites.id, input.siteId), eq(sites.organizationId, input.organizationId)));
    if (!site || site.archivedAt) throw new AppError("NOT_FOUND", "That website no longer exists.");
    if (site.verificationStatus !== "verified") {
      throw new AppError("OWNERSHIP_NOT_VERIFIED", "Confirm you control this website before Inlet tests it.", {
        nextAction: "Finish ownership verification.",
      });
    }

    const [active] = await tx
      .select({ id: checkRuns.id })
      .from(checkRuns)
      .where(and(eq(checkRuns.siteId, input.siteId), inArray(checkRuns.state, ACTIVE_RUN_STATES)))
      .limit(1);
    if (active) return { runId: active.id, existing: true };

    const [destination] = await tx
      .select()
      .from(destinations)
      .where(and(eq(destinations.siteId, input.siteId), sql`${destinations.deletedAt} is null`))
      .orderBy(desc(destinations.createdAt))
      .limit(1);
    if (!destination) {
      throw new AppError("DESTINATION_REQUIRED", "Connect a delivery destination first.", {
        nextAction: "Add a destination so Inlet has somewhere to check.",
      });
    }

    const [config] = await tx
      .select()
      .from(formConfigs)
      .where(eq(formConfigs.siteId, input.siteId))
      .orderBy(desc(formConfigs.version))
      .limit(1);
    if (!config) {
      throw new AppError("UNSUPPORTED_FORM", "Map the form fields before running a check.", {
        nextAction: "Complete the form mapping for this website.",
      });
    }

    if (!site.fixtureSlot && !MIN_SITE_INTERVAL_EXEMPT_TRIGGERS.includes(input.trigger)) {
      const windowStart = new Date(Date.now() - config.maxSubmissionFrequencyMinutes * 60_000);
      const [recent] = await tx
        .select({ value: count() })
        .from(checkRuns)
        .where(and(eq(checkRuns.siteId, input.siteId), gte(checkRuns.createdAt, windowStart)));
      if ((recent?.value ?? 0) > 0) {
        throw new AppError("RATE_LIMITED", `This form can be tested once every ${config.maxSubmissionFrequencyMinutes} minutes.`, {
          nextAction: "Wait for the pacing window to pass, or review the last check.",
        });
      }
    }

    const runId = await insertRun(tx, {
      organizationId: input.organizationId,
      siteId: input.siteId,
      trigger: input.trigger,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      actorUserId: input.actorUserId,
      incidentId: input.incidentId,
      destinationId: destination.id,
      formConfigId: config.id,
    });
    await tx.update(sites).set({ lastRunId: runId, updatedAt: new Date() }).where(eq(sites.id, input.siteId));
    return { runId, existing: false };
  });
}

export type RunCompletion = { result: RunResult; summary: string };
