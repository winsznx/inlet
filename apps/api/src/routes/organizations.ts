import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "@inlet/config";
import { audit } from "@inlet/control";
import { and, auditEvents, checkRuns, db, deletePrefixFor, desc, eq, gt, incidents, invitations, isNull, lt, memberships, notifications, organizations, patches, sessions, sites, users } from "../plumbing/db";
import { AppError, newId, ROLES } from "@inlet/domain";
import { deletePrefix } from "@inlet/evidence";
import { sendProductEmail } from "@inlet/integrations";
import { hashToken, randomToken, requireAuth, requireOrg, requireOrgById } from "../plumbing/auth";

const orgParams = z.object({ id: z.uuid() });
const assignableRoles = z.enum(ROLES).exclude(["owner"]);

export const organizationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/organizations", async (request) => {
    const auth = requireAuth(request);
    const rows = await db()
      .select({ id: organizations.id, name: organizations.name, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(and(eq(memberships.userId, auth.user.id), eq(organizations.isDemo, false)));
    return { organizations: rows };
  });

  app.post(
    "/organizations",
    { schema: { body: z.object({ name: z.string().trim().min(2).max(80), timezone: z.string().max(64).default("UTC") }) } },
    async (request, reply) => {
      const auth = requireAuth(request);
      const id = newId();
      await db().transaction(async (tx) => {
        await tx.insert(organizations).values({ id, name: request.body.name, ownerUserId: auth.user.id, timezone: request.body.timezone });
        await tx.insert(memberships).values({ id: newId(), organizationId: id, userId: auth.user.id, role: "owner", inviteAcceptedAt: new Date() });
        await tx.update(sessions).set({ activeOrganizationId: id }).where(eq(sessions.id, auth.sessionId));
        await audit({ organizationId: id, actorUserId: auth.user.id, entityType: "workspace", entityId: id, action: "workspace.created" }, tx);
      });
      return reply.status(201).send({ id });
    },
  );

  app.get("/organizations/:id", { schema: { params: orgParams } }, async (request) => {
    const context = await requireOrgById(request, request.params.id);
    const { organization, role } = context;
    return {
      id: organization.id,
      name: organization.name,
      timezone: organization.timezone,
      retentionDays: organization.retentionDays,
      maintainersMayApprove: organization.maintainersMayApprove,
      role,
    };
  });

  app.patch(
    "/organizations/:id",
    {
      schema: {
        params: orgParams,
        body: z.object({
          name: z.string().trim().min(2).max(80).optional(),
          timezone: z.string().max(64).optional(),
          retentionDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
          maintainersMayApprove: z.boolean().optional(),
        }),
      },
    },
    async (request) => {
      const context = await requireOrgById(request, request.params.id, "member:manage");
      await db().update(organizations).set({ ...request.body, updatedAt: new Date() }).where(eq(organizations.id, context.organizationId));
      await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "workspace", entityId: context.organizationId, action: "workspace.updated", safeMetadata: request.body });
      return { ok: true };
    },
  );

  app.delete(
    "/organizations/:id",
    { schema: { params: orgParams, body: z.object({ confirmName: z.string(), confirmPhrase: z.literal("delete this workspace") }) } },
    async (request) => {
      const context = await requireOrgById(request, request.params.id, "workspace:delete");
      if (request.body.confirmName !== context.organization.name) {
        throw new AppError("INVALID_INPUT", "The workspace name did not match.");
      }
      await db().delete(organizations).where(eq(organizations.id, context.organizationId));
      await deletePrefix(deletePrefixFor(context.organizationId));
      return { ok: true };
    },
  );

  app.get("/organizations/:id/export", { schema: { params: orgParams } }, async (request, reply) => {
    const context = await requireOrgById(request, request.params.id, "member:manage");
    const orgId = context.organizationId;
    const [siteRows, runRows, incidentRows, patchRows, auditRows] = await Promise.all([
      db().select({ id: sites.id, name: sites.name, formUrl: sites.formUrl, createdAt: sites.createdAt }).from(sites).where(eq(sites.organizationId, orgId)),
      db().select({ id: checkRuns.id, siteId: checkRuns.siteId, result: checkRuns.result, trigger: checkRuns.trigger, startedAt: checkRuns.startedAt, completedAt: checkRuns.completedAt }).from(checkRuns).where(eq(checkRuns.organizationId, orgId)),
      db().select({ id: incidents.id, siteId: incidents.siteId, state: incidents.state, createdAt: incidents.createdAt }).from(incidents).where(eq(incidents.organizationId, orgId)),
      db().select({ id: patches.id, incidentId: patches.incidentId, status: patches.status, diffText: patches.diffText }).from(patches).where(eq(patches.organizationId, orgId)),
      db().select().from(auditEvents).where(eq(auditEvents.organizationId, orgId)),
    ]);
    await audit({ organizationId: orgId, actorUserId: context.user.id, entityType: "workspace", entityId: orgId, action: "workspace.exported" });
    reply.header("content-type", "application/json");
    reply.header("content-disposition", 'attachment; filename="inlet-workspace-export.json"');
    return reply.send(JSON.stringify({ exportedAt: new Date(), sites: siteRows, runs: runRows, incidents: incidentRows, patches: patchRows, audit: auditRows }, null, 2));
  });

  app.get("/organizations/:id/members", { schema: { params: orgParams } }, async (request) => {
    const context = await requireOrgById(request, request.params.id);
    const rows = await db()
      .select({ id: memberships.id, role: memberships.role, userId: users.id, name: users.name, email: users.email, createdAt: memberships.createdAt })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.organizationId, context.organizationId));
    const pending = await db()
      .select({ id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt, createdAt: invitations.createdAt })
      .from(invitations)
      .where(and(eq(invitations.organizationId, context.organizationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())));
    return { members: rows, invitations: pending };
  });

  app.post(
    "/organizations/:id/invitations",
    { schema: { params: orgParams, body: z.object({ email: z.email().transform((value) => value.toLowerCase()), role: assignableRoles }) } },
    async (request, reply) => {
      const context = await requireOrgById(request, request.params.id, "member:manage");
      const token = randomToken();
      const id = newId();
      await db().insert(invitations).values({
        id,
        organizationId: context.organizationId,
        email: request.body.email,
        role: request.body.role,
        inviteTokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        invitedBy: context.user.id,
      });
      await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "invitation", entityId: id, action: "member.invited", safeMetadata: { role: request.body.role } });
      const link = `${env().NEXT_PUBLIC_APP_URL}/register?invite=${token}&email=${encodeURIComponent(request.body.email)}`;
      const emailSent = await sendProductEmail({
        to: request.body.email,
        subject: `Join ${context.organization.name} on Inlet`,
        text: `${context.user.name} invited you to ${context.organization.name} as ${request.body.role}. Accept within 7 days: ${link}`,
      }).then(
        () => true,
        (error: unknown) => {
          request.log.error({ err: error }, "invite email failed");
          return false;
        },
      );
      return reply.status(201).send({ id, emailSent });
    },
  );

  app.delete("/invitations/:id", { schema: { params: orgParams } }, async (request) => {
    const context = await requireOrg(request, "member:manage");
    await db()
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.id, request.params.id), eq(invitations.organizationId, context.organizationId)));
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "invitation", entityId: request.params.id, action: "member.invite_revoked" });
    return { ok: true };
  });

  app.patch("/members/:id", { schema: { params: orgParams, body: z.object({ role: assignableRoles }) } }, async (request) => {
    const context = await requireOrg(request, "member:manage");
    const [member] = await db().select().from(memberships).where(and(eq(memberships.id, request.params.id), eq(memberships.organizationId, context.organizationId)));
    if (!member) throw new AppError("NOT_FOUND", "That member does not exist.");
    if (member.role === "owner") throw new AppError("FORBIDDEN", "The workspace owner's role cannot be changed here.");
    await db().update(memberships).set({ role: request.body.role }).where(eq(memberships.id, member.id));
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "member", entityId: member.userId, action: "member.role_changed", safeMetadata: { role: request.body.role } });
    return { ok: true };
  });

  app.delete("/members/:id", { schema: { params: orgParams } }, async (request) => {
    const context = await requireOrg(request, "member:manage");
    const [member] = await db().select().from(memberships).where(and(eq(memberships.id, request.params.id), eq(memberships.organizationId, context.organizationId)));
    if (!member) throw new AppError("NOT_FOUND", "That member does not exist.");
    if (member.role === "owner") throw new AppError("FORBIDDEN", "The workspace owner cannot be removed.");
    await db().delete(memberships).where(eq(memberships.id, member.id));
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "member", entityId: member.userId, action: "member.removed" });
    return { ok: true };
  });

  app.get(
    "/activity",
    { schema: { querystring: z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) } },
    async (request) => {
      const context = await requireOrg(request);
      const { cursor, limit } = request.query;
      const rows = await db()
        .select({ id: auditEvents.id, action: auditEvents.action, entityType: auditEvents.entityType, entityId: auditEvents.entityId, actorKind: auditEvents.actorKind, actorName: users.name, createdAt: auditEvents.createdAt, metadata: auditEvents.safeMetadata })
        .from(auditEvents)
        .leftJoin(users, eq(auditEvents.actorUserId, users.id))
        .where(and(eq(auditEvents.organizationId, context.organizationId), cursor ? lt(auditEvents.id, cursor) : undefined))
        .orderBy(desc(auditEvents.id))
        .limit(limit + 1);
      return { events: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]?.id : null };
    },
  );

  app.get("/notifications", async (request) => {
    const context = await requireOrg(request);
    const rows = await db()
      .select()
      .from(notifications)
      .where(eq(notifications.organizationId, context.organizationId))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    return { notifications: rows };
  });
};
