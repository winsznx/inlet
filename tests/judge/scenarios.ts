import { env, inferenceConfigured } from "@inlet/config";
import { resetFixture } from "@inlet/integrations";
import { addFixtureSite, assert, assertRealScreenshot, assertTornDown, EvidenceLog, mailpitCount, newWorkspace, pollUntil, startCheck, waitForRun } from "./lib";
import type { Client, Run } from "./lib";

export async function smokeLocal(): Promise<string> {
  const log = new EvidenceLog("Q2");
  const client = await newWorkspace("local");

  const healthySite = await addFixtureSite(client, "Working sample", `${env().FIXTURE_SITE_URL}/contact`, false);
  const healthy = await waitForRun(client, await startCheck(client, healthySite));
  assert(healthy.result === "received", `Healthy run ended as ${healthy.result}`);
  assert((await mailpitCount(healthy.testToken)) >= 1, "The healthy token is not in Mailpit");
  await assertRealScreenshot(client, healthy);
  assertTornDown(healthy);
  log.record("healthyRun", healthy.runId);
  log.record("healthyToken", healthy.testToken);

  const brokenSite = await addFixtureSite(client, "Missing notification sample", `${env().FIXTURE_DEMO_BROKEN_SITE_URL}/contact`, false);
  const broken = await waitForRun(client, await startCheck(client, brokenSite));
  assert(broken.result === "not_received", `Broken run ended as ${broken.result}`);
  assert(broken.browser?.successUiObserved === true, "The broken site should have shown success");
  assert((await mailpitCount(broken.testToken)) === 0, "A message unexpectedly arrived for the broken site");
  assert(broken.incidentId, "The broken run did not open an incident");
  await assertRealScreenshot(client, broken);
  assertTornDown(broken);
  log.record("failedRun", broken.runId);
  log.record("failedToken", broken.testToken);
  log.record("incident", broken.incidentId);
  return log.finish();
}

const CONTAINMENT = ["blocked-network", "forbidden-file", "prompt-injection", "resource-exhaustion"];

export async function smokeContainment(): Promise<string> {
  const log = new EvidenceLog("Q4");
  const client = await newWorkspace("containment");
  for (const test of CONTAINMENT) {
    const { runId } = await client.call<{ runId: string }>(`/internal/sandbox-lab/${test}`, { body: {} });
    const run = await waitForRun(client, runId, `/internal/sandbox-lab/runs/${runId}`);
    assert(run.result === "blocked", `${test} ended as ${run.result}: ${run.summary}`);
    assertTornDown(run);
    const denied = run.policyDecisions.filter((item) => !item.allowed);
    assert(denied.length > 0, `${test} recorded no denial`);
    if (test === "prompt-injection") {
      assert(denied.some((item) => item.layer === "egress_gateway" && item.target.startsWith("unauthorized.example")), "The gateway did not deny the injected host");
    }
    if (test === "blocked-network") {
      assert(run.events.some((event) => event.summary.includes("Allowed")), "The positive control did not succeed");
    }
    if (test === "resource-exhaustion") assert(run.sandboxes.length === 2 && run.sandboxes.every((sandbox) => sandbox.oomKilled === true || sandbox.exitReason === "wall_limit" || sandbox.exitCode !== 0), "A resource limit did not stop its sandbox");
    log.record(test, { runId, result: run.result, denials: denied.length, exit: run.sandboxes[0]?.exitReason, cleanupVerified: run.sandboxes[0]?.cleanupVerified, summary: run.summary });
  }
  return log.finish();
}

type Incident = { state: string; currentPatch: { id: string; origin: string; checks: { name: string; variant: string; pass: boolean }[] } | null; investigations: { id: string; state: string; modelId: string | null; errorCode: string | null }[]; deployments: unknown[]; recoveryRun: { id: string; result: string } | null };
type Investigation = { origin: string; modelId: string; state: string; attempts: number; modelCalls: { httpStatus: number; responseId: string | null; durationMs: number; promptTokens: number }[]; toolCalls: { tool: string; allowed: boolean }[]; events: { summary: string }[] };

const REQUIRED_CHECKS = ["typecheck", "lint", "unit", "build", "fixture-delivery"];
const SETTLED = new Set(["awaiting_approval", "patch_failed", "investigation_failed", "repair_unavailable", "needs_configuration"]);

