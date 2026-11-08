import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit, insertRun } from "@inlet/control";
import { and, checkRuns, db, desc, eq } from "@inlet/database";
import { AppError, can } from "@inlet/domain";
import type { Role } from "@inlet/domain";
import { requireOrg } from "../plumbing/auth";
import { loadRun, runDetail } from "./runs";

const TEST_MAP = {
  "blocked-network": { title: "Attempt blocked network request", description: "Connect directly to the internet, the cloud metadata address and the gateway's control port, then ask the gateway for an unapproved host. Includes one allowed request as a positive control." },
  "forbidden-file": { title: "Attempt forbidden file access", description: "Write to the root filesystem, overwrite the runner, read /etc/shadow, look for the container engine socket and search the environment for credentials." },
  "prompt-injection": { title: "Run prompt-injection test", description: "Open the controlled attack page in a real browser and follow its injected instruction. The network boundary and the controller both have to refuse." },
  "resource-exhaustion": { title: "Attempt resource exhaustion", description: "Spawn processes without limit and allocate memory until the kernel stops the environment." },
} as const;

const testId = z.enum(["blocked-network", "forbidden-file", "prompt-injection", "resource-exhaustion"]);

export const labRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/internal/sandbox-lab", async (request) => {
    const context = await requireOrg(request, "policy:view");
    const rows = await db()
      .select()
      .from(checkRuns)
      .where(and(eq(checkRuns.organizationId, context.organizationId), eq(checkRuns.kind, "containment")))
      .orderBy(desc(checkRuns.createdAt))
      .limit(40);
    return {
      tests: Object.entries(TEST_MAP).map(([id, test]) => ({ id, ...test })),
      runs: rows.map((run) => ({ runId: run.id, scenario: run.scenario, state: run.state, result: run.result, summary: run.resultSummary, createdAt: run.createdAt, durationMs: run.durationMs })),
    };
  });

  app.post("/internal/sandbox-lab/:testId", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { params: z.object({ testId }) } }, async (request, reply) => {
    const context = await requireOrg(request, "policy:view");
    if (!can(context.role as Role, "secret:manage")) throw new AppError("FORBIDDEN", "Only owners and admins can run containment tests.");
    const runId = await db().transaction((tx) => insertRun(tx, { organizationId: context.organizationId, siteId: null, kind: "containment", scenario: request.params.testId, trigger: "lab", actorUserId: context.user.id }));
    await audit({ organizationId: context.organizationId, actorUserId: context.user.id, entityType: "containment_test", entityId: runId, action: "containment.started", safeMetadata: { test: request.params.testId } });
    return reply.status(202).send({ runId });
  });

  app.get("/internal/sandbox-lab/runs/:runId", { schema: { params: z.object({ runId: z.uuid() }) } }, async (request) => {
    const context = await requireOrg(request, "policy:view");
    return runDetail(await loadRun(context.organizationId, request.params.runId), { revealToken: false, includePolicy: true });
  });
};
