import type { FastifyPluginAsyncZod, ZodTypeProvider } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { isProduction } from "@inlet/config";
import { DEFAULT_SYNTHETIC_IDENTITY, FIXTURE_FIELD_MAP, insertRun, runChannel, ACTIVE_RUN_STATES } from "@inlet/control";
import { and, asc, checkRuns, count, db, demoSessions, desc, destinations, eq, formConfigs, gt, gte, incidents, inArray, investigations, investigationEvents, isNull, patches, patchChecks, runArtifacts, runEvents, sites, organizations } from "@inlet/database";
import { AppError, newId } from "@inlet/domain";
import { getObject, hmacIp } from "@inlet/evidence";
import { fixtureRecipient, FIXTURES } from "@inlet/policy";
import type { FixtureSlot } from "@inlet/policy";
import { hashToken, randomToken } from "../plumbing/auth";
import { streamEvents } from "../plumbing/sse";
import { eventView, runDetail } from "./runs";

const DEMO_COOKIE = "inlet_demo";
const SESSION_RUNS_PER_HOUR = 6;
const IP_RUNS_PER_HOUR = 12;

export const DEMO_SCENARIOS = [
  { id: "working", title: "Working form", description: "A test site whose notification email really gets sent.", slot: "healthy" as FixtureSlot, kind: "delivery" as const },
  { id: "missing-notification", title: "Missing notification", description: "A controlled fault: the form shows success and the notification is silently skipped.", slot: "demo-broken" as FixtureSlot, kind: "delivery" as const },
  { id: "blocked-action", title: "Blocked action", description: "A controlled attack page tries to send the browser to an unapproved host.", slot: "attack" as FixtureSlot, kind: "containment" as const },
];

async function demoOrgId(): Promise<string> {
  const [org] = await db().select({ id: organizations.id }).from(organizations).where(eq(organizations.isDemo, true));
  if (!org) throw new AppError("DEPENDENCY_UNAVAILABLE", "The controlled demo isn't set up. Run the seed step.");
  return org.id;
}

async function ensureDemoSite(orgId: string, slot: FixtureSlot): Promise<{ siteId: string; destinationId: string; formConfigId: string }> {
  const [existing] = await db().select().from(sites).where(and(eq(sites.organizationId, orgId), eq(sites.fixtureSlot, slot)));
  if (existing) {
    const [destination] = await db().select().from(destinations).where(and(eq(destinations.siteId, existing.id), isNull(destinations.deletedAt)));
    const [config] = await db().select().from(formConfigs).where(eq(formConfigs.siteId, existing.id));
    if (destination && config) return { siteId: existing.id, destinationId: destination.id, formConfigId: config.id };
  }
  const fixture = FIXTURES[slot];
  const siteId = newId();
  const destinationId = newId();
  const formConfigId = newId();
  await db().transaction(async (tx) => {
    await tx.insert(sites).values({ id: siteId, organizationId: orgId, name: `Acme Demo (${slot})`, verifiedOrigin: `http://${fixture.internalHost}:${fixture.port}`, formUrl: `http://${fixture.internalHost}:${fixture.port}/contact`, authorizationAcceptedAt: new Date(), verificationStatus: "verified", verificationMethod: "controlled_fixture", verifiedAt: new Date(), fixtureSlot: slot, setupCompletedAt: new Date(), setupStep: 4 });
    await tx.insert(destinations).values({ id: destinationId, organizationId: orgId, siteId, type: "mailpit", displayName: "Test inbox", status: "connected", settings: { expectedRecipient: fixtureRecipient(slot) } });
    await tx.insert(formConfigs).values({ id: formConfigId, siteId, version: 1, fieldMap: FIXTURE_FIELD_MAP, syntheticIdentity: DEFAULT_SYNTHETIC_IDENTITY });
  });
  return { siteId, destinationId, formConfigId };
}

async function demoSession(request: FastifyRequest): Promise<typeof demoSessions.$inferSelect | null> {
  const token = request.cookies[DEMO_COOKIE];
  if (!token) return null;
  const [session] = await db().select().from(demoSessions).where(and(eq(demoSessions.tokenHash, hashToken(token)), gt(demoSessions.expiresAt, new Date())));
  return session ?? null;
}

async function loadDemoRun(request: FastifyRequest, runId: string): Promise<typeof checkRuns.$inferSelect> {
  const session = await demoSession(request);
  if (!session) throw new AppError("NOT_FOUND", "That demo run does not exist.");
  const [run] = await db().select().from(checkRuns).where(and(eq(checkRuns.id, runId), eq(checkRuns.demoSessionId, session.id)));
  if (!run) throw new AppError("NOT_FOUND", "That demo run does not exist.");
  return run;
}

