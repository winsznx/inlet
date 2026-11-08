import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { env } from "@inlet/config";
import { audit, startSiteCheck, transitionIncident } from "@inlet/control";
import { and, db, deployments, destinations, eq, incidents, inboundReceipts, isNull, secrets } from "@inlet/database";
import { AppError, isCorrelationToken, newId } from "@inlet/domain";
import { decryptSecret } from "@inlet/evidence";
import { hashRemoteId, verifyGithubSignature } from "@inlet/integrations";

const MAX_SKEW_MS = 5 * 60_000;
const seenDeliveries = new Map<string, number>();

function verifySignature(secret: string, timestamp: string | undefined, body: string, signature: string | undefined): void {
  if (!timestamp || !signature) throw new AppError("SIGNATURE_INVALID", "This webhook is missing its signature.");
  const skew = Math.abs(Date.now() - Number(timestamp) * 1000);
  if (!Number.isFinite(skew) || skew > MAX_SKEW_MS) throw new AppError("SIGNATURE_INVALID", "This webhook timestamp is outside the allowed window.");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const actual = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new AppError("SIGNATURE_INVALID", "This webhook signature is not valid.");
}

function rememberDelivery(key: string): void {
  const now = Date.now();
  for (const [stored, at] of seenDeliveries) if (now - at > MAX_SKEW_MS * 2) seenDeliveries.delete(stored);
  if (seenDeliveries.has(key)) throw new AppError("CONFLICT", "This webhook was already processed.");
  seenDeliveries.set(key, now);
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));

  app.post<{ Params: { destinationId: string }; Body: string }>("/webhooks/inbound/:destinationId", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request) => {
    const [destination] = await db().select().from(destinations).where(and(eq(destinations.id, request.params.destinationId), eq(destinations.type, "webhook"), isNull(destinations.deletedAt)));
    if (!destination?.encryptedCredentialId) throw new AppError("NOT_FOUND", "Not found.");
    const [secret] = await db().select().from(secrets).where(eq(secrets.id, destination.encryptedCredentialId));
    if (!secret) throw new AppError("NOT_FOUND", "Not found.");
    verifySignature(decryptSecret(secret.ciphertext), request.headers["x-inlet-timestamp"] as string | undefined, request.body, request.headers["x-inlet-signature"] as string | undefined);
    const parsed = JSON.parse(request.body) as { token?: unknown; messageId?: unknown };
    if (typeof parsed.token !== "string" || !isCorrelationToken(parsed.token) || typeof parsed.messageId !== "string") {
      throw new AppError("INVALID_INPUT", "Expected a test token and message ID.");
    }
    await db()
      .insert(inboundReceipts)
      .values({ id: newId(), destinationId: destination.id, tokenHash: createHash("sha256").update(parsed.token).digest("hex"), remoteIdHash: hashRemoteId(parsed.messageId) })
      .onConflictDoNothing();
    await db().update(destinations).set({ status: "connected", lastVerifiedAt: new Date(), lastError: null }).where(eq(destinations.id, destination.id));
    return { ok: true };
  });

  app.post<{ Body: string }>("/webhooks/github", async (request) => {
    if (!verifyGithubSignature(request.body, request.headers["x-hub-signature-256"] as string | undefined)) {
      throw new AppError("SIGNATURE_INVALID", "This webhook signature is not valid.");
    }
    rememberDelivery(`github:${String(request.headers["x-github-delivery"])}`);
    return { ok: true };
  });

  app.post<{ Body: string }>("/webhooks/deployment", async (request) => {
    const secret = env().DEPLOY_WEBHOOK_SECRET;
    if (!secret) throw new AppError("NOT_FOUND", "Not found.");
    verifySignature(secret, request.headers["x-inlet-timestamp"] as string | undefined, request.body, request.headers["x-inlet-signature"] as string | undefined);
    const body = JSON.parse(request.body) as { incidentId?: string; deploymentRef?: string; deliveryId?: string };
    if (!body.incidentId || !body.deliveryId) throw new AppError("INVALID_INPUT", "Expected incidentId and deliveryId.");
    rememberDelivery(`deployment:${body.deliveryId}`);
    const [incident] = await db().select().from(incidents).where(eq(incidents.id, body.incidentId));
    if (!incident || incident.state !== "awaiting_deployment" || !incident.currentPatchId) throw new AppError("INVALID_TRANSITION", "That incident isn't waiting for a deployment.");
    await db().insert(deployments).values({ id: newId(), incidentId: incident.id, patchId: incident.currentPatchId, environment: "production", trigger: "webhook", deploymentRef: body.deploymentRef, deployedAt: new Date(), webhookVerified: true });
    await transitionIncident(incident.id, "rechecking", { actor: "webhook", reason: "A signed deployment webhook arrived." });
    const { runId } = await startSiteCheck({ organizationId: incident.organizationId, siteId: incident.siteId, trigger: "recheck", reason: "deployment webhook", incidentId: incident.id, idempotencyKey: `webhook-${body.deliveryId}` });
    await audit({ organizationId: incident.organizationId, entityType: "deployment", entityId: incident.id, action: "deployment.webhook_received" });
    return { runId };
  });
};
