import { env } from "@inlet/config";
import {
  ACTIVE_RUN_STATES,
  appendRunEvent,
  audit,
  enqueue,
  planNotification,
  startSiteCheck,
  transitionIncident,
} from "@inlet/control";
import type { NotificationKind } from "@inlet/control";
import { and, authTokens, checkRuns, count, db, demoSessions, deployments, eq, formDiscoveries, gte, incidents, inArray, investigations, isNull, lt, notifications, organizations, patches, runArtifacts, sandboxSessions, schedules, sessions, sites } from "@inlet/database";
import { newId } from "@inlet/domain";
import { deleteObject } from "@inlet/evidence";
import { deployFixturePatch, sendProductEmail } from "@inlet/integrations";
import type { BrowserOutcome, FieldMap } from "@inlet/domain";
import { intervalForMode, nextRunFrom } from "@inlet/control";
import type { ScheduleMode } from "@inlet/control";
import { sweepOrphanPreviews } from "@inlet/sandbox";
import { runBrowserSandbox } from "../browser-session";
import { log, sandboxProvider } from "../context";
import { destroySandboxByName } from "../sandbox-records";
import { targetForSite } from "../targets";
import { finishRun } from "./site-check";

export async function processNotification(payload: {
  kind: NotificationKind;
  incidentId?: string;
  siteId?: string;
  organizationId?: string;
  runId?: string;
}): Promise<void> {
  let organizationId = payload.organizationId;
  if (!organizationId && payload.incidentId) {
    const [incident] = await db().select({ org: incidents.organizationId }).from(incidents).where(eq(incidents.id, payload.incidentId));
    organizationId = incident?.org;
  }
  if (!organizationId) return;
  const planned = await planNotification({
    kind: payload.kind,
    organizationId,
    siteId: payload.siteId,
    incidentId: payload.incidentId,
    runId: payload.runId,
    appUrl: env().NEXT_PUBLIC_APP_URL,
  });
  if (!planned) return;
  try {
    await sendProductEmail({ to: planned.recipient, subject: planned.subject, text: planned.text });
    await db().update(notifications).set({ deliveryStatus: "sent", sentAt: new Date() }).where(eq(notifications.id, planned.id));
  } catch {
    await db().update(notifications).set({ deliveryStatus: "failed", errorCode: "smtp_failed" }).where(eq(notifications.id, planned.id));
  }
}

export async function processFixtureDeploy(payload: { incidentId: string; patchId: string; actorUserId: string }): Promise<void> {
  const [patch] = await db().select().from(patches).where(eq(patches.id, payload.patchId));
  const [incident] = await db().select().from(incidents).where(eq(incidents.id, payload.incidentId));
  if (!patch || !incident || incident.state !== "awaiting_deployment") return;
  const result = await deployFixturePatch(patch.diffText, patch.baseCommitSha);
  if (!result.ok) {
    await audit({ organizationId: incident.organizationId, actorUserId: payload.actorUserId, entityType: "deployment", entityId: patch.id, action: "fixture.deploy_failed", safeMetadata: { code: result.code } });
    return;
  }
  await db().insert(deployments).values({
    id: newId(),
    incidentId: incident.id,
    patchId: patch.id,
    environment: "controlled-test-site",
    trigger: "fixture_apply",
    deploymentRef: result.deployedSha,
    deployedAt: new Date(),
    attestedByUserId: payload.actorUserId,
  });
  await audit({ organizationId: incident.organizationId, actorUserId: payload.actorUserId, entityType: "deployment", entityId: patch.id, action: "fixture.deployed", safeMetadata: { deployedSha: result.deployedSha } });
}

