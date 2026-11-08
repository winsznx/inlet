import { env } from "../../packages/config/src/index";
import { ACTIVE_RUN_STATES } from "../../packages/control/src/runs";
import { JOB_TYPES } from "../../packages/control/src/outbox";
import { redisConnection } from "../../packages/control/src/realtime";
import { and, checkRuns, closeDb, count, db, eq, inArray, isNotNull, isNull, sandboxSessions } from "../../packages/database/src/index";

const SECTION_TIMEOUT_MS = 8_000;

type Depths = { waiting: number; active: number; delayed: number; failed: number };

function withTimeout<T>(label: string, task: Promise<T>): Promise<T> {
  return Promise.race([
    task,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${SECTION_TIMEOUT_MS}ms`)), SECTION_TIMEOUT_MS).unref();
    }),
  ]);
}

async function health(): Promise<{ healthy: boolean; lines: string[] }> {
  const url = `${env().API_BASE_URL}/api/v1/health/ready`;
  const response = await fetch(url, { signal: AbortSignal.timeout(SECTION_TIMEOUT_MS) });
  const body = (await response.json()) as { status: string; checks: Record<string, boolean> };
  return {
    healthy: response.ok,
    lines: [`${url} -> ${response.status} ${body.status}`, ...Object.entries(body.checks).map(([name, ok]) => `${name.padEnd(22)}${ok ? "yes" : "no"}`)],
  };
}

// BullMQ's list and sorted-set keys are read directly because bullmq is a
// dependency of the worker only, and this script also runs inside the API image.
async function queueDepths(): Promise<Record<string, Depths>> {
  const redis = redisConnection();
  redis.on("error", () => undefined);
  try {
    const entries = await Promise.all(
      JOB_TYPES.map(async (name) => {
        const key = (suffix: string) => `bull:${name}:${suffix}`;
        const [wait, paused, prioritized, active, delayed, failed] = await Promise.all([
          redis.llen(key("wait")),
          redis.llen(key("paused")),
          redis.zcard(key("prioritized")),
          redis.llen(key("active")),
          redis.zcard(key("delayed")),
          redis.zcard(key("failed")),
        ]);
        return [name, { waiting: wait + paused + prioritized, active, delayed, failed }] as const;
      }),
    );
    return Object.fromEntries(entries);
  } finally {
    redis.disconnect();
  }
}

async function activeRuns(): Promise<{ state: string; value: number }[]> {
  return db().select({ state: checkRuns.state, value: count() }).from(checkRuns).where(inArray(checkRuns.state, ACTIVE_RUN_STATES)).groupBy(checkRuns.state);
}

async function sandboxCleanup(): Promise<{ stoppedUnverified: number; notStopped: number }> {
  const [stopped] = await db()
    .select({ value: count() })
    .from(sandboxSessions)
    .where(and(eq(sandboxSessions.cleanupVerified, false), isNotNull(sandboxSessions.stoppedAt)));
  const [running] = await db()
    .select({ value: count() })
    .from(sandboxSessions)
    .where(and(eq(sandboxSessions.cleanupVerified, false), isNull(sandboxSessions.stoppedAt)));
  return { stoppedUnverified: stopped?.value ?? 0, notStopped: running?.value ?? 0 };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let failed = false;

function section(title: string): void {
  console.log(`\n${title}`);
}

function unavailable(error: unknown): void {
  failed = true;
  console.log(`  unavailable: ${reason(error)}`);
}

section("Health");
try {
  const result = await health();
  if (!result.healthy) failed = true;
  result.lines.forEach((line) => console.log(`  ${line}`));
} catch (error) {
  unavailable(error);
}

section("Queues");
try {
  const depths = await withTimeout("redis", queueDepths());
  console.log(`  ${"queue".padEnd(18)}${"waiting".padStart(8)}${"active".padStart(8)}${"delayed".padStart(8)}${"failed".padStart(8)}`);
  for (const [name, depth] of Object.entries(depths)) {
    console.log(`  ${name.padEnd(18)}${String(depth.waiting).padStart(8)}${String(depth.active).padStart(8)}${String(depth.delayed).padStart(8)}${String(depth.failed).padStart(8)}`);
  }
} catch (error) {
  unavailable(error);
}

section("Active runs");
try {
  const rows = await withTimeout("postgres", activeRuns());
  if (rows.length === 0) console.log("  none");
  rows.forEach((row) => console.log(`  ${row.state.padEnd(24)}${row.value}`));
} catch (error) {
  unavailable(error);
}

section("Sandbox sessions pending cleanup");
try {
  const cleanup = await withTimeout("postgres", sandboxCleanup());
  console.log(`  ${"stopped, not verified".padEnd(24)}${cleanup.stoppedUnverified}`);
  console.log(`  ${"no stop recorded".padEnd(24)}${cleanup.notStopped}`);
} catch (error) {
  unavailable(error);
}

await withTimeout("shutdown", closeDb()).catch(() => undefined);
process.exit(failed ? 1 : 0);
