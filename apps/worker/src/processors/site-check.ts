import { and, checkRuns, db, eq, formConfigs, organizations, sandboxSessions, sites, sql } from "@inlet/database";
import { maskToken, RUN_RESULT_LABELS } from "@inlet/domain";
import type { BrowserJob, BrowserOutcome, RunResult } from "@inlet/domain";
import { appendRunEvent, applyRunOutcome, enqueue, transitionRun } from "@inlet/control";
import { decryptSecret } from "@inlet/evidence";
import type { EgressDecision } from "@inlet/sandbox";
import { runBrowserSandbox } from "../browser-session";
import { log } from "../context";
import { destroySandboxByName } from "../sandbox-records";
import { targetForSite } from "../targets";

type Run = typeof checkRuns.$inferSelect;

const LEASE_MS = 150_000;

async function renewLease(runId: string): Promise<void> {
  await db().update(checkRuns).set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS) }).where(eq(checkRuns.id, runId));
}

export async function finishRun(runId: string, result: RunResult, summary: string): Promise<void> {
  const [run] = await db().select().from(checkRuns).where(eq(checkRuns.id, runId));
  if (!run || run.state === "cleanup_complete") return;

  if (run.state !== "complete") {
    const completedAt = new Date();
    const moved = await transitionRun(
      runId,
      run.state,
      "complete",
      {
        result,
        resultSummary: summary,
        completedAt,
        durationMs: run.startedAt ? completedAt.getTime() - run.startedAt.getTime() : null,
      },
    );
    if (!moved) return;
    await appendRunEvent(runId, {
      type: "run.completed",
      stage: "result",
      summary,
      payload: { result, label: RUN_RESULT_LABELS[result] },
    });
  }

  const sessions = await db().select().from(sandboxSessions).where(eq(sandboxSessions.runId, runId));
  let allVerified = true;
  for (const session of sessions) {
    if (session.cleanupVerified || !session.containerName) continue;
    const verified = await destroySandboxByName(session.id, session.containerName);
    allVerified &&= verified;
    await appendRunEvent(runId, verified
      ? {
          type: "sandbox.destroyed",
          stage: "cleanup",
          summary: "Execution environment removed.",
          payload: { container: session.containerName },
        }
      : {
          type: "sandbox.cleanup_failed",
          stage: "cleanup",
          summary: "The execution environment could not be confirmed removed. The watchdog will retry.",
          payload: { container: session.containerName },
        });
  }
  if (!allVerified) return;

  await applyRunOutcome(runId);
  await transitionRun(runId, "complete", "cleanup_complete", { cleanupAt: new Date(), leaseExpiresAt: null });
}

function failureSummary(outcome: BrowserOutcome | null, exitReason: string): string {
  if (!outcome) return exitReason === "wall_limit" ? "The browser ran past its time limit and was stopped." : "The browser environment stopped before reporting a result.";
  if (outcome.captchaDetected) return "This form needs a different test route because it is protected by a CAPTCHA.";
  return outcome.failureDetail ?? "The browser could not complete the form.";
}

async function persistDecisionEvents(runId: string, decisions: EgressDecision[]): Promise<void> {
  for (const decision of decisions) {
    if (decision.allowed) continue;
    await appendRunEvent(runId, {
      type: "policy.denied",
      stage: "policy",
      summary: `Blocked a request outside the approved website (${decision.target}).`,
      payload: { target: decision.target, reason: decision.reason, layer: "egress_gateway" },
    });
  }
}

export async function processSiteCheck(runId: string): Promise<void> {
  const [run] = await db().select().from(checkRuns).where(eq(checkRuns.id, runId));
  if (!run || ["complete", "cleanup_complete", "observing_destination"].includes(run.state)) return;

  if (run.submissionIntentAt) {
    await appendRunEvent(runId, {
      type: "run.interrupted",
      stage: "recovery",
      summary: "The worker restarted after this submission was authorized, so it was not repeated.",
    });
    await finishRun(runId, "unverified", "The check was interrupted after the submission step. Inlet did not submit again.");
    return;
  }

  if (run.cancelRequestedAt) {
    await appendRunEvent(runId, { type: "run.canceled", stage: "canceled", summary: "Canceled before anything was submitted." });
    await finishRun(runId, "canceled", "Canceled before anything was submitted.");
    return;
  }

  if (!run.siteId) throw new Error("Delivery runs need a site");
  const [site] = await db().select().from(sites).where(eq(sites.id, run.siteId));
  const [config] = run.formConfigId ? await db().select().from(formConfigs).where(eq(formConfigs.id, run.formConfigId)) : [];
  const [org] = await db().select().from(organizations).where(eq(organizations.id, run.organizationId));
  if (!site || !config || !org) {
    await finishRun(runId, "unverified", "The website configuration for this check is no longer available.");
    return;
  }

  const started = await transitionRun(runId, ["queued", "provisioning", "opening_form", "mapping_fields"], "provisioning", {
    startedAt: run.startedAt ?? new Date(),
    leaseExpiresAt: new Date(Date.now() + LEASE_MS),
  });
  if (!started) return;

  const lease = setInterval(() => void renewLease(runId).catch(() => undefined), 20_000);
  try {
    await executeBrowser(run, site, config, org.retentionDays);
  } finally {
    clearInterval(lease);
  }
}