function proposeMapping(discovered: {
  controls: { selector: string; type: string; name: string; label: string; required: boolean }[];
  submitCandidates: { selector: string; text: string }[];
}): { mapping: Partial<FieldMap>; missing: string[] } {
  const find = (pattern: RegExp, exclude?: RegExp) =>
    discovered.controls.find((control) => {
      const haystack = `${control.name} ${control.label} ${control.selector}`;
      return pattern.test(haystack) && !(exclude?.test(haystack) ?? false);
    })?.selector;
  const mapping: Partial<FieldMap> = {
    name: find(/\bname\b/i, /company|user/i),
    email: discovered.controls.find((control) => control.type === "email")?.selector ?? find(/e-?mail/i),
    subject: find(/subject|topic/i),
    message: discovered.controls.find((control) => /textarea/i.test(control.selector))?.selector ?? find(/message|enquiry|inquiry|comment|help/i),
    submit: discovered.submitCandidates.length === 1 ? discovered.submitCandidates[0]?.selector : undefined,
  };
  const missing = (["name", "email", "message", "submit"] as const).filter((key) => !mapping[key]);
  return { mapping, missing };
}

export async function processFieldDiscovery(payload: { discoveryId: string }): Promise<void> {
  const [row] = await db().select().from(formDiscoveries).where(eq(formDiscoveries.id, payload.discoveryId));
  if (!row) return;
  const [site] = await db().select().from(sites).where(eq(sites.id, row.siteId));
  const [org] = site ? await db().select().from(organizations).where(eq(organizations.id, site.organizationId)) : [];
  if (!site || site.verificationStatus !== "verified" || !org) {
    await db().update(formDiscoveries).set({ status: "failed", errorDetail: "Verify ownership before Inlet opens this website." }).where(eq(formDiscoveries.id, row.id));
    return;
  }
  const target = targetForSite(site);
  try {
    const session = await runBrowserSandbox({
      owner: { organizationId: site.organizationId },
      role: "browser",
      job: { mode: "discover", targetUrl: target.url, proxyServer: target.proxyServer, navigationTimeoutMs: 25_000 },
      network: { mode: "egress", allow: target.allow },
      retentionDays: 1,
    });
    await destroySandboxByName(session.sessionId, session.handle.containerName);
    const outcome = session.outcome as BrowserOutcome | null;
    if (!outcome?.navigated || !outcome.discovered) {
      await db().update(formDiscoveries).set({ status: "failed", errorDetail: outcome?.failureDetail ?? "The page could not be opened." }).where(eq(formDiscoveries.id, row.id));
      return;
    }
    const discovered = outcome.discovered as Parameters<typeof proposeMapping>[0] & { consentCandidates: unknown[] };
    const { mapping, missing } = proposeMapping(discovered);
    await db()
      .update(formDiscoveries)
      .set({ status: "complete", proposal: { mapping, missing, captchaDetected: outcome.captchaDetected, controls: discovered.controls, submitCandidates: discovered.submitCandidates, consentCandidates: discovered.consentCandidates } })
      .where(eq(formDiscoveries.id, row.id));
  } catch {
    await db().update(formDiscoveries).set({ status: "failed", errorDetail: "The test environment couldn't start." }).where(eq(formDiscoveries.id, row.id));
  }
}

export async function schedulerTick(): Promise<void> {
  const now = new Date();
  const due = await db()
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), eq(schedules.paused, false), lt(schedules.nextRunAt, now)))
    .limit(50);
  for (const schedule of due) {
    const interval = intervalForMode(schedule.mode as ScheduleMode, schedule.intervalMinutes);
    if (!interval) continue;
    const claimed = await db()
      .update(schedules)
      .set({ nextRunAt: nextRunFrom(now, interval), lastRunAt: now })
      .where(and(eq(schedules.id, schedule.id), eq(schedules.nextRunAt, schedule.nextRunAt as Date)))
      .returning({ id: schedules.id });
    if (claimed.length !== 1) continue;
    const [site] = await db().select().from(sites).where(eq(sites.id, schedule.siteId));
    if (!site || site.archivedAt) continue;
    const dayStart = new Date(now.getTime() - 86_400_000);
    const [today] = await db().select({ value: count() }).from(checkRuns).where(and(eq(checkRuns.siteId, site.id), eq(checkRuns.trigger, "schedule"), gte(checkRuns.createdAt, dayStart)));
    if ((today?.value ?? 0) >= schedule.maxDailyRuns) continue;
    await startSiteCheck({
      organizationId: site.organizationId,
      siteId: site.id,
      trigger: "schedule",
      idempotencyKey: `schedule-${(schedule.nextRunAt as Date).toISOString()}`,
    }).catch((error: unknown) => log.warn({ err: error, siteId: site.id }, "scheduled check skipped"));
  }
}

