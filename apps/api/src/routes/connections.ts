import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { fetchCatalog, selectAgentModel, VultrInferenceClient } from "@inlet/agent";
import { env, fixturesEnabled, githubConfigured, inferenceConfigured } from "@inlet/config";
import { audit, enqueue } from "@inlet/control";
import { and, db, destinations, eq, isNull, notificationPreferences, sites, sourceConnections } from "@inlet/database";
import { AppError, newId } from "@inlet/domain";
import { fixtureState, resetFixture } from "@inlet/integrations";
import { requireOrg } from "../plumbing/auth";

const preferencesBody = z.object({
  email: z.email().nullable().optional(),
  notifyFailure: z.boolean().optional(),
  notifyRecovery: z.boolean().optional(),
  notifyActionRequired: z.boolean().optional(),
  notifyConnectionExpired: z.boolean().optional(),
  dailyDigest: z.boolean().optional(),
  dedupWindowMinutes: z.number().int().min(15).max(10_080).optional(),
  quietHoursStart: z.number().int().min(0).max(23).nullable().optional(),
  quietHoursEnd: z.number().int().min(0).max(23).nullable().optional(),
});

export const connectionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/connections", async (request) => {
    const context = await requireOrg(request);
    const orgId = context.organizationId;
    const siteRows = await db().select().from(sites).where(and(eq(sites.organizationId, orgId), isNull(sites.archivedAt)));
    const destinationRows = await db().select().from(destinations).where(and(eq(destinations.organizationId, orgId), isNull(destinations.deletedAt)));
    const repositoryRows = await db().select().from(sourceConnections).where(and(eq(sourceConnections.organizationId, orgId), isNull(sourceConnections.deletedAt)));
    const [preferences] = await db().select().from(notificationPreferences).where(eq(notificationPreferences.organizationId, orgId));
    const name = new Map(siteRows.map((site) => [site.id, site.name]));
    return {
      ownership: siteRows.map((site) => ({ siteId: site.id, name: site.name, status: site.verificationStatus === "verified" ? "connected" : site.verificationStatus === "expired" ? "expired" : "needs_setup", method: site.verificationMethod, lastVerifiedAt: site.verifiedAt, detail: site.verificationLastError })),
      destinations: destinationRows.map((row) => ({ id: row.id, siteId: row.siteId, siteName: name.get(row.siteId), type: row.type, displayName: row.displayName, status: row.status, lastVerifiedAt: row.lastVerifiedAt, lastError: row.lastError })),
      repositories: repositoryRows.map((row) => ({ id: row.id, siteId: row.siteId, siteName: name.get(row.siteId), provider: row.provider, repoSlug: row.repoSlug, status: row.status, lastValidatedAt: row.lastValidatedAt, lastError: row.lastError, isControlledFixture: row.isControlledFixture })),
      inference: { configured: inferenceConfigured(), modelOverride: env().VULTR_INFERENCE_MODEL ?? null, baseUrl: env().VULTR_INFERENCE_BASE_URL },
      github: { configured: githubConfigured() },
      notifications: { recipient: preferences?.email ?? context.user.email, configured: Boolean(env().NOTIFY_SMTP_HOST) },
    };
  });

  app.post("/connections/inference/test", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (request) => {
    await requireOrg(request, "secret:manage");
    const catalog = await fetchCatalog().catch(() => null);
    if (!catalog) return { ok: false, detail: "The live model catalog could not be reached." };
    const model = selectAgentModel(catalog, env().VULTR_INFERENCE_MODEL);
    if (!model) return { ok: false, detail: "No tool-capable model was found in the live catalog." };
    if (!inferenceConfigured()) return { ok: false, model: model.id, detail: `The catalog is reachable and ${model.id} would be used, but VULTR_INFERENCE_API_KEY is not set.` };
    try {
      const client = new VultrInferenceClient(model.id);
      const result = await client.chat({
        messages: [{ role: "user", content: "Call the ping tool." }],
        tools: [{ type: "function", function: { name: "ping", description: "Connectivity check", parameters: { type: "object", properties: {} } } }],
        toolChoice: "required",
        maxTokens: 60,
      });
      const called = (result.message.tool_calls ?? []).some((call) => call.function.name === "ping");
      return { ok: called, model: model.id, durationMs: result.durationMs, detail: called ? `${model.id} answered and called a tool.` : `${model.id} answered but did not call the tool.` };
    } catch (error) {
      return { ok: false, model: model.id, detail: error instanceof Error ? error.message : "Inference failed." };
    }
  });

  app.get("/notifications/preferences", async (request) => {
    const context = await requireOrg(request);
    const [row] = await db().select().from(notificationPreferences).where(eq(notificationPreferences.organizationId, context.organizationId));
    return { defaultEmail: context.user.email, preferences: row ?? null };
  });

  app.patch("/notifications/preferences", { schema: { body: preferencesBody } }, async (request) => {
    const context = await requireOrg(request, "site:edit");
    await db()
      .insert(notificationPreferences)
      .values({ organizationId: context.organizationId, ...request.body })
      .onConflictDoUpdate({ target: notificationPreferences.organizationId, set: { ...request.body, updatedAt: new Date() } });
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "notifications", entityId: context.organizationId, action: "notifications.updated" });
    return { ok: true };
  });

  app.post("/notifications/test", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const context = await requireOrg(request, "site:edit");
    await enqueue("notifications", context.organizationId, { kind: "test", organizationId: context.organizationId });
    return reply.status(202).send({ ok: true });
  });

  app.get("/fixture/state", async (request) => {
    await requireOrg(request);
    if (!fixturesEnabled()) throw new AppError("NOT_FOUND", "Not found.");
    return (await fixtureState()) ?? { slots: [], deploying: false, unavailable: true };
  });

  app.post("/fixture/reset", async (request) => {
    const context = await requireOrg(request, "site:edit");
    if (!fixturesEnabled()) throw new AppError("NOT_FOUND", "Not found.");
    const result = await resetFixture();
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "fixture", entityId: newId(), action: "fixture.reset", safeMetadata: result });
    return result;
  });
};