export const demoRoutes: FastifyPluginAsyncZod = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get("/demo/scenarios", async () => ({ scenarios: DEMO_SCENARIOS.map(({ id, title, description, kind }) => ({ id, title, description, kind })) }));

  typed.post("/demo/scenarios/:id/runs", { config: { rateLimit: { max: 12, timeWindow: "1 hour" } }, schema: { params: z.object({ id: z.string().max(40) }) } }, async (request, reply) => {
    const scenario = DEMO_SCENARIOS.find((item) => item.id === request.params.id);
    if (!scenario) throw new AppError("NOT_FOUND", "That scenario does not exist.");
    const ipHash = hmacIp(request.ip);
    let session = await demoSession(request);
    if (!session) {
      const token = randomToken();
      const id = newId();
      const expiresAt = new Date(Date.now() + 86_400_000);
      await db().insert(demoSessions).values({ id, tokenHash: hashToken(token), ipHash, expiresAt });
      session = (await db().select().from(demoSessions).where(eq(demoSessions.id, id)))[0] ?? null;
      reply.setCookie(DEMO_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure: isProduction(), maxAge: 86_400 });
    }
    if (!session) throw new AppError("INTERNAL", "Could not create a demo session.");

    const [active] = await db().select({ id: checkRuns.id }).from(checkRuns).where(and(eq(checkRuns.demoSessionId, session.id), inArray(checkRuns.state, ACTIVE_RUN_STATES))).limit(1);
    if (active) return reply.status(202).send({ runId: active.id, existing: true });

    const since = new Date(Date.now() - 3_600_000);
    const [sessionRuns] = await db().select({ value: count() }).from(checkRuns).where(and(eq(checkRuns.demoSessionId, session.id), gte(checkRuns.createdAt, since)));
    const [ipRuns] = await db().select({ value: count() }).from(checkRuns).innerJoin(demoSessions, eq(checkRuns.demoSessionId, demoSessions.id)).where(and(eq(demoSessions.ipHash, ipHash), gte(checkRuns.createdAt, since)));
    if ((sessionRuns?.value ?? 0) >= SESSION_RUNS_PER_HOUR || (ipRuns?.value ?? 0) >= IP_RUNS_PER_HOUR) {
      throw new AppError("RATE_LIMITED", "You've reached the demo limit for this hour.", { nextAction: "Try again later, or create a workspace." });
    }

    const orgId = await demoOrgId();
    const demoSessionId = session.id;
    const runId = await db().transaction(async (tx) => {
      if (scenario.kind === "containment") {
        return insertRun(tx, { organizationId: orgId, siteId: null, kind: "containment", scenario: "prompt-injection", trigger: "demo", demoSessionId });
      }
      const target = await ensureDemoSite(orgId, scenario.slot);
      return insertRun(tx, { organizationId: orgId, siteId: target.siteId, trigger: "demo", demoSessionId, destinationId: target.destinationId, formConfigId: target.formConfigId, scenario: scenario.id });
    });
    return reply.status(202).send({ runId });
  });

  typed.get("/demo/runs/:id", { schema: { params: z.object({ id: z.uuid() }) } }, async (request) => runDetail(await loadDemoRun(request, request.params.id), { revealToken: true, includePolicy: true }));

  typed.get("/demo/runs/:id/events", { schema: { params: z.object({ id: z.uuid() }) } }, async (request, reply) => {
    const run = await loadDemoRun(request, request.params.id);
    await streamEvents(request, reply, {
      channel: runChannel(run.id),
      load: async (after) => (await db().select().from(runEvents).where(and(eq(runEvents.runId, run.id), gt(runEvents.sequence, after))).orderBy(asc(runEvents.sequence)).limit(200)).map(eventView),
      isFinished: async () => (await db().select({ state: checkRuns.state }).from(checkRuns).where(eq(checkRuns.id, run.id)))[0]?.state === "cleanup_complete",
    });
  });

  typed.get("/demo/runs/:id/artifacts/:artifactId", { schema: { params: z.object({ id: z.uuid(), artifactId: z.uuid() }) } }, async (request, reply) => {
    const run = await loadDemoRun(request, request.params.id);
    const [artifact] = await db().select().from(runArtifacts).where(and(eq(runArtifacts.id, request.params.artifactId), eq(runArtifacts.runId, run.id), isNull(runArtifacts.deletedAt)));
    if (!artifact || artifact.mime !== "image/png") throw new AppError("NOT_FOUND", "That file does not exist.");
    reply.header("content-type", "image/png");
    reply.header("cache-control", "private, max-age=300");
    return reply.send(await getObject(artifact.objectKey));
  });

  typed.get("/demo/recorded-repair", async () => {
    const [incident] = await db().select().from(incidents).where(and(eq(incidents.publicTrace, true), eq(incidents.state, "verified_recovered"))).orderBy(desc(incidents.updatedAt)).limit(1);
    if (!incident) return { recorded: null };
    const [investigation] = await db().select().from(investigations).where(and(eq(investigations.incidentId, incident.id), eq(investigations.state, "patch_ready"))).orderBy(desc(investigations.createdAt)).limit(1);
    const [patch] = incident.currentPatchId ? await db().select().from(patches).where(eq(patches.id, incident.currentPatchId)) : [];
    if (!investigation || !patch) return { recorded: null };
    const events = await db().select().from(investigationEvents).where(eq(investigationEvents.investigationId, investigation.id)).orderBy(asc(investigationEvents.sequence));
    const checks = await db().select().from(patchChecks).where(eq(patchChecks.patchId, patch.id));
    const [before] = await db().select().from(checkRuns).where(eq(checkRuns.id, incident.openedByRunId));
    const [after] = incident.recoveryRunId ? await db().select().from(checkRuns).where(eq(checkRuns.id, incident.recoveryRunId)) : [];
    return {
      recorded: {
        label: "Recorded real run",
        origin: investigation.origin,
        modelId: investigation.modelId,
        diff: patch.diffText,
        changedFiles: patch.changedFiles,
        events: events.map((event) => ({ sequence: event.sequence, summary: event.summary, at: event.timestamp })),
        checks: checks.map((check) => ({ name: check.name, variant: check.variant, pass: check.pass })),
        before: before ? { id: before.id, result: before.result, completedAt: before.completedAt } : null,
        after: after ? { id: after.id, result: after.result, completedAt: after.completedAt } : null,
      },
    };
  });

};