export async function watchdogTick(): Promise<void> {
  const now = new Date();
  const stale = await db()
    .select()
    .from(checkRuns)
    .where(and(inArray(checkRuns.state, ACTIVE_RUN_STATES), lt(checkRuns.leaseExpiresAt, now)))
    .limit(50);
  for (const run of stale) {
    if (run.state === "observing_destination") {
      await db().update(checkRuns).set({ leaseExpiresAt: new Date(Date.now() + 120_000) }).where(eq(checkRuns.id, run.id));
      await enqueue("delivery-verify", run.id, { runId: run.id });
      continue;
    }
    if (run.state !== "complete") {
      await appendRunEvent(run.id, {
        type: "run.interrupted",
        stage: "recovery",
        summary: "The watchdog stopped this check after its worker stopped responding. Nothing will be resubmitted.",
      });
    }
    await finishRun(run.id, run.submissionIntentAt ? "unverified" : "expired", "This check was interrupted and could not be completed.").catch((error: unknown) => log.error({ err: error, runId: run.id }, "watchdog finish failed"));
  }

  const staleInvestigations = await db()
    .select()
    .from(investigations)
    .where(and(eq(investigations.state, "running"), lt(investigations.leaseExpiresAt, now)))
    .limit(20);
  for (const investigation of staleInvestigations) {
    await db().update(investigations).set({ state: "interrupted", completedAt: now, errorCode: "worker_lost", leaseExpiresAt: null }).where(eq(investigations.id, investigation.id));
    await transitionIncident(investigation.incidentId, "investigation_failed", { actor: "watchdog", reason: "The investigation worker stopped responding." }).catch(() => undefined);
  }

  const provider = sandboxProvider();
  const managed = await provider.listManaged().catch(() => []);
  const activeSessions = new Set<string>();
  if (managed.length > 0) {
    const records = await db().select().from(sandboxSessions).where(inArray(sandboxSessions.id, managed.map((item) => item.sessionId)));
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const container of managed) {
      const record = byId.get(container.sessionId);
      if (!record) {
        await provider.forceRemove(container.name);
        continue;
      }
      const ageSeconds = record.startedAt ? (now.getTime() - record.startedAt.getTime()) / 1000 : Number.POSITIVE_INFINITY;
      if (ageSeconds > record.wallLimitSeconds + 180) {
        await destroySandboxByName(record.id, container.name);
      } else {
        activeSessions.add(container.sessionId);
      }
    }
  }
  const pendingCleanup = await db()
    .select()
    .from(sandboxSessions)
    .where(and(eq(sandboxSessions.cleanupVerified, false), lt(sandboxSessions.createdAt, new Date(now.getTime() - 900_000))))
    .limit(30);
  for (const session of pendingCleanup) {
    if (!session.containerName) continue;
    const gone = await provider.verifyGone(session.containerName).catch(() => false);
    if (gone) {
      await db().update(sandboxSessions).set({ cleanupVerified: true, cleanupVerifiedAt: now }).where(eq(sandboxSessions.id, session.id));
    } else {
      await destroySandboxByName(session.id, session.containerName);
    }
  }
  const active = await db().select({ id: investigations.id }).from(investigations).where(eq(investigations.state, "running"));
  if (active.length === 0) await sweepOrphanPreviews(new Set()).catch(() => 0);
}

export async function retentionTick(): Promise<void> {
  const now = new Date();
  const expired = await db().select().from(runArtifacts).where(and(isNull(runArtifacts.deletedAt), lt(runArtifacts.expiresAt, now))).limit(500);
  for (const artifact of expired) {
    await deleteObject(artifact.objectKey);
    await db().update(runArtifacts).set({ deletedAt: now }).where(eq(runArtifacts.id, artifact.id));
  }
  await db().delete(sessions).where(lt(sessions.expiresAt, now));
  await db().delete(authTokens).where(lt(authTokens.expiresAt, now));
  await db().delete(demoSessions).where(lt(demoSessions.expiresAt, now));
  if (expired.length > 0) log.info({ deleted: expired.length }, "retention removed expired artifacts");
}

