import { hash, verify } from "@node-rs/argon2";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env, githubConfigured, inferenceConfigured, isProduction } from "@inlet/config";
import { audit } from "@inlet/control";
import { and, authTokens, db, desc, eq, gt, invitations, isNull, memberships, ne, organizations, sessions, users } from "@inlet/database";
import { AppError, can, newId } from "@inlet/domain";
import type { Permission, Role } from "@inlet/domain";
import { hmacIp } from "@inlet/evidence";
import { sendProductEmail } from "@inlet/integrations";
import { createSession, hashToken, randomToken, requireAuth, requireOrgById, SESSION_COOKIE, cookieOptions } from "../plumbing/auth";

const email = z.email().max(200).transform((value) => value.toLowerCase());
const password = z.string().min(10, "Use at least 10 characters.").max(200);
const LOGIN_RATE = { rateLimit: { max: 12, timeWindow: "5 minutes" } };
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const PERMISSIONS: Permission[] = ["evidence:view", "site:edit", "run:start", "investigation:start", "patch:decide", "secret:manage", "member:manage", "workspace:delete", "policy:view"];

const DUMMY_HASH = await hash("inlet-timing-equaliser", ARGON);

async function issueAuthToken(userId: string, purpose: "password_reset" | "email_verification"): Promise<string> {
  const token = randomToken();
  await db().insert(authTokens).values({ id: newId(), userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000) });
  return token;
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/auth/register",
    { config: LOGIN_RATE, schema: { body: z.object({ email, password, name: z.string().trim().min(1).max(80), inviteToken: z.string().optional() }) } },
    async (request, reply) => {
      const { email: address, password: secret, name, inviteToken } = request.body;
      const [existing] = await db().select({ id: users.id }).from(users).where(eq(users.email, address));
      if (existing) throw new AppError("CONFLICT", "An account with that email already exists.", { nextAction: "Sign in instead." });
      const id = newId();
      await db().insert(users).values({ id, email: address, name, passwordHash: await hash(secret, ARGON), emailVerifiedAt: isProduction() ? null : new Date() });
      if (inviteToken) await acceptInvitation(id, address, inviteToken);
      if (isProduction()) {
        const token = await issueAuthToken(id, "email_verification");
        await sendProductEmail({ to: address, subject: "Confirm your Inlet email", text: `Confirm your email: ${env().NEXT_PUBLIC_APP_URL}/login?verify=${token}` });
      }
      await createSession(reply, request, id);
      return reply.status(201).send({ id });
    },
  );

  app.post("/auth/login", { config: LOGIN_RATE, schema: { body: z.object({ email, password: z.string().max(200) }) } }, async (request, reply) => {
    const [user] = await db().select().from(users).where(eq(users.email, request.body.email));
    const valid = await verify(user?.passwordHash ?? DUMMY_HASH, request.body.password);
    if (!user || !valid || user.disabledAt) throw new AppError("UNAUTHENTICATED", "That email and password don't match.");
    await createSession(reply, request, user.id);
    await audit({ organizationId: null, actorUserId: user.id, entityType: "session", entityId: user.id, action: "auth.login", ipHash: hmacIp(request.ip) });
    return { id: user.id };
  });

  app.post("/auth/logout", async (request, reply) => {
    if (request.auth) await db().update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, request.auth.sessionId));
    reply.clearCookie(SESSION_COOKIE, cookieOptions());
    return { ok: true };
  });

  app.post("/auth/forgot-password", { config: LOGIN_RATE, schema: { body: z.object({ email }) } }, async (request) => {
    const [user] = await db().select().from(users).where(eq(users.email, request.body.email));
    if (user) {
      const token = await issueAuthToken(user.id, "password_reset");
      await sendProductEmail({
        to: user.email,
        subject: "Reset your Inlet password",
        text: `Reset your password within one hour: ${env().NEXT_PUBLIC_APP_URL}/reset-password?token=${token}\n\nIf you didn't ask for this you can ignore this email.`,
      }).catch((error: unknown) => request.log.error({ err: error }, "reset email failed"));
    }
    return { ok: true };
  });

  app.post("/auth/reset-password", { config: LOGIN_RATE, schema: { body: z.object({ token: z.string().max(200), password }) } }, async (request) => {
    const now = new Date();
    const [row] = await db()
      .select()
      .from(authTokens)
      .where(and(eq(authTokens.tokenHash, hashToken(request.body.token)), eq(authTokens.purpose, "password_reset"), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)));
    if (!row) throw new AppError("INVALID_INPUT", "That reset link has expired.", { nextAction: "Request a new link." });
    await db().transaction(async (tx) => {
      await tx.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, row.id));
      await tx.update(users).set({ passwordHash: await hash(request.body.password, ARGON) }).where(eq(users.id, row.userId));
      await tx.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, row.userId), isNull(sessions.revokedAt)));
    });
    return { ok: true };
  });

  app.post("/auth/verify-email", { config: LOGIN_RATE, schema: { body: z.object({ token: z.string().max(200) }) } }, async (request) => {
    const now = new Date();
    const [row] = await db()
      .select()
      .from(authTokens)
      .where(and(eq(authTokens.tokenHash, hashToken(request.body.token)), eq(authTokens.purpose, "email_verification"), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)));
    if (!row) throw new AppError("INVALID_INPUT", "That confirmation link has expired.");
    await db().update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, row.id));
    await db().update(users).set({ emailVerifiedAt: now }).where(eq(users.id, row.userId));
    return { ok: true };
  });

  app.get("/me", async (request) => {
    const auth = requireAuth(request);
    const rows = await db()
      .select({ id: organizations.id, name: organizations.name, role: memberships.role, isDemo: organizations.isDemo })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(and(eq(memberships.userId, auth.user.id), eq(organizations.isDemo, false)));
    const activeId = rows.some((row) => row.id === auth.activeOrganizationId) ? auth.activeOrganizationId : (rows[0]?.id ?? null);
    const active = rows.find((row) => row.id === activeId);
    let permissions: Permission[] = [];
    if (active) {
      const context = await requireOrgById(request, active.id);
      permissions = PERMISSIONS.filter((item) => can(context.role as Role, item, { maintainerMayApprove: context.organization.maintainersMayApprove }));
    }
    return {
      user: { id: auth.user.id, email: auth.user.email, name: auth.user.name, emailVerified: Boolean(auth.user.emailVerifiedAt) },
      organizations: rows.map(({ id, name, role }) => ({ id, name, role })),
      activeOrganizationId: activeId,
      role: active?.role ?? null,
      permissions,
      capabilities: { inference: inferenceConfigured(), github: githubConfigured(), production: isProduction() },
    };
  });

  app.post("/me/active-organization", { schema: { body: z.object({ organizationId: z.uuid() }) } }, async (request) => {
    const context = await requireOrgById(request, request.body.organizationId);
    await db().update(sessions).set({ activeOrganizationId: context.organizationId }).where(eq(sessions.id, context.sessionId));
    return { ok: true };
  });

  app.get("/me/sessions", async (request) => {
    const auth = requireAuth(request);
    const rows = await db()
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, auth.user.id), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.lastSeenAt));
    return {
      sessions: rows.map((row) => ({ id: row.id, userAgent: row.userAgent, lastSeenAt: row.lastSeenAt, createdAt: row.createdAt, current: row.id === auth.sessionId })),
    };
  });

  app.delete("/me/sessions/:id", { schema: { params: z.object({ id: z.uuid() }) } }, async (request) => {
    const auth = requireAuth(request);
    await db().update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.id, request.params.id), eq(sessions.userId, auth.user.id)));
    return { ok: true };
  });

  app.post("/me/sessions/revoke-others", async (request) => {
    const auth = requireAuth(request);
    await db().update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, auth.user.id), ne(sessions.id, auth.sessionId)));
    return { ok: true };
  });

  app.post("/invitations/accept", { schema: { body: z.object({ token: z.string().max(200) }) } }, async (request) => {
    const auth = requireAuth(request);
    const organizationId = await acceptInvitation(auth.user.id, auth.user.email, request.body.token);
    await db().update(sessions).set({ activeOrganizationId: organizationId }).where(eq(sessions.id, auth.sessionId));
    return { organizationId };
  });
};

async function acceptInvitation(userId: string, address: string, token: string): Promise<string> {
  const now = new Date();
  const [invite] = await db()
    .select()
    .from(invitations)
    .where(and(eq(invitations.inviteTokenHash, hashToken(token)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now)));
  if (!invite) throw new AppError("INVALID_INPUT", "That invitation has expired.", { nextAction: "Ask for a new invitation." });
  if (invite.email !== address.toLowerCase()) throw new AppError("FORBIDDEN", "That invitation was sent to a different email address.");
  await db().transaction(async (tx) => {
    await tx.update(invitations).set({ acceptedAt: now }).where(eq(invitations.id, invite.id));
    await tx
      .insert(memberships)
      .values({ id: newId(), organizationId: invite.organizationId, userId, role: invite.role, inviteAcceptedAt: now })
      .onConflictDoNothing();
    await audit({ organizationId: invite.organizationId, actorUserId: userId, entityType: "member", entityId: userId, action: "member.joined", safeMetadata: { role: invite.role } }, tx);
  });
  return invite.organizationId;
}
