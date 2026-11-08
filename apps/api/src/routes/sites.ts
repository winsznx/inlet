import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyPluginAsyncZod, ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { env, fixturesEnabled, githubConfigured, isProduction } from "@inlet/config";
import { audit, DEFAULT_SYNTHETIC_IDENTITY, enqueue, FIXTURE_FIELD_MAP, intervalForMode, MIN_INTERVAL_MINUTES, nextRunFrom, dailyRunEstimate, verifierFor } from "@inlet/control";
import { and, checkRuns, count, db, desc, destinations, eq, formConfigs, formDiscoveries, ilike, incidents, inArray, inboundReceipts, isNull, schedules, secrets, sites, sourceConnections, users } from "@inlet/database";
import { AppError, fieldMapSchema, newId, syntheticIdentitySchema } from "@inlet/domain";
import { encryptSecret } from "@inlet/evidence";
import { fixtureRecipient, fixtureSlotForLocalUrl, FIXTURES, TARGET_REJECTION_COPY, checkPublicTarget, BUILD_PROFILES } from "@inlet/policy";
import type { FixtureSlot } from "@inlet/policy";
import { assertGithubConfigured, downloadTarball, headSha, installationToken } from "@inlet/integrations";
import { requireOrg } from "../plumbing/auth";
import type { OrgContext } from "../plumbing/auth";
import { newVerificationToken, verifyDnsTxt, verifyHtmlMeta } from "../plumbing/verification";
import { initRepositoryFromUpload, refreshFixtureRepository, validateRepository } from "../plumbing/repositories";

const siteParams = z.object({ siteId: z.uuid() });
const idParams = z.object({ id: z.uuid() });
const LIVE_STATES = ["open", "investigating", "needs_configuration", "repair_unavailable", "patch_proposed", "investigation_failed", "patch_testing", "patch_ready", "patch_failed", "awaiting_approval", "approved", "rejected", "awaiting_deployment", "rechecking", "still_failing"] as const;

export async function loadSite(context: OrgContext, siteId: string): Promise<typeof sites.$inferSelect> {
  const [site] = await db().select().from(sites).where(and(eq(sites.id, siteId), eq(sites.organizationId, context.organizationId), isNull(sites.archivedAt)));
  if (!site) throw new AppError("NOT_FOUND", "That website does not exist.");
  return site;
}

function destinationView(row: typeof destinations.$inferSelect) {
  return {
    id: row.id,
    type: row.type,
    displayName: row.displayName,
    host: row.host,
    port: row.port,
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt,
    lastError: row.lastError,
    folder: row.settings.folder,
    user: row.settings.user,
    expectedRecipient: row.settings.expectedRecipient,
    hasCredential: Boolean(row.encryptedCredentialId),
    inboundPath: row.type === "webhook" ? `/api/v1/webhooks/inbound/${row.id}` : undefined,
  };
}

function connectionView(row: typeof sourceConnections.$inferSelect) {
  return {
    id: row.id,
    provider: row.provider,
    repoSlug: row.repoSlug,
    baseBranch: row.baseBranch,
    baseCommitSha: row.baseCommitSha,
    approvedPaths: row.approvedPaths,
    packageManager: row.packageManager,
    buildProfile: row.buildProfile,
    isControlledFixture: row.isControlledFixture,
    status: row.status,
    lastValidatedAt: row.lastValidatedAt,
    lastError: row.lastError,
  };
}

function siteSummary(site: typeof sites.$inferSelect) {
  return {
    id: site.id,
    name: site.name,
    formUrl: site.formUrl,
    formPurpose: site.formPurpose,
    verificationStatus: site.verificationStatus,
    verificationMethod: site.verificationMethod,
    verificationExpiresAt: site.verificationExpiresAt,
    verificationLastError: site.verificationLastError,
    verifiedAt: site.verifiedAt,
    setupStep: site.setupStep,
    setupCompletedAt: site.setupCompletedAt,
    isControlledFixture: Boolean(site.fixtureSlot),
    fixtureLabel: site.fixtureSlot ? FIXTURES[site.fixtureSlot as FixtureSlot].label : null,
    createdAt: site.createdAt,
  };
}

const destinationBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mailpit"), displayName: z.string().trim().min(1).max(80).default("Test inbox (local)") }),
  z.object({
    type: z.literal("imap"),
    displayName: z.string().trim().min(1).max(80),
    host: z.string().min(1).max(200),
    port: z.coerce.number().int().min(1).max(65535).default(993),
    user: z.string().min(1).max(200),
    password: z.string().min(1).max(500),
    folder: z.string().min(1).max(120).default("INBOX"),
  }),
  z.object({ type: z.literal("webhook"), displayName: z.string().trim().min(1).max(80) }),
]);

export const siteRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/sites",
    { schema: { querystring: z.object({ search: z.string().max(100).optional(), status: z.string().max(40).optional(), sort: z.enum(["name", "status", "checked"]).default("checked") }) } },
    async (request) => {
      const context = await requireOrg(request);
      const { search, status, sort } = request.query;
      const rows = await db()
        .select({ site: sites, ownerName: users.name, schedule: schedules })
        .from(sites)
        .leftJoin(users, eq(sites.ownerUserId, users.id))
        .leftJoin(schedules, eq(schedules.siteId, sites.id))
        .where(and(eq(sites.organizationId, context.organizationId), isNull(sites.archivedAt), search ? ilike(sites.name, `%${search.replace(/[%_]/g, "")}%`) : undefined));
      const runIds = rows.map((row) => row.site.lastRunId).filter((value): value is string => Boolean(value));
      const runs = runIds.length ? await db().select().from(checkRuns).where(inArray(checkRuns.id, runIds)) : [];
      const byId = new Map(runs.map((run) => [run.id, run]));
      const openIncidents = rows.length
        ? await db()
            .select({ siteId: incidents.siteId, id: incidents.id })
            .from(incidents)
            .where(and(eq(incidents.organizationId, context.organizationId), inArray(incidents.state, [...LIVE_STATES])))
        : [];
      const incidentBySite = new Map(openIncidents.map((item) => [item.siteId, item.id]));
      let views = rows.map(({ site, ownerName, schedule }) => {
        const run = site.lastRunId ? byId.get(site.lastRunId) : undefined;
        return {
          ...siteSummary(site),
          ownerName,
          latestRun: run ? { id: run.id, state: run.state, result: run.result, startedAt: run.startedAt, completedAt: run.completedAt } : null,
          nextRunAt: schedule?.enabled && !schedule.paused ? schedule.nextRunAt : null,
          openIncidentId: incidentBySite.get(site.id) ?? null,
        };
      });
      if (status) views = views.filter((view) => (view.latestRun?.result ?? "none") === status);
      views.sort((a, b) => {
        if (sort === "name") return a.name.localeCompare(b.name);
        if (sort === "status") return (a.latestRun?.result ?? "zzz").localeCompare(b.latestRun?.result ?? "zzz");
        return (b.latestRun?.completedAt?.getTime() ?? 0) - (a.latestRun?.completedAt?.getTime() ?? 0);
      });
      const lastCompleted = views.map((view) => view.latestRun?.completedAt).filter((value): value is Date => Boolean(value)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      return {
        sites: views,
        summary: {
          connected: views.length,
          needsAttention: views.filter((view) => view.openIncidentId || ["not_received", "unverified", "browser_failed"].includes(view.latestRun?.result ?? "")).length,
          lastCompletedAt: lastCompleted,
        },
      };
    },
  );

  app.post(
    "/sites",
    {
      schema: {
        body: z.object({
          name: z.string().trim().min(2).max(80),
          formUrl: z.string().min(1).max(500),
          formPurpose: z.enum(["contact", "quote", "booking", "custom"]).default("contact"),
          authorized: z.literal(true, "Confirm that you control this website."),
        }),
      },
    },
    async (request, reply) => {
      const context = await requireOrg(request, "site:edit");
      const { name, formUrl, formPurpose } = request.body;
      const slot = fixturesEnabled() ? fixtureSlotForLocalUrl(formUrl) : null;
      if (!slot && fixturesEnabled() && /^https?:\/\/(localhost|127\.)/.test(formUrl)) {
        throw new AppError("UNSAFE_TARGET", "Only Inlet's controlled sample sites can be tested on localhost.", { nextAction: "Use a public https address." });
      }
      let origin: string;
      if (slot) {
        origin = new URL(formUrl).origin;
      } else {
        const check = await checkPublicTarget(formUrl);
        if (!check.ok) throw new AppError("UNSAFE_TARGET", TARGET_REJECTION_COPY[check.reason], { nextAction: "Use the public https address of a website you control." });
        origin = check.origin;
      }
      const id = newId();
      const now = new Date();
      await db().insert(sites).values({
        id,
        organizationId: context.organizationId,
        name,
        verifiedOrigin: origin,
        formUrl,
        formPurpose,
        ownerUserId: context.user.id,
        authorizationAcceptedAt: now,
        authorizationAcceptedBy: context.user.id,
        fixtureSlot: slot,
        verificationStatus: slot ? "verified" : "pending",
        verificationMethod: slot ? "controlled_fixture" : null,
        verifiedAt: slot ? now : null,
        setupStep: slot ? 3 : 2,
      });
      await db().insert(schedules).values({ id: newId(), siteId: id, timezone: context.organization.timezone });
      await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "site", entityId: id, action: "site.created", safeMetadata: { name, controlledFixture: Boolean(slot) } });
      return reply.status(201).send({ id, controlledFixture: Boolean(slot) });
    },
  );

  app.get("/sites/:siteId", { schema: { params: siteParams } }, async (request) => {
    const context = await requireOrg(request);
    const site = await loadSite(context, request.params.siteId);
    const [config] = await db().select().from(formConfigs).where(eq(formConfigs.siteId, site.id)).orderBy(desc(formConfigs.version)).limit(1);
    const [destination] = await db().select().from(destinations).where(and(eq(destinations.siteId, site.id), isNull(destinations.deletedAt))).orderBy(desc(destinations.createdAt)).limit(1);
    const [connection] = await db().select().from(sourceConnections).where(and(eq(sourceConnections.siteId, site.id), isNull(sourceConnections.deletedAt))).limit(1);
    const [schedule] = await db().select().from(schedules).where(eq(schedules.siteId, site.id));
    const recent = await db().select().from(checkRuns).where(eq(checkRuns.siteId, site.id)).orderBy(desc(checkRuns.createdAt)).limit(5);
    const siteIncidents = await db().select().from(incidents).where(eq(incidents.siteId, site.id)).orderBy(desc(incidents.createdAt)).limit(20);
    return {
      ...siteSummary(site),
      verificationToken: site.verificationStatus === "verified" ? null : site.verificationToken,
      formConfig: config ? { version: config.version, fieldMap: config.fieldMap, syntheticIdentity: config.syntheticIdentity, consentMode: config.consentMode, maxSubmissionFrequencyMinutes: config.maxSubmissionFrequencyMinutes } : null,
      destination: destination ? destinationView(destination) : null,
      repository: connection ? connectionView(connection) : null,
      schedule: schedule ? scheduleView(schedule) : null,
      recentRuns: recent.map((run) => ({ id: run.id, state: run.state, result: run.result, trigger: run.trigger, startedAt: run.startedAt, completedAt: run.completedAt, durationMs: run.durationMs, summary: run.resultSummary })),
      incidents: siteIncidents.map((incident) => ({ id: incident.id, title: incident.title, state: incident.state, createdAt: incident.createdAt, updatedAt: incident.updatedAt })),
    };
  });

  app.patch(
    "/sites/:siteId",
    { schema: { params: siteParams, body: z.object({ name: z.string().trim().min(2).max(80).optional(), formPurpose: z.enum(["contact", "quote", "booking", "custom"]).optional(), setupStep: z.number().int().min(1).max(4).optional(), setupComplete: z.boolean().optional() }) } },
    async (request) => {
      const context = await requireOrg(request, "site:edit");
      const site = await loadSite(context, request.params.siteId);
      const { setupComplete, ...rest } = request.body;
      await db().update(sites).set({ ...rest, setupCompletedAt: setupComplete ? new Date() : site.setupCompletedAt, updatedAt: new Date() }).where(eq(sites.id, site.id));
      await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "site", entityId: site.id, action: "site.updated" });
      return { ok: true };
    },
  );

  app.delete("/sites/:siteId", { schema: { params: siteParams } }, async (request) => {
    const context = await requireOrg(request, "site:edit");
    const site = await loadSite(context, request.params.siteId);
    await db().update(sites).set({ archivedAt: new Date(), active: false }).where(eq(sites.id, site.id));
    await db().update(schedules).set({ enabled: false, mode: "off" }).where(eq(schedules.siteId, site.id));
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "site", entityId: site.id, action: "site.archived" });
    return { ok: true };
  });

  app.post("/sites/:siteId/ownership-challenge", { schema: { params: siteParams, body: z.object({ method: z.enum(["dns_txt", "html_meta"]) }) } }, async (request) => {
    const context = await requireOrg(request, "site:edit");
    const site = await loadSite(context, request.params.siteId);
    if (site.fixtureSlot) throw new AppError("CONFLICT", "Controlled sample sites are already verified.");
    const token = newVerificationToken();
    const expires = new Date(Date.now() + 48 * 3_600_000);
    await db().update(sites).set({ verificationToken: token, verificationMethod: request.body.method, verificationExpiresAt: expires, verificationStatus: "pending", verificationLastError: null }).where(eq(sites.id, site.id));
    const host = new URL(site.verifiedOrigin).hostname;
    return { token, record: `inlet-verification=${token}`, host, expiresAt: expires, metaTag: `<meta name="inlet-verification" content="${token}">` };
  });

  app.post("/sites/:siteId/verify-ownership", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { params: siteParams } }, async (request) => {
    const context = await requireOrg(request, "site:edit");
    const site = await loadSite(context, request.params.siteId);
    if (site.verificationStatus === "verified") return { verified: true, detail: "Already verified." };
    if (!site.verificationToken || !site.verificationMethod || site.verificationMethod === "controlled_fixture") {
      throw new AppError("CONFLICT", "Generate a verification token first.");
    }
    if (site.verificationExpiresAt && site.verificationExpiresAt < new Date()) {
      await db().update(sites).set({ verificationStatus: "expired" }).where(eq(sites.id, site.id));
      throw new AppError("CONFLICT", "That verification token has expired.", { nextAction: "Generate a new token." });
    }
    const outcome = site.verificationMethod === "dns_txt" ? await verifyDnsTxt(new URL(site.verifiedOrigin).hostname, site.verificationToken) : await verifyHtmlMeta(site.formUrl, site.verificationToken);
    await db()
      .update(sites)
      .set(outcome.ok ? { verificationStatus: "verified", verifiedAt: new Date(), verificationLastError: null, setupStep: 3 } : { verificationStatus: "pending", verificationLastError: outcome.detail })
      .where(eq(sites.id, site.id));
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "site", entityId: site.id, action: outcome.ok ? "site.ownership_verified" : "site.ownership_check_failed" });
    return { verified: outcome.ok, detail: outcome.detail };
  });

  app.get("/sites/:siteId/form-config", { schema: { params: siteParams } }, async (request) => {
    const context = await requireOrg(request);
    const site = await loadSite(context, request.params.siteId);
    const [config] = await db().select().from(formConfigs).where(eq(formConfigs.siteId, site.id)).orderBy(desc(formConfigs.version)).limit(1);
    return { config: config ?? null, defaults: { syntheticIdentity: DEFAULT_SYNTHETIC_IDENTITY, fieldMap: site.fixtureSlot ? FIXTURE_FIELD_MAP : null } };
  });

  app.patch(
    "/sites/:siteId/form-config",
    { schema: { params: siteParams, body: z.object({ fieldMap: fieldMapSchema, syntheticIdentity: syntheticIdentitySchema.optional(), consentMode: z.enum(["none", "controlled_test_account"]).default("none"), maxSubmissionFrequencyMinutes: z.number().int().min(15).max(10_080).default(15) }) } },
    async (request) => {
      const context = await requireOrg(request, "site:edit");
      const site = await loadSite(context, request.params.siteId);
      const { fieldMap, syntheticIdentity, consentMode, maxSubmissionFrequencyMinutes } = request.body;
      if (fieldMap.consent && consentMode !== "controlled_test_account") {
        throw new AppError("INVALID_INPUT", "Inlet never ticks a consent box unless you confirm it is your own controlled test account.");
      }
      const [latest] = await db().select().from(formConfigs).where(eq(formConfigs.siteId, site.id)).orderBy(desc(formConfigs.version)).limit(1);
      const version = (latest?.version ?? 0) + 1;
      await db().insert(formConfigs).values({ id: newId(), siteId: site.id, version, fieldMap, syntheticIdentity: syntheticIdentity ?? latest?.syntheticIdentity ?? DEFAULT_SYNTHETIC_IDENTITY, consentMode, maxSubmissionFrequencyMinutes, updatedBy: context.user.id });
      await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "site", entityId: site.id, action: "site.form_config_updated", safeMetadata: { version } });
      return { version };
    },
  );

  app.post("/sites/:siteId/discover-fields", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { params: siteParams } }, async (request, reply) => {
    const context = await requireOrg(request, "site:edit");
    const site = await loadSite(context, request.params.siteId);
    if (site.verificationStatus !== "verified") throw new AppError("OWNERSHIP_NOT_VERIFIED", "Verify ownership before Inlet opens this website.");
    const id = newId();
    await db().transaction(async (tx) => {
      await tx.insert(formDiscoveries).values({ id, organizationId: context.organizationId, siteId: site.id });
      await enqueue("field-discovery", id, { discoveryId: id }, tx);
    });
    return reply.status(202).send({ discoveryId: id });
  });

  app.get("/sites/:siteId/discoveries/:id", { schema: { params: z.object({ siteId: z.uuid(), id: z.uuid() }) } }, async (request) => {
    const context = await requireOrg(request);
    const [row] = await db().select().from(formDiscoveries).where(and(eq(formDiscoveries.id, request.params.id), eq(formDiscoveries.organizationId, context.organizationId), eq(formDiscoveries.siteId, request.params.siteId)));
    if (!row) throw new AppError("NOT_FOUND", "That discovery does not exist.");
    return { status: row.status, proposal: row.proposal, errorDetail: row.errorDetail };
  });

  app.get("/sites/:siteId/destinations", { schema: { params: siteParams } }, async (request) => {
    const context = await requireOrg(request);
    const site = await loadSite(context, request.params.siteId);
    const rows = await db().select().from(destinations).where(and(eq(destinations.siteId, site.id), isNull(destinations.deletedAt)));
    return { destinations: rows.map(destinationView) };
  });

  app.post("/sites/:siteId/destinations", { schema: { params: siteParams, body: destinationBody } }, async (request, reply) => {
    const context = await requireOrg(request, "site:edit");
    const site = await loadSite(context, request.params.siteId);
    const body = request.body;
    if (body.type === "mailpit" && (isProduction() && !site.fixtureSlot)) {
      throw new AppError("INVALID_INPUT", "The local test inbox is only for controlled sample sites.");
    }
    const id = newId();
    await db().transaction(async (tx) => {
      await tx.update(destinations).set({ deletedAt: new Date() }).where(and(eq(destinations.siteId, site.id), isNull(destinations.deletedAt)));
      let credentialId: string | null = null;
      if (body.type === "imap") {
        credentialId = newId();
        await tx.insert(secrets).values({ id: credentialId, organizationId: context.organizationId, keyAlias: `destination:${id}`, ciphertext: encryptSecret(body.password) });
      }
      const webhookSecret = body.type === "webhook" ? randomBytes(32).toString("hex") : null;
      if (webhookSecret) {
        credentialId = newId();
        await tx.insert(secrets).values({ id: credentialId, organizationId: context.organizationId, keyAlias: `webhook:${id}`, ciphertext: encryptSecret(webhookSecret) });
      }
      await tx.insert(destinations).values({
        id,
        organizationId: context.organizationId,
        siteId: site.id,
        type: body.type,
        displayName: body.displayName,
        host: body.type === "imap" ? body.host : null,
        port: body.type === "imap" ? body.port : null,
        encryptedCredentialId: credentialId,
        settings:
          body.type === "imap"
            ? { user: body.user, folder: body.folder, secure: body.port !== 143 }
            : body.type === "mailpit" && site.fixtureSlot
              ? { expectedRecipient: fixtureRecipient(site.fixtureSlot as FixtureSlot) }
              : {},
      });
      await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "destination", entityId: id, action: "destination.created", safeMetadata: { type: body.type } }, tx);
      if (webhookSecret) (request as unknown as { webhookSecret?: string }).webhookSecret = webhookSecret;
    });
    return reply.status(201).send({ id, signingSecret: (request as unknown as { webhookSecret?: string }).webhookSecret });
  });

  app.post("/destinations/:id/test", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } }, schema: { params: idParams } }, async (request) => {
    const context = await requireOrg(request, "site:edit");
    const [destination] = await db().select().from(destinations).where(and(eq(destinations.id, request.params.id), eq(destinations.organizationId, context.organizationId), isNull(destinations.deletedAt)));
    if (!destination) throw new AppError("NOT_FOUND", "That destination does not exist.");
    const verifier = await verifierFor(destination);
    const check = await verifier.validateConnection();
    await db()
      .update(destinations)
      .set(check.ok ? { status: "connected", lastVerifiedAt: new Date(), lastError: null, updatedAt: new Date() } : { status: check.errorCode === "auth_rejected" ? "expired" : "error", lastError: check.errorCode, updatedAt: new Date() })
      .where(eq(destinations.id, destination.id));
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "destination", entityId: destination.id, action: check.ok ? "destination.test_passed" : "destination.test_failed" });
    return check;
  });

  app.delete("/destinations/:id", { schema: { params: idParams } }, async (request) => {
    const context = await requireOrg(request, "secret:manage");
    const [destination] = await db().select().from(destinations).where(and(eq(destinations.id, request.params.id), eq(destinations.organizationId, context.organizationId)));
    if (!destination) throw new AppError("NOT_FOUND", "That destination does not exist.");
    await db().update(destinations).set({ deletedAt: new Date(), status: "needs_setup" }).where(eq(destinations.id, destination.id));
    if (destination.encryptedCredentialId) await db().delete(secrets).where(eq(secrets.id, destination.encryptedCredentialId));
    await db().delete(inboundReceipts).where(eq(inboundReceipts.destinationId, destination.id));
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "destination", entityId: destination.id, action: "destination.disconnected" });
    return { ok: true };
  });

  app.post(
    "/sites/:siteId/repository/connect",
    {
      schema: {
        params: siteParams,
        body: z.discriminatedUnion("provider", [
          z.object({ provider: z.literal("controlled_fixture"), }),
          z.object({ provider: z.literal("github"), repoSlug: z.string().regex(/^[\w.-]+\/[\w.-]+$/), baseBranch: z.string().min(1).max(120).default("main"), installationId: z.string().regex(/^\d+$/), approvedPaths: z.array(z.string().min(1).max(200)).min(1).max(20).default(["src"]), buildProfile: z.string().max(40).default("next-pnpm") }),
        ]),
      },
    },
    async (request, reply) => {
      const context = await requireOrg(request, "secret:manage");
      const site = await loadSite(context, request.params.siteId);
      const body = request.body;
      await db().update(sourceConnections).set({ deletedAt: new Date() }).where(and(eq(sourceConnections.siteId, site.id), isNull(sourceConnections.deletedAt)));
      const id = newId();
      if (body.provider === "controlled_fixture") {
        if (!site.fixtureSlot || !FIXTURES[site.fixtureSlot as FixtureSlot].repairable) {
          throw new AppError("INVALID_INPUT", "Only the repairable sample site has a controlled repository.");
        }
        await db().insert(sourceConnections).values({
          id,
          organizationId: context.organizationId,
          siteId: site.id,
          provider: "local_upload",
          repoSlug: "fixtures/enquiry-site",
          baseBranch: "main",
          storageRef: `fixture:${site.fixtureSlot}`,
          isControlledFixture: true,
          approvedPaths: ["src"],
          previewEnv: { ENQUIRY_NOTIFY_ADDRESS: "enquiries@preview.acme-demo.test", NOTIFY_FROM: "website@preview.acme-demo.test", FIXTURE_ENV_LABEL: "Private preview" },
          status: "needs_setup",
        });
        await refreshFixtureRepository(id);
      } else {
        assertGithubConfigured();
        const profile = BUILD_PROFILES[body.buildProfile];
        if (!profile) throw new AppError("INVALID_INPUT", "That build preset is not supported.");
        const token = await installationToken(body.installationId);
        const sha = await headSha(token, body.repoSlug, body.baseBranch);
        await db().insert(sourceConnections).values({
          id,
          organizationId: context.organizationId,
          siteId: site.id,
          provider: "github",
          repoSlug: body.repoSlug,
          baseBranch: body.baseBranch,
          baseCommitSha: sha,
          installationId: body.installationId,
          approvedPaths: body.approvedPaths,
          buildProfile: body.buildProfile,
          packageManager: profile.packageManager,
          status: "needs_setup",
        });
        await initRepositoryFromUpload(id, await downloadTarball(token, body.repoSlug, sha), 1);
        await db().update(sourceConnections).set({ baseCommitSha: sha, status: "connected", lastValidatedAt: new Date() }).where(eq(sourceConnections.id, id));
      }
      await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "repository", entityId: id, action: "repository.connected", safeMetadata: { provider: body.provider } });
      return reply.status(201).send({ id });
    },
  );

  await app.register(async (upload) => {
    upload.addContentTypeParser(["application/gzip", "application/x-gzip", "application/octet-stream"], { parseAs: "buffer", bodyLimit: 48 * 1024 * 1024 }, (_request, body, done) => done(null, body));
    upload.withTypeProvider<ZodTypeProvider>().post(
      "/sites/:siteId/repository/upload",
      {
        config: { rateLimit: { max: 6, timeWindow: "10 minutes" } },
        schema: { params: siteParams, querystring: z.object({ approvedPaths: z.string().max(400).default("src"), buildProfile: z.string().max(40).default("next-pnpm"), repoName: z.string().max(120).default("uploaded-source") }) },
      },
      async (request, reply) => {
        const context = await requireOrg(request, "secret:manage");
        const site = await loadSite(context, request.params.siteId);
        const profile = BUILD_PROFILES[request.query.buildProfile];
        if (!profile) throw new AppError("INVALID_INPUT", "That build preset is not supported.");
        const archive = request.body as Buffer;
        await db().update(sourceConnections).set({ deletedAt: new Date() }).where(and(eq(sourceConnections.siteId, site.id), isNull(sourceConnections.deletedAt)));
        const id = newId();
        await db().insert(sourceConnections).values({
          id,
          organizationId: context.organizationId,
          siteId: site.id,
          provider: "local_upload",
          repoSlug: request.query.repoName,
          approvedPaths: request.query.approvedPaths.split(",").map((path) => path.trim()).filter(Boolean),
          buildProfile: request.query.buildProfile,
          packageManager: profile.packageManager,
          status: "needs_setup",
        });
        const sha = await initRepositoryFromUpload(id, archive, 0);
        await db().update(sourceConnections).set({ baseCommitSha: sha, status: "connected", lastValidatedAt: new Date() }).where(eq(sourceConnections.id, id));
        await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "repository", entityId: id, action: "repository.uploaded", safeMetadata: { bytes: archive.length } });
        return reply.status(201).send({ id, baseCommitSha: sha });
      },
    );
  });

  app.post("/sites/:siteId/repository/validate", { schema: { params: siteParams } }, async (request) => {
    const context = await requireOrg(request, "site:edit");
    const site = await loadSite(context, request.params.siteId);
    const [connection] = await db().select().from(sourceConnections).where(and(eq(sourceConnections.siteId, site.id), isNull(sourceConnections.deletedAt))).limit(1);
    if (!connection) throw new AppError("REPOSITORY_REQUIRED", "Connect a repository first.");
    if (connection.isControlledFixture) await refreshFixtureRepository(connection.id);
    return validateRepository(connection.id);
  });

  app.delete("/sites/:siteId/repository", { schema: { params: siteParams } }, async (request) => {
    const context = await requireOrg(request, "secret:manage");
    const site = await loadSite(context, request.params.siteId);
    await db().update(sourceConnections).set({ deletedAt: new Date(), status: "needs_setup" }).where(and(eq(sourceConnections.siteId, site.id), isNull(sourceConnections.deletedAt)));
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "repository", entityId: site.id, action: "repository.disconnected" });
    return { ok: true };
  });

  app.get("/sites/:siteId/schedule", { schema: { params: siteParams } }, async (request) => {
    const context = await requireOrg(request);
    const site = await loadSite(context, request.params.siteId);
    const [schedule] = await db().select().from(schedules).where(eq(schedules.siteId, site.id));
    return schedule ? scheduleView(schedule) : null;
  });

  app.patch(
    "/sites/:siteId/schedule",
    { schema: { params: siteParams, body: z.object({ mode: z.enum(["off", "hourly", "six_hours", "daily", "custom"]), intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(10_080).optional(), timezone: z.string().max(64).optional() }) } },
    async (request) => {
      const context = await requireOrg(request, "site:edit");
      const site = await loadSite(context, request.params.siteId);
      const { mode, intervalMinutes, timezone } = request.body;
      const interval = intervalForMode(mode, intervalMinutes);
      if (mode === "custom" && !interval) throw new AppError("INVALID_INPUT", `Custom intervals must be at least ${MIN_INTERVAL_MINUTES} minutes.`);
      const now = new Date();
      const values = { enabled: mode !== "off", mode, intervalMinutes: mode === "custom" ? intervalMinutes : null, timezone: timezone ?? context.organization.timezone, nextRunAt: interval ? nextRunFrom(now, interval) : null, paused: false, updatedBy: context.user.id, updatedAt: now };
      await db().insert(schedules).values({ id: newId(), siteId: site.id, ...values }).onConflictDoUpdate({ target: schedules.siteId, set: values });
      await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "schedule", entityId: site.id, action: "schedule.updated", safeMetadata: { mode, intervalMinutes } });
      return { ok: true };
    },
  );

  app.post("/sites/:siteId/pause", { schema: { params: siteParams, body: z.object({ paused: z.boolean() }) } }, async (request) => {
    const context = await requireOrg(request, "site:edit");
    const site = await loadSite(context, request.params.siteId);
    await db().update(schedules).set({ paused: request.body.paused, updatedBy: context.user.id, updatedAt: new Date() }).where(eq(schedules.siteId, site.id));
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "schedule", entityId: site.id, action: request.body.paused ? "schedule.paused" : "schedule.resumed" });
    return { ok: true };
  });

  app.get("/sites/:siteId/stats", { schema: { params: siteParams } }, async (request) => {
    const context = await requireOrg(request);
    const site = await loadSite(context, request.params.siteId);
    const rows = await db().select({ result: checkRuns.result, value: count() }).from(checkRuns).where(eq(checkRuns.siteId, site.id)).groupBy(checkRuns.result);
    return { results: rows };
  });

  app.get("/setup/fixtures", async (request) => {
    await requireOrg(request);
    if (!fixturesEnabled()) return { fixtures: [] };
    const config = env();
    return {
      fixtures: [
        { slot: "healthy", name: "Acme Demo (working form)", url: `${config.FIXTURE_SITE_URL}/contact`, label: FIXTURES.healthy.label, repairable: false },
        { slot: "broken", name: "Acme Demo (missing notification)", url: `${config.FIXTURE_BROKEN_SITE_URL}/contact`, label: FIXTURES.broken.label, repairable: true },
      ],
      githubConfigured: githubConfigured(),
    };
  });
};

function scheduleView(row: typeof schedules.$inferSelect) {
  const interval = intervalForMode(row.mode, row.intervalMinutes);
  return {
    mode: row.mode,
    intervalMinutes: row.intervalMinutes,
    timezone: row.timezone,
    enabled: row.enabled,
    paused: row.paused,
    nextRunAt: row.enabled && !row.paused ? row.nextRunAt : null,
    lastRunAt: row.lastRunAt,
    maxDailyRuns: row.maxDailyRuns,
    dailyRunEstimate: dailyRunEstimate(interval),
  };
}

export async function extractArchive(archive: Buffer, stripComponents: number): Promise<{ directory: string; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "inlet-upload-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("tar", ["-xz", "--no-same-owner", "--no-same-permissions", `--strip-components=${stripComponents}`, "-C", directory], { stdio: ["pipe", "ignore", "pipe"] });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new AppError("INVALID_INPUT", "That file is not a valid .tar.gz archive."))));
      child.stdin.on("error", () => undefined);
      child.stdin.end(archive);
    });
    return { directory, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