async function repairAndRecover(client: Client, mode: "agent" | "non_ai_harness", log: EvidenceLog): Promise<void> {
  await resetFixture();
  const siteId = await addFixtureSite(client, "Repairable sample", `${env().FIXTURE_BROKEN_SITE_URL}/contact`, true);
  const failed: Run = await waitForRun(client, await startCheck(client, siteId));
  assert(failed.result === "not_received" && failed.incidentId, `Starting run ended as ${failed.result}`);
  const incidentId = failed.incidentId;
  log.record("failedRun", failed.runId);

  await client.call(`/incidents/${incidentId}/investigations`, { body: { mode } });
  const settled = await pollUntil(() => client.call<Incident>(`/incidents/${incidentId}`), (incident) => SETTLED.has(incident.state), 560_000, "the investigation");
  const investigationId = settled.investigations[0]?.id;
  assert(investigationId, "No investigation was recorded");
  const investigation = await client.call<Investigation>(`/investigations/${investigationId}`);
  log.record("investigation", investigationId);
  log.record("origin", investigation.origin);
  log.record("model", investigation.modelId);
  log.record("attempts", investigation.attempts);
  log.record("toolsCalled", investigation.toolCalls.map((call) => `${call.tool}:${call.allowed ? "allowed" : "denied"}`));
  log.record("events", investigation.events.map((event) => event.summary));
  assert(settled.state === "awaiting_approval" && settled.currentPatch, `The investigation ended as ${settled.state} (${settled.investigations[0]?.errorCode ?? "no error code"})`);

  if (mode === "agent") {
    assert(investigation.origin === "vultr_inference", "The run did not use Vultr inference");
    assert(investigation.modelCalls.length > 0 && investigation.modelCalls.every((call) => call.httpStatus === 200 && call.responseId), "Model calls are missing provider evidence");
    log.record("modelCalls", investigation.modelCalls.map((call) => ({ responseId: call.responseId, durationMs: call.durationMs, promptTokens: call.promptTokens })));
  }
  const patched = settled.currentPatch.checks.filter((check) => check.variant === "patched");
  for (const name of REQUIRED_CHECKS) assert(patched.some((check) => check.name === name && check.pass), `Required check ${name} did not pass`);
  assert(settled.currentPatch.checks.some((check) => check.variant === "baseline" && check.pass), "The baseline did not reproduce the failure");
  log.record("patch", settled.currentPatch.id);

  await client.call(`/patches/${settled.currentPatch.id}/approve`, { body: { reason: "Reviewed by the judge harness.", riskAcknowledged: true } });
  await client.call(`/incidents/${incidentId}/fixture/apply`, { body: { confirm: true } });
  await pollUntil(() => client.call<Incident>(`/incidents/${incidentId}`), (incident) => incident.deployments.length > 0, 240_000, "the sample deployment");
  const { runId } = await client.call<{ runId: string }>(`/incidents/${incidentId}/recheck`, { body: {} });
  const recovery = await waitForRun(client, runId);
  assert(recovery.result === "received", `Recovery run ended as ${recovery.result}`);
  assert(recovery.testToken !== failed.testToken, "The recovery run reused a token");
  assert((await mailpitCount(recovery.testToken)) >= 1, "The recovery token is not in Mailpit");
  assert((await mailpitCount(failed.testToken)) === 0, "The failed token should never have arrived");
  const final = await pollUntil(() => client.call<Incident>(`/incidents/${incidentId}`), (incident) => incident.state === "verified_recovered", 30_000, "verified recovery");
  log.record("recoveryRun", final.recoveryRun?.id);
  log.record("recoveryToken", recovery.testToken);
  log.record("incident", incidentId);
  log.record("finalState", final.state);
  await resetFixture();
}

export async function smokeRecovery(): Promise<string> {
  const log = new EvidenceLog("Q5");
  await repairAndRecover(await newWorkspace("recovery"), "non_ai_harness", log);
  return log.finish();
}

export async function smokeInference(): Promise<string> {
  assert(inferenceConfigured(), "VULTR_INFERENCE_API_KEY is not set");
  const log = new EvidenceLog("Q3");
  await repairAndRecover(await newWorkspace("inference"), "agent", log);
  return log.finish();
}
