import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { inferenceConfigured, isProduction } from "@inlet/config";
import { redisHealthy } from "@inlet/control";
import { db, sql, checkRuns, count, sandboxSessions, eq, policyDecisions } from "@inlet/database";
import { AppError } from "@inlet/domain";
import { OciSandboxProvider } from "@inlet/sandbox";
import { requireOrg } from "../plumbing/auth";

async function postgresHealthy(): Promise<boolean> {
  try {
    await db().execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/health/live", { config: { rateLimit: false } }, async () => ({ status: "ok" }));

  app.get("/health/ready", { config: { rateLimit: false } }, async (_request, reply) => {
    const [database, redis, sandbox] = await Promise.all([postgresHealthy(), redisHealthy(), new OciSandboxProvider().checkReady()]);
    const ready = database && redis && sandbox.ready;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? "ready" : "degraded",
      checks: { database, queue: redis, sandbox: sandbox.ready, inferenceConfigured: inferenceConfigured() },
      detail: isProduction() ? undefined : sandbox.detail,
    });
  });

  app.get("/internal/metrics", async (request, reply) => {
    await requireOrg(request, "policy:view").catch(() => {
      throw new AppError("NOT_FOUND", "Not found.");
    });
    const runs = await db().select({ result: checkRuns.result, value: count() }).from(checkRuns).groupBy(checkRuns.result);
    const [denials] = await db().select({ value: count() }).from(policyDecisions).where(eq(policyDecisions.allowed, false));
    const [destroyed] = await db().select({ value: count() }).from(sandboxSessions).where(eq(sandboxSessions.cleanupVerified, true));
    const [unclean] = await db().select({ value: count() }).from(sandboxSessions).where(eq(sandboxSessions.cleanupVerified, false));
    const lines = [
      ...runs.map((row) => `inlet_check_runs_total{result="${row.result ?? "active"}"} ${row.value}`),
      `inlet_blocked_actions_total ${denials?.value ?? 0}`,
      `inlet_sandbox_destructions_total ${destroyed?.value ?? 0}`,
      `inlet_sandbox_pending_cleanup ${unclean?.value ?? 0}`,
    ];
    reply.header("content-type", "text/plain; version=0.0.4");
    return reply.send(`${lines.join("\n")}\n`);
  });
};