async function executeBrowser(
  run: Run,
  site: typeof sites.$inferSelect,
  config: typeof formConfigs.$inferSelect,
  retentionDays: number,
): Promise<void> {
  const runId = run.id;
  const token = decryptSecret(run.testTokenEncrypted);
  const target = targetForSite(site);
  const job: BrowserJob = {
    mode: "submit",
    targetUrl: target.url,
    proxyServer: target.proxyServer,
    fieldMap: config.fieldMap,
    identity: config.syntheticIdentity,
    token,
    navigationTimeoutMs: 25_000,
  };

  let submissionAuthorized = false;
  let session: Awaited<ReturnType<typeof runBrowserSandbox>>;
  try {
    session = await runBrowserSandbox({
      owner: { organizationId: run.organizationId, runId },
      role: "browser",
      job,
      network: { mode: "egress", allow: target.allow },
      retentionDays,
      callbacks: {
        onSandboxStarted: async (handle) => {
          await db().update(checkRuns).set({ sandboxId: sql`${handle.sessionId}::uuid` }).where(eq(checkRuns.id, runId));
          await appendRunEvent(runId, {
            type: "sandbox.started",
            stage: "provisioning",
            summary: "Started an isolated browser environment.",
            payload: { container: handle.containerName, runtime: handle.hardening[0] ?? "" },
          });
        },
        onStage: async (stage) => {
          if (stage === "opening_form") {
            await transitionRun(runId, "provisioning", "opening_form");
            await appendRunEvent(runId, { type: "browser.opened", stage, summary: "Opening the form in an isolated browser." });
          } else if (stage === "mapping_fields") {
            await transitionRun(runId, "opening_form", "mapping_fields");
            await appendRunEvent(runId, { type: "form.mapped", stage, summary: "Filling in the test details." });
          } else {
            await transitionRun(runId, "mapping_fields", "submitting");
            await appendRunEvent(runId, {
              type: "form.submitting",
              stage,
              summary: `Submitting test enquiry ${maskToken(token)}.`,
            });
          }
        },
        onSubmitRequest: async () => {
          const [current] = await db().select({ cancel: checkRuns.cancelRequestedAt }).from(checkRuns).where(eq(checkRuns.id, runId));
          if (current?.cancel) return false;
          const claimed = await db()
            .update(checkRuns)
            .set({ submissionIntentAt: new Date() })
            .where(and(eq(checkRuns.id, runId), sql`${checkRuns.submissionIntentAt} is null`))
            .returning({ id: checkRuns.id });
          submissionAuthorized = claimed.length === 1;
          return submissionAuthorized;
        },
        onDecisions: (decisions) => persistDecisionEvents(runId, decisions),
      },
    });
  } catch (error) {
    log.error({ err: error, runId }, "sandbox start failed");
    await appendRunEvent(runId, {
      type: "run.inconclusive",
      stage: "provisioning",
      summary: "The test environment could not start. Your website was not contacted.",
    });
    await finishRun(runId, "unverified", "The test environment could not start, so delivery could not be checked.");
    return;
  }

  const { outcome, exit, artifacts } = session;
  await db().update(checkRuns).set({ browserOutcome: outcome ?? { exit: exit.reason } }).where(eq(checkRuns.id, runId));

  const shots = artifacts.filter((item) => item.mime === "image/png").map((item) => item.id);

  if (outcome?.submitClicked) {
    const submittedAt = new Date();
    await appendRunEvent(runId, {
      type: "form.submitted",
      stage: "submitting",
      summary: `Submitted test enquiry ${maskToken(token)}.`,
      artifactIds: shots,
      payload: { submitObserved: outcome.submitObserved },
    });
    await appendRunEvent(runId, {
      type: "form.success_ui",
      stage: "submitting",
      summary: outcome.successUiObserved ? "The form displayed a success message." : "The form did not display a success message.",
      payload: { observed: outcome.successUiObserved },
    });
    const deadline = new Date(submittedAt.getTime() + run.observationWindowSeconds * 1000);
    await transitionRun(runId, "submitting", "observing_destination", {
      submittedAt,
      observationDeadlineAt: deadline,
    });
    await enqueue("delivery-verify", runId, { runId });
    return;
  }

  if (submissionAuthorized) {
    await appendRunEvent(runId, {
      type: "run.inconclusive",
      stage: "submitting",
      summary: "The browser stopped during submission, so Inlet cannot say whether the form was sent.",
    });
    await finishRun(runId, "unverified", "The browser stopped during submission. Inlet did not retry it.");
    return;
  }

  if (outcome?.failure === "unexpected_error" && outcome.failureDetail?.includes("did not authorize")) {
    await appendRunEvent(runId, { type: "run.canceled", stage: "canceled", summary: "Canceled before anything was submitted." });
    await finishRun(runId, "canceled", "Canceled before anything was submitted.");
    return;
  }

  const summary = failureSummary(outcome, exit.reason);
  await appendRunEvent(runId, { type: "run.browser_failed", stage: "browser", summary, artifactIds: shots });
  await finishRun(runId, "browser_failed", summary);
}

