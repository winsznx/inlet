import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { repoRoot } from "@inlet/config";
import { checkRuns, closeDb, db, eq } from "@inlet/database";
import { execFileSync } from "node:child_process";
import { env } from "@inlet/config";
import { addFixtureSite, assert, assertTornDown, EvidenceLog, mailpitCount, main, newWorkspace, pollUntil, startCheck, waitForRun } from "./lib";

function startWorker(): ChildProcess {
  return spawn("pnpm", ["exec", "tsx", "src/main.ts"], { cwd: resolve(repoRoot, "apps/worker"), stdio: "ignore", env: { ...process.env, LOG_LEVEL: "error" }, detached: true });
}

function killGroup(child: ChildProcess): void {
  if (child.pid) process.kill(-child.pid, "SIGKILL");
}

await main(async () => {
  const running = execFileSync("sh", ["-c", "pgrep -f 'apps/worker.*tsx|src/main.ts' | wc -l"]).toString().trim();
  const log = new EvidenceLog("worker-crash");
  log.record("priorProcesses", running);
  const client = await newWorkspace("crash");
  const siteId = await addFixtureSite(client, "Crash sample", `${env().FIXTURE_SITE_URL}/contact`, false);

  const first = startWorker();
  const runId = await startCheck(client, siteId);
  await pollUntil(() => db().select({ intent: checkRuns.submissionIntentAt }).from(checkRuns).where(eq(checkRuns.id, runId)), (rows) => Boolean(rows[0]?.intent), 90_000, "the submission step");
  killGroup(first);
  log.record("killedWorkerAfterSubmissionIntent", runId);

  const second = startWorker();
  try {
    const run = await waitForRun(client, runId).catch(async () => waitForRun(client, runId));
    assert(run.result !== "received" || run.events.some((event) => event.type === "destination.matched"), "Received without a destination match");
    assert((await mailpitCount(run.testToken)) <= 1, "The enquiry was submitted more than once");
    assertTornDown(run);
    log.record("result", run.result);
    log.record("summary", run.summary);
    log.record("messagesForToken", await mailpitCount(run.testToken));
    log.record("recoveryEvents", run.events.filter((event) => ["run.interrupted", "sandbox.destroyed"].includes(event.type)).map((event) => event.summary));
  } finally {
    killGroup(second);
    await closeDb();
  }
  console.log(`Evidence: ${log.finish()}`);
});
