import { and, checkRuns, db, destinations, eq, incidents, incidentTransitions, inArray, sites, notificationPreferences, notifications, organizations, users, desc, gte } from "@inlet/database";
import type { DbExecutor } from "@inlet/database";
import { AppError, canTransitionIncident, newId } from "@inlet/domain";
import type { IncidentState } from "@inlet/domain";
import { audit } from "./audit";
import { enqueue } from "./outbox";

export type TransitionOptions = {
  actor: string;
  actorUserId?: string | null;
  reason?: string;
  expectedVersion?: number;
  patch?: Partial<typeof incidents.$inferInsert>;
};

export async function transitionIncident(
  incidentId: string,
  to: IncidentState,
  options: TransitionOptions,
  executor: DbExecutor = db(),
): Promise<void> {
  const [incident] = await executor.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!incident) throw new AppError("NOT_FOUND", "That incident no longer exists.");
  if (!canTransitionIncident(incident.state, to)) {
    throw new AppError("INVALID_TRANSITION", `This incident cannot move from ${incident.state} to ${to}.`);
  }
  if (options.expectedVersion !== undefined && options.expectedVersion !== incident.version) {
    throw new AppError("CONFLICT", "Someone else updated this incident. Reload and try again.");
  }
  const updated = await executor
    .update(incidents)
    .set({ ...options.patch, state: to, version: incident.version + 1, updatedAt: new Date() })
    .where(and(eq(incidents.id, incidentId), eq(incidents.version, incident.version)))
    .returning({ id: incidents.id });
  if (updated.length !== 1) throw new AppError("CONFLICT", "Someone else updated this incident. Reload and try again.");
  await executor.insert(incidentTransitions).values({
    id: newId(),
    incidentId,
    fromState: incident.state,
    toState: to,
    actor: options.actor,
    reason: options.reason,
  });
  await audit(
    {
      organizationId: incident.organizationId,
      actorUserId: options.actorUserId ?? null,
      entityType: "incident",
      entityId: incidentId,
      action: `incident.${to}`,
      safeMetadata: { from: incident.state, reason: options.reason },
    },
    executor,
  );
}

const LIVE_INCIDENT_STATES: IncidentState[] = [
  "open",
  "investigating",
  "needs_configuration",
  "repair_unavailable",
  "patch_proposed",
  "investigation_failed",
  "patch_testing",
  "patch_ready",
  "patch_failed",
  "awaiting_approval",
  "approved",
  "rejected",
  "awaiting_deployment",
  "rechecking",
  "still_failing",
];

export async function applyRunOutcome(runId: string): Promise<void> {
  const [run] = await db().select().from(checkRuns).where(eq(checkRuns.id, runId));
  if (!run?.siteId || run.kind !== "delivery" || !run.result) return;
  const siteId = run.siteId;

  if (run.incidentId && run.trigger === "recheck") {
    await db().transaction(async (tx) => {
      const [incident] = await tx.select().from(incidents).where(eq(incidents.id, run.incidentId as string));
      if (!incident || incident.state !== "rechecking") return;
      if (run.result === "received") {
        await transitionIncident(incident.id, "verified_recovered", { actor: "system", reason: "A new check found its test message in the destination.", patch: { recoveryRunId: runId } }, tx);
        await enqueue("notifications", incident.id, { kind: "recovery", incidentId: incident.id, siteId, runId }, tx);
      } else {
        await transitionIncident(incident.id, "still_failing", { actor: "system", reason: `The post-deployment check ended as ${run.result}.` }, tx);
        await enqueue("notifications", incident.id, { kind: "action_required", incidentId: incident.id, siteId, runId }, tx);
      }
    });
    return;
  }

  if (run.result !== "not_received") return;

  await db().transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(and(eq(incidents.siteId, siteId), inArray(incidents.state, LIVE_INCIDENT_STATES)))
      .orderBy(desc(incidents.createdAt))
      .limit(1);
    if (existing) {
      await tx.update(checkRuns).set({ incidentId: existing.id }).where(eq(checkRuns.id, runId));
      await enqueue("notifications", existing.id, { kind: "failure_repeat", incidentId: existing.id, siteId, runId }, tx);
      return;
    }
    const incidentId = newId();
    const [site] = await tx.select({ owner: sites.ownerUserId }).from(sites).where(eq(sites.id, siteId));
    await tx.insert(incidents).values({
      id: incidentId,
      organizationId: run.organizationId,
      siteId,
      openedByRunId: runId,
      title: "Form submitted, enquiry not received",
      ownerUserId: site?.owner ?? null,
    });
    await tx.update(checkRuns).set({ incidentId }).where(eq(checkRuns.id, runId));
    await audit({ organizationId: run.organizationId, entityType: "incident", entityId: incidentId, action: "incident.opened", safeMetadata: { runId } }, tx);
    await enqueue("notifications", incidentId, { kind: "failure", incidentId, siteId, runId }, tx);
  });
}

