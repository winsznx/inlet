import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env, isProduction } from "@inlet/config";
import { and, db, eq, gt, isNull, memberships, organizations, sessions, users } from "@inlet/database";
import { AppError, can, newId } from "@inlet/domain";
import type { Permission, Role } from "@inlet/domain";

export const SESSION_COOKIE = "inlet_session";
const SESSION_TTL_MS = 14 * 86_400_000;

export type AuthContext = {
  sessionId: string;
  user: typeof users.$inferSelect;
  activeOrganizationId: string | null;
};

export type OrgContext = AuthContext & {
  organization: typeof organizations.$inferSelect;
  organizationId: string;
  role: Role;
};

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function cookieOptions(): { path: string; httpOnly: boolean; sameSite: "lax"; secure: boolean; maxAge: number } {
  return { path: "/", httpOnly: true, sameSite: "lax", secure: isProduction(), maxAge: SESSION_TTL_MS / 1000 };
}

export async function createSession(reply: FastifyReply, request: FastifyRequest, userId: string): Promise<void> {
  const token = randomToken();
  const [membership] = await db().select({ organizationId: memberships.organizationId }).from(memberships).where(eq(memberships.userId, userId)).limit(1);
  await db().insert(sessions).values({
    id: newId(),
    userId,
    tokenHash: hashToken(token),
    activeOrganizationId: membership?.organizationId ?? null,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    userAgent: request.headers["user-agent"]?.slice(0, 200),
  });
  reply.setCookie(SESSION_COOKIE, token, cookieOptions());
}

export async function resolveAuth(request: FastifyRequest): Promise<AuthContext | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const [row] = await db()
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date()), isNull(sessions.revokedAt), isNull(users.disabledAt)));
  if (!row) return null;
  if (Date.now() - row.session.lastSeenAt.getTime() > 60_000) {
    await db().update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.session.id));
  }
  return { sessionId: row.session.id, user: row.user, activeOrganizationId: row.session.activeOrganizationId };
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new AppError("UNAUTHENTICATED", "Please sign in to continue.");
  return request.auth;
}

export async function requireOrg(request: FastifyRequest, permission?: Permission): Promise<OrgContext> {
  const auth = requireAuth(request);
  if (!auth.activeOrganizationId) {
    throw new AppError("NOT_FOUND", "Create a workspace to continue.", { nextAction: "Create a workspace." });
  }
  return requireOrgById(request, auth.activeOrganizationId, permission);
}

export async function requireOrgById(request: FastifyRequest, organizationId: string, permission?: Permission): Promise<OrgContext> {
  const auth = requireAuth(request);
  const [row] = await db()
    .select({ membership: memberships, organization: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(and(eq(memberships.userId, auth.user.id), eq(memberships.organizationId, organizationId)));
  if (!row) throw new AppError("NOT_FOUND", "That workspace does not exist.");
  const { role } = row.membership;
  if (permission && !can(role, permission, { maintainerMayApprove: row.organization.maintainersMayApprove })) {
    throw new AppError("FORBIDDEN", "Your role does not allow this action.", {
      nextAction: "Ask a workspace owner or admin.",
    });
  }
  return { ...auth, organization: row.organization, organizationId, role };
}

export function allowedOrigins(): string[] {
  return [new URL(env().NEXT_PUBLIC_APP_URL).origin];
}

export function assertSameOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (origin) {
    if (!allowedOrigins().includes(origin)) throw new AppError("CSRF_REJECTED", "This request came from an unexpected origin.");
    return;
  }
  const site = request.headers["sec-fetch-site"];
  if (site === "same-origin" || site === "none") return;
  if (!request.cookies[SESSION_COOKIE]) return;
  throw new AppError("CSRF_REJECTED", "This request is missing its origin.");
}
