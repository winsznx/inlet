import { Queue, Worker } from "bullmq";
import type { Job } from "bullmq";
import { env } from "@inlet/config";
import { JOB_TYPES, redisConnection } from "@inlet/control";
import type { JobType } from "@inlet/control";
import { checkRuns, closeDb, db, eq, isNull, lte, and, outboxEvents, sql } from "@inlet/database";
import { log, sandboxProvider } from "./context";
import { processContainment } from "./processors/containment";
import { processDeliveryVerify } from "./processors/delivery-verify";
import { processInvestigation } from "./processors/investigation";
import { processFieldDiscovery, processFixtureDeploy, processNotification, retentionTick, schedulerTick, watchdogTick } from "./processors/maintenance";
import type { NotificationKind } from "@inlet/control";
import { processSiteCheck } from "./processors/site-check";

const connection = redisConnection();
const queues = Object.fromEntries(JOB_TYPES.map((name) => [name, new Queue(name, { connection })])) as Record<JobType, Queue>;

async function dispatchOutbox(): Promise<number> {
  return db().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outboxEvents)
      .where(and(isNull(outboxEvents.dispatchedAt), lte(outboxEvents.readyAt, new Date())))
      .limit(25)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      const queue = queues[row.type as JobType];
      if (!queue) continue;
      await queue.add(row.type, row.payload, {
        jobId: row.id,
        attempts: row.type === "notifications" ? 3 : 1,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      });
      await tx.update(outboxEvents).set({ dispatchedAt: new Date(), attempts: sql`${outboxEvents.attempts} + 1` }).where(eq(outboxEvents.id, row.id));
    }
    return rows.length;
  });
}

async function siteCheckJob(job: Job<{ runId: string }>): Promise<void> {
  const [run] = await db().select({ kind: checkRuns.kind }).from(checkRuns).where(eq(checkRuns.id, job.data.runId));
  if (run?.kind === "containment") await processContainment(job.data.runId);
  else await processSiteCheck(job.data.runId);
}

const processors: Record<JobType, { handler: (job: Job) => Promise<void>; concurrency: number }> = {
  "site-check": { handler: siteCheckJob, concurrency: env().WORKER_CONCURRENCY },
  "delivery-verify": { handler: (job) => processDeliveryVerify((job.data as { runId: string }).runId), concurrency: 16 },
  investigation: { handler: (job) => processInvestigation((job.data as { investigationId: string }).investigationId), concurrency: 1 },
  notifications: { handler: (job) => processNotification(job.data as { kind: NotificationKind }), concurrency: 4 },
  "field-discovery": { handler: (job) => processFieldDiscovery(job.data as { discoveryId: string }), concurrency: 1 },
  "fixture-deploy": { handler: (job) => processFixtureDeploy(job.data as { incidentId: string; patchId: string; actorUserId: string }), concurrency: 1 },
};

const workers = JOB_TYPES.map((name) => {
  const worker = new Worker(name, processors[name].handler, {
    connection: redisConnection(),
    concurrency: processors[name].concurrency,
    lockDuration: 60_000,
    maxStalledCount: 1,
  });
  worker.on("failed", (job, error) => log.error({ queue: name, jobId: job?.id, err: error }, "job failed"));
  return worker;
});

function every(ms: number, name: string, task: () => Promise<unknown>): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    task()
      .catch((error: unknown) => log.error({ err: error, task: name }, "periodic task failed"))
      .finally(() => {
        running = false;
      });
  }, ms);
}

const timers = [
  every(250, "outbox", dispatchOutbox),
  every(30_000, "scheduler", schedulerTick),
  every(60_000, "watchdog", watchdogTick),
  every(3_600_000, "retention", retentionTick),
];

const ready = await sandboxProvider().checkReady();
log.info({ sandbox: ready }, "worker started");

async function shutdown(): Promise<void> {
  timers.forEach(clearInterval);
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