export type NotificationKind = "failure" | "failure_repeat" | "recovery" | "action_required" | "connection_expired" | "test";

const PREFERENCE_KEY: Record<Exclude<NotificationKind, "test">, keyof typeof notificationPreferences.$inferSelect> = {
  failure: "notifyFailure",
  failure_repeat: "notifyFailure",
  recovery: "notifyRecovery",
  action_required: "notifyActionRequired",
  connection_expired: "notifyConnectionExpired",
};

export type PlannedNotification = {
  id: string;
  recipient: string;
  subject: string;
  text: string;
} | null;

function inQuietHours(hour: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export async function planNotification(input: {
  kind: NotificationKind;
  organizationId: string;
  siteId?: string | null;
  incidentId?: string | null;
  runId?: string | null;
  appUrl: string;
}): Promise<PlannedNotification> {
  const [org] = await db().select().from(organizations).where(eq(organizations.id, input.organizationId));
  if (!org || org.isDemo) return null;
  const [prefs] = await db().select().from(notificationPreferences).where(eq(notificationPreferences.organizationId, org.id));
  const [owner] = await db().select({ email: users.email }).from(users).where(eq(users.id, org.ownerUserId));
  const recipient = prefs?.email ?? owner?.email;
  if (!recipient) return null;

  const site = input.siteId ? (await db().select().from(sites).where(eq(sites.id, input.siteId)))[0] : undefined;
  const destination = input.siteId
    ? (await db().select({ name: destinations.displayName }).from(destinations).where(eq(destinations.siteId, input.siteId)).limit(1))[0]
    : undefined;
  const siteName = site?.name ?? "your website";
  const deepLink = input.incidentId ? `${input.appUrl}/app/incidents/${input.incidentId}` : `${input.appUrl}/app/sites`;

  const copy: Record<NotificationKind, { subject: string; body: string }> = {
    failure: {
      subject: `Enquiry not received: ${siteName}`,
      body: `Inlet submitted a test enquiry on ${siteName}. No matching message reached ${destination?.name ?? "the connected destination"} during the observation window.`,
    },
    failure_repeat: {
      subject: `Still not receiving enquiries: ${siteName}`,
      body: `Another test enquiry on ${siteName} did not reach ${destination?.name ?? "the connected destination"}.`,
    },
    recovery: {
      subject: `Delivery recovered: ${siteName}`,
      body: `A new test enquiry on ${siteName} was found in ${destination?.name ?? "the connected destination"}.`,
    },
    action_required: {
      subject: `Action needed: ${siteName}`,
      body: `A check on ${siteName} needs your attention before the incident can move forward.`,
    },
    connection_expired: {
      subject: `Connection needs attention: ${siteName}`,
      body: `Inlet could not reach the destination connected to ${siteName}. Checks will stay unverified until it is reconnected.`,
    },
    test: { subject: "Inlet test notification", body: "This is a test of your Inlet notification settings." },
  };
  const { subject, body } = copy[input.kind];

  const dedupKey = `${org.id}:${input.siteId ?? "org"}:${input.kind}`;
  const windowMinutes = prefs?.dedupWindowMinutes ?? 360;
  let suppressed = false;
  let reason: string | undefined;

  if (input.kind !== "test") {
    const preference = PREFERENCE_KEY[input.kind];
    if (prefs && prefs[preference] === false) {
      suppressed = true;
      reason = "preference_off";
    }
    const since = new Date(Date.now() - windowMinutes * 60_000);
    const [recent] = await db()
      .select({ id: notifications.id, grouped: notifications.groupedCount })
      .from(notifications)
      .where(and(eq(notifications.dedupKey, dedupKey), eq(notifications.deliveryStatus, "sent"), gte(notifications.createdAt, since)))
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    if (recent && !suppressed) {
      await db().update(notifications).set({ groupedCount: recent.grouped + 1 }).where(eq(notifications.id, recent.id));
      return null;
    }
    if (!suppressed && inQuietHours(new Date().getUTCHours(), prefs?.quietHoursStart ?? null, prefs?.quietHoursEnd ?? null)) {
      suppressed = true;
      reason = "quiet_hours";
    }
  }

  const id = newId();
  await db().insert(notifications).values({
    id,
    organizationId: org.id,
    siteId: input.siteId ?? null,
    incidentId: input.incidentId ?? null,
    kind: input.kind,
    recipient,
    subject,
    deliveryStatus: suppressed ? "suppressed" : "pending",
    dedupKey,
    errorCode: reason,
  });
  if (suppressed) return null;
  return { id, recipient, subject, text: `${body}\n\nWebsite: ${siteName}\nDetails: ${deepLink}\n` };
}
