import type { ChatResult, ToolHost, ToolInputs, ToolOutcome } from "@inlet/agent";
import { transitionIncident } from "@inlet/control";
import type {
  formConfigs,
  sites,
  sourceConnections} from "@inlet/database";
import {
  checkRuns,
  db,
  deliveryObservations,
  destinations,
  eq,
  incidents,
  investigationEvents,
  investigations,
  modelCalls,
  patchChecks,
  patches,
  policyDecisions,
  sql,
  toolCalls,
} from "@inlet/database";
import { newCorrelationToken, newId } from "@inlet/domain";
import type { BrowserOutcome, CheckName, InvestigationEventType, RepairProfile, RepairResult } from "@inlet/domain";
import { publishInvestigation } from "../realtime";
import { redactText, sha256 } from "@inlet/evidence";
import { MailpitVerifier } from "@inlet/integrations";
import { BUILD_PROFILES, checkReadablePath, checkRepoPath, guardDiff } from "@inlet/policy";
import type { AgentToolName, BuildProfile, PackageManager } from "@inlet/policy";
import { runBrowserSandbox, storeArtifact } from "../browser-session";
import { log } from "../context";
import { ensureDependencies, PREVIEW_ALIAS, RepairSession } from "./repair-session";
import type { SanitizedWorktree } from "@inlet/control";

type Investigation = typeof investigations.$inferSelect;
type Incident = typeof incidents.$inferSelect;
type Site = typeof sites.$inferSelect;
type Connection = typeof sourceConnections.$inferSelect;
type FormConfig = typeof formConfigs.$inferSelect;

export type HostContext = {
  investigation: Investigation;
  incident: Incident;
  site: Site;
  connection: Connection;
  config: FormConfig;
  destinationName: string;
  retentionDays: number;
  worktree: SanitizedWorktree;
};

type CheckRecord = { name: CheckName; pass: boolean; exitCode: number | null; detail: string };

type Candidate = {
  patchId: string;
  attempt: number;
  diff: string;
  files: string[];
  changedLines: number;
  checks: Map<CheckName, CheckRecord>;
  session: RepairSession | null;
};

type PreviewResult = { pass: boolean; received: boolean; submitted: boolean; successUi: boolean; detail: string };

const PROFILE_FOR_CHECK: Record<"typecheck" | "lint" | "unit" | "build", RepairProfile> = {
  typecheck: "typecheck",
  lint: "lint",
  unit: "unit",
  build: "build",
};

const CHECK_LABEL: Record<CheckName, string> = {
  typecheck: "type checks",
  lint: "lint",
  unit: "unit tests",
  build: "build",
  "fixture-delivery": "browser-to-inbox preview",
};

export class ControllerToolHost implements ToolHost {
  private candidate: Candidate | null = null;
  private baseTarGz: Buffer | null = null;
  private baseline: PreviewResult | null = null;
  private dependencyVolume: string | null = null;
  private attempts = 0;
  private lastInspected = new Set<string>();
  readonly profile: BuildProfile;

  constructor(private readonly context: HostContext) {
    const profile = BUILD_PROFILES[context.connection.buildProfile];
    if (!profile) throw new Error(`Unknown build profile ${context.connection.buildProfile}`);
    this.profile = profile;
  }

  private get investigationId(): string {
    return this.context.investigation.id;
  }

  private get manager(): PackageManager {
    return this.profile.packageManager;
  }

  async event(type: InvestigationEventType, summary: string, payload?: Record<string, string | number | boolean>): Promise<void> {
    await appendInvestigationEvent(this.investigationId, type, summary, this.attempts || null, payload);
  }

  async recordToolCall(input: { name: string; args: unknown; allowed: boolean; reasonCode?: string; durationMs: number; result: string }): Promise<void> {
    await db().insert(toolCalls).values({
      id: newId(),
      investigationId: this.investigationId,
      attempt: this.attempts,
      toolName: input.name,
      redactedArgs: input.args as Record<string, unknown>,
      allowed: input.allowed,
      reasonCode: input.reasonCode,
      durationMs: input.durationMs,
      resultSha256: sha256(input.result),
    });
    if (!input.allowed) {
      await db().insert(policyDecisions).values({
        id: newId(),
        investigationId: this.investigationId,
        layer: "controller",
        actionType: `tool.${input.name}`,
        actionTargetRedacted: JSON.stringify(input.args).slice(0, 300),
        allowed: false,
        reasonCode: input.reasonCode ?? "denied",
      });
      await this.event("tool.denied", `The controller refused a ${input.name} request (${input.reasonCode ?? "denied"}).`, {
        tool: input.name,
        reason: input.reasonCode ?? "denied",
      });
    }
  }

  async recordModelCall(result: ChatResult, tools: string[]): Promise<void> {
    await db().insert(modelCalls).values({
      id: newId(),
      investigationId: this.investigationId,
      modelId: result.modelId,
      requestId: result.requestId,
      responseId: result.responseId,
      startedAt: result.startedAt,
      durationMs: result.durationMs,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      finishReason: result.finishReason,
      toolNames: tools,
      httpStatus: result.httpStatus,
    });
    await db()
      .update(investigations)
      .set({
        promptTokens: sql`${investigations.promptTokens} + ${result.usage.promptTokens}`,
        completionTokens: sql`${investigations.completionTokens} + ${result.usage.completionTokens}`,
        leaseExpiresAt: new Date(Date.now() + 600_000),
      })
      .where(eq(investigations.id, this.investigationId));
    await this.event("model.call", `Vultr Serverless Inference responded in ${result.durationMs} ms.`, {
      modelId: result.modelId,
      durationMs: result.durationMs,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      requestId: result.requestId ?? result.responseId ?? "",
    });
  }

  async recordModelFailure(input: { code: string; httpStatus?: number; durationMs: number }): Promise<void> {
    await db().insert(modelCalls).values({
      id: newId(),
      investigationId: this.investigationId,
      modelId: this.context.investigation.modelId ?? "unknown",
      startedAt: new Date(Date.now() - input.durationMs),
      durationMs: input.durationMs,
      httpStatus: input.httpStatus,
      errorCode: input.code,
    });
  }

  async execute<K extends AgentToolName>(name: K, input: ToolInputs[K]): Promise<ToolOutcome> {
    await db()
      .update(investigations)
      .set({ leaseExpiresAt: new Date(Date.now() + 600_000) })
      .where(eq(investigations.id, this.investigationId));
    switch (name) {
      case "inspect_run":
        return this.inspectRun();
      case "search_repository_paths":
        return this.searchPaths(input as ToolInputs["search_repository_paths"]);
      case "inspect_repository_file":
        return this.inspectFile(input as ToolInputs["inspect_repository_file"]);
      case "propose_patch":
        return this.proposePatch(input as ToolInputs["propose_patch"]);
      case "run_allowed_check":
        return this.runCheck((input as ToolInputs["run_allowed_check"]).check);
      case "request_browser_preview":
        return this.browserPreview();
      case "read_check_result":
        return this.readCheck((input as ToolInputs["read_check_result"]).check);
      case "finalize_proposal":
        return this.finalize(input as ToolInputs["finalize_proposal"]);
      default:
        return { ok: false, content: "Unknown tool", reasonCode: "tool_not_allowed" };
    }
  }

  private async inspectRun(): Promise<ToolOutcome> {
    const runId = this.context.incident.openedByRunId;
    const [run] = await db().select().from(checkRuns).where(eq(checkRuns.id, runId));
    const [observation] = await db().select().from(deliveryObservations).where(eq(deliveryObservations.runId, runId));
    const outcome = run?.browserOutcome as BrowserOutcome | null;
    await this.event("tool.read_submission", "Read submission result");
    await this.event("tool.checked_destination", "Checked destination");
    return {
      ok: true,
      content: {
        browser: {
          navigated: outcome?.navigated,
          httpStatus: outcome?.httpStatus,
          submitClicked: outcome?.submitClicked,
          submitObserved: outcome?.submitObserved,
          successUiObserved: outcome?.successUiObserved,
          successUiText: outcome?.successUiText,
          network: (outcome?.network ?? []).filter((item) => item.method !== "GET").slice(0, 20),
        },
        delivery: {
          destination: this.context.destinationName,
          observationSeconds: run?.observationWindowSeconds,
          matchFound: observation?.matchFound,
          status: observation?.status,
          polls: observation?.pollCount,
        },
        formPath: new URL(this.context.site.formUrl).pathname,
      },
    };
  }

  private async searchPaths(input: ToolInputs["search_repository_paths"]): Promise<ToolOutcome> {
    const approved = this.context.connection.approvedPaths;
    const all = input.query ? await this.context.worktree.grep(input.query) : await this.context.worktree.listFiles();
    const visible = all.filter((path) => checkReadablePath(path, approved) === null).slice(0, 300);
    await this.event("tool.searched_repository", input.query ? `Searched approved source files for "${input.query.slice(0, 40)}"` : "Listed approved source files", { matches: visible.length });
    return { ok: true, content: { files: visible, truncated: all.length > visible.length } };
  }

  private async inspectFile(input: ToolInputs["inspect_repository_file"]): Promise<ToolOutcome> {
    const rejection = checkReadablePath(input.path, this.context.connection.approvedPaths);
    if (rejection) return { ok: false, content: `That path is not available: ${rejection}`, reasonCode: rejection };
    const content = await this.context.worktree.read(input.path);
    if (content === null) return { ok: false, content: "File not found or too large.", reasonCode: "file_unavailable" };
    this.lastInspected.add(input.path);
    const sendsMail = /sendMail|createTransport/.test(content) && !/\.(test|spec)\./.test(input.path);
    const label = sendsMail ? `Located notification handler in ${input.path}` : `Read ${input.path}`;
    await this.event("tool.read_file", label, { path: input.path });
    const lines = content.split("\n");
    const start = (input.startLine ?? 1) - 1;
    const slice = lines.slice(start, start + (input.maxLines ?? 400));
    return { ok: true, content: { path: input.path, startLine: start + 1, totalLines: lines.length, text: slice.join("\n") } };
  }

  private async proposePatch(input: ToolInputs["propose_patch"]): Promise<ToolOutcome> {
    const { investigation, connection, worktree, incident } = this.context;
    if (this.attempts >= investigation.maxAttempts) {
      return { ok: false, content: "No repair attempts remain.", reasonCode: "attempt_budget_exhausted" };
    }
    await this.retireCandidate();
    this.attempts += 1;
    await db().update(investigations).set({ attempts: this.attempts }).where(eq(investigations.id, investigation.id));
    await db()
      .update(investigations)
      .set({
        hypothesis: {
          hypothesis: redactText(input.hypothesis, { keepEmails: true }),
          supportingEvidence: input.supportingEvidence.map((item) => ({ artifactId: item.source, observation: redactText(item.observation, { keepEmails: true }) })),
          suspectedFiles: input.suspectedFiles,
          patchIntent: redactText(input.patchIntent, { keepEmails: true }),
        },
      })
      .where(eq(investigations.id, investigation.id));

    if (this.attempts > 1) await this.event("attempt.retry", "Tried another candidate");

    const rawEdits = input.edits ?? [];
    const rawDiffs = input.changedFiles ?? [];
    if (rawEdits.length === 0 && rawDiffs.length === 0) {
      return this.rejectCandidate("", [{ code: "empty_patch", message: "The proposal did not contain any changes." }], input.patchIntent);
    }
    const pathFailures = [...rawEdits.map((edit) => edit.path), ...rawDiffs.map((file) => file.path)]
      .map((path) => ({ path, rejection: checkRepoPath(path, connection.approvedPaths) }))
      .filter((item) => item.rejection)
      .map((item) => ({ code: item.rejection as string, message: `That path may not be changed: ${item.path}`, path: item.path }));
    if (pathFailures.length > 0) return this.rejectCandidate("", pathFailures, input.patchIntent);

    let applyError: string | null = null;
    if (rawEdits.length > 0) applyError = await worktree.applyEdits(rawEdits);
    for (const file of rawDiffs) {
      applyError ??= await worktree.applyUnifiedDiff(file.unifiedDiff);
    }
    if (applyError) {
      const retryHint = rawDiffs.length > 0 ? " Send this change again using edits, copying each oldText exactly from the file." : "";
      return this.rejectCandidate("", [{ code: "apply_failed", message: `${applyError}${retryHint}` }], input.patchIntent);
    }

    const diff = await worktree.currentDiff();
    const guard = guardDiff(diff, connection.approvedPaths);
    const escaped = await worktree.symlinksEscaping();
    const failures = [...guard.failures, ...escaped.map((path) => ({ code: "symlink_escape", message: `Symlink escapes the repository: ${path}`, path }))];
    if (failures.length > 0) return this.rejectCandidate(diff, failures, input.patchIntent);

    const patchId = newId();
    const files = guard.files.map((file) => file.path);
    await db().insert(patches).values({
      id: patchId,
      organizationId: incident.organizationId,
      incidentId: incident.id,
      investigationId: investigation.id,
      attempt: this.attempts,
      origin: investigation.origin,
      baseCommitSha: worktree.baseCommitSha,
      diffText: diff,
      changedFiles: files,
      changedFileCount: files.length,
      changedLineCount: guard.changedLines,
      status: "testing",
      rationale: redactText(input.patchIntent, { keepEmails: true }),
      sha256: sha256(diff),
    });
    await this.moveIncident("patch_proposed", { patch: { currentPatchId: patchId } });
    await this.moveIncident("patch_testing");
    await this.event("patch.candidate_created", "Created candidate patch", { files: files.length, lines: guard.changedLines });
    this.candidate = { patchId, attempt: this.attempts, diff, files, changedLines: guard.changedLines, checks: new Map(), session: null };
    return { ok: true, content: { accepted: true, changedFiles: files, changedLines: guard.changedLines, attemptsRemaining: investigation.maxAttempts - this.attempts } };
  }

  private async moveIncident(to: Incident["state"], options?: { reason?: string; patch?: Partial<typeof incidents.$inferInsert> }): Promise<void> {
    const [current] = await db().select({ state: incidents.state }).from(incidents).where(eq(incidents.id, this.context.incident.id));
    if (!current || current.state === to) {
      if (options?.patch) await db().update(incidents).set(options.patch).where(eq(incidents.id, this.context.incident.id));
      return;
    }
    if (to === "patch_proposed" && current.state === "patch_testing") {
      await transitionIncident(this.context.incident.id, "patch_failed", { actor: "agent", reason: "The previous candidate did not pass." });
    }
    await transitionIncident(this.context.incident.id, to, { actor: "agent", reason: options?.reason, patch: options?.patch });
  }

  private async rejectCandidate(diff: string, failures: { code: string; message: string; path?: string }[], rationale: string): Promise<ToolOutcome> {
    const { investigation, incident, worktree } = this.context;
    const files = [...new Set(failures.map((failure) => failure.path).filter((path): path is string => Boolean(path)))];
    await db().insert(patches).values({
      id: newId(),
      organizationId: incident.organizationId,
      incidentId: incident.id,
      investigationId: investigation.id,
      attempt: this.attempts,
      origin: investigation.origin,
      baseCommitSha: worktree.baseCommitSha,
      diffText: diff,
      changedFiles: files,
      changedFileCount: files.length,
      changedLineCount: 0,
      status: "guard_rejected",
      guardFailures: failures.map((failure) => failure.message),
      rationale: redactText(rationale, { keepEmails: true }),
      sha256: sha256(diff),
    });
    await db().insert(policyDecisions).values(
      failures.map((failure) => ({
        id: newId(),
        investigationId: investigation.id,
        layer: "controller" as const,
        actionType: "patch.apply",
        actionTargetRedacted: failure.path ?? "patch",
        allowed: false,
        reasonCode: failure.code,
      })),
    );
    await worktree.resetToBase();
    await this.event("patch.candidate_rejected", `Rejected candidate: ${failures[0]?.message ?? "guard failed"}`, { failures: failures.length });
    return { ok: false, content: { rejected: true, failures, attemptsRemaining: investigation.maxAttempts - this.attempts }, reasonCode: failures[0]?.code ?? "guard_failed" };
  }

  private async retireCandidate(): Promise<void> {
    const previous = this.candidate;
    if (!previous) return;
    await this.closeSession(previous);
    await db().update(patches).set({ status: "failed" }).where(eq(patches.id, previous.patchId));
    await this.event("attempt.failed", "Candidate failed");
    this.candidate = null;
    await this.context.worktree.resetToBase();
  }

  private async closeSession(candidate: Candidate): Promise<void> {
    if (!candidate.session) return;
    const closed = await candidate.session.close();
    candidate.session = null;
    await this.event(
      "sandbox.destroyed",
      closed.sandboxVerified && closed.previewVerified ? "Repair environment removed." : "The repair environment could not be confirmed removed. The watchdog will retry.",
      { verified: closed.sandboxVerified && closed.previewVerified },
    );
  }

  private async ensureDeps(): Promise<string> {
    if (this.dependencyVolume) return this.dependencyVolume;
    this.dependencyVolume = await ensureDependencies({
      owner: { organizationId: this.context.incident.organizationId, investigationId: this.investigationId },
      lockfileHash: this.context.worktree.lockfileHash,
      manifestTarGz: await this.context.worktree.dependencyManifestTarGz(),
      installCommand: this.profile.installCommand,
      onProgress: (summary) => this.event("check.started", summary),
    });
    return this.dependencyVolume;
  }

  private async startSession(tarGz: Buffer): Promise<RepairSession> {
    const volume = await this.ensureDeps();
    const session = await RepairSession.start({
      owner: { organizationId: this.context.incident.organizationId, investigationId: this.investigationId },
      tarGz,
      packageManager: this.manager,
      dependencyVolume: volume,
      previewEnv: this.context.connection.previewEnv,
    });
    await this.event("sandbox.started", "Started a repair environment with a private copy of the approved code.", {
      container: session.handle.containerName,
    });
    return session;
  }

  private async ensureCandidateSession(candidate: Candidate): Promise<RepairSession> {
    candidate.session ??= await this.startSession(await this.context.worktree.tarGz());
    return candidate.session;
  }

  private async persistCheck(candidate: Candidate, record: CheckRecord, profile: string, startedAt: Date, log_: string, variant: "patched" | "baseline" = "patched"): Promise<void> {
    const artifact = await storeArtifact(
      { organizationId: this.context.incident.organizationId, investigationId: this.investigationId },
      {
        name: `${variant}-${record.name}-${candidate.attempt}.log`,
        kind: "log",
        mime: "text/plain",
        data: Buffer.from(redactText(log_, { keepEmails: true })),
      },
      new Date(Date.now() + this.context.retentionDays * 86_400_000),
    );
    await db().insert(patchChecks).values({
      id: newId(),
      patchId: candidate.patchId,
      name: record.name,
      commandProfile: profile,
      variant,
      exitCode: record.exitCode,
      startedAt,
      endedAt: new Date(),
      logArtifactId: artifact.id,
      pass: record.pass,
      detail: record.detail.slice(0, 500),
    });
  }

  private async runCheck(check: "typecheck" | "lint" | "unit" | "build"): Promise<ToolOutcome> {
    const candidate = this.candidate;
    if (!candidate) return { ok: false, content: "Propose a patch first.", reasonCode: "no_candidate" };
    await this.event("check.started", `Running ${CHECK_LABEL[check]}`, { check });
    const startedAt = new Date();
    let result: RepairResult;
    try {
      const session = await this.ensureCandidateSession(candidate);
      result = await session.run(PROFILE_FOR_CHECK[check], this.manager);
    } catch (error) {
      log.error({ err: error, check }, "repair environment failure");
      throw new RepairEnvironmentError();
    }
    const pass = result.exitCode === 0 && !result.timedOut;
    const output = `${result.stdout}\n${result.stderr}`;
    const record: CheckRecord = { name: check, pass, exitCode: result.exitCode, detail: pass ? "Passed" : (result.timedOut ? "Timed out" : output.slice(-500)) };
    candidate.checks.set(check, record);
    await this.persistCheck(candidate, record, PROFILE_FOR_CHECK[check], startedAt, output);
    await this.event("check.finished", pass ? `Ran ${CHECK_LABEL[check]}: passed` : `Ran ${CHECK_LABEL[check]}: failed`, { check, pass, durationMs: result.durationMs });
    return { ok: pass, content: { check, pass, exitCode: result.exitCode, timedOut: result.timedOut, output: redactText(output.slice(-6000), { keepEmails: true }) }, reasonCode: pass ? undefined : "check_failed" };
  }

  private async previewInSession(session: RepairSession, label: "baseline" | "patched"): Promise<PreviewResult> {
    const start = await session.run("preview_start", this.manager);
    if (start.exitCode !== 0) {
      return { pass: false, received: false, submitted: false, successUi: false, detail: `The preview server did not start. ${start.stdout.slice(-300)}` };
    }
    const token = newCorrelationToken();
    const path = new URL(this.context.site.formUrl).pathname;
    const after = new Date();
    const browser = await runBrowserSandbox({
      owner: { organizationId: this.context.incident.organizationId, investigationId: this.investigationId },
      role: "preview-browser",
      job: {
        mode: "submit",
        targetUrl: `http://${PREVIEW_ALIAS}:3000${path}`,
        fieldMap: this.context.config.fieldMap,
        identity: this.context.config.syntheticIdentity,
        token,
        navigationTimeoutMs: 20_000,
      },
      network: { mode: "private", network: session.preview.networkName, hosts: { [PREVIEW_ALIAS]: await session.previewAppAddress() } },
      retentionDays: this.context.retentionDays,
      callbacks: { onSubmitRequest: async () => true },
    });
    const { handle, outcome } = browser;
    await destroyPreviewBrowser(handle);
    const submitted = outcome?.submitClicked === true;
    const verifier = new MailpitVerifier(session.preview.sinkApiUrl);
    const receipt = submitted
      ? await verifier.findReceipt({ token, after, deadline: new Date(Date.now() + 12_000) })
      : { status: "not_found" as const, polls: 0 };
    await session.run("preview_stop", this.manager);
    const received = receipt.status === "found";
    return {
      pass: submitted && received,
      received,
      submitted,
      successUi: outcome?.successUiObserved === true,
      detail: `${label}: browser ${submitted ? "submitted" : "did not submit"}, success message ${outcome?.successUiObserved ? "shown" : "not shown"}, private inbox ${received ? "received the message" : "received nothing"}.`,
    };
  }

  private async ensureBaseline(): Promise<PreviewResult> {
    if (this.baseline) return this.baseline;
    const { worktree } = this.context;
    if (!this.baseTarGz) {
      const candidateDiff = await worktree.currentDiff();
      await worktree.resetToBase();
      this.baseTarGz = await worktree.tarGz();
      if (candidateDiff.trim()) await worktree.applyUnifiedDiff(candidateDiff);
    }
    await this.event("preview.started", "Building the unpatched code to confirm the failure reproduces.");
    const session = await this.startSession(this.baseTarGz);
    try {
      const build = await session.run("build", this.manager);
      this.baseline =
        build.exitCode === 0
          ? await this.previewInSession(session, "baseline")
          : { pass: false, received: false, submitted: false, successUi: false, detail: "The unpatched code did not build." };
    } finally {
      const closed = await session.close();
      await this.event("sandbox.destroyed", "Baseline environment removed.", { verified: closed.sandboxVerified && closed.previewVerified });
    }
    await this.event("preview.finished", `Baseline result. ${this.baseline.detail}`);
    return this.baseline;
  }

  private async browserPreview(): Promise<ToolOutcome> {
    const candidate = this.candidate;
    if (!candidate) return { ok: false, content: "Propose a patch first.", reasonCode: "no_candidate" };
    if (!candidate.checks.get("build")?.pass) {
      const built = await this.runCheck("build");
      if (!built.ok) return built;
    }
    let baseline: PreviewResult;
    let preview: PreviewResult;
    const startedAt = new Date();
    try {
      baseline = await this.ensureBaseline();
      await this.event("preview.started", "Ran browser-to-inbox preview", { variant: "patched" });
      const session = await this.ensureCandidateSession(candidate);
      preview = await this.previewInSession(session, "patched");
    } catch (error) {
      log.error({ err: error }, "preview failure");
      throw new RepairEnvironmentError();
    }
    const reproduced = baseline.submitted && !baseline.received;
    const pass = preview.pass && reproduced;
    const detail = reproduced ? preview.detail : `${preview.detail} The unpatched baseline did not reproduce the failure, so this cannot be proven.`;
    const record: CheckRecord = { name: "fixture-delivery", pass, exitCode: pass ? 0 : 1, detail };
    candidate.checks.set("fixture-delivery", record);
    await this.persistCheck(candidate, { name: "fixture-delivery", pass: reproduced, exitCode: reproduced ? 0 : 1, detail: baseline.detail }, "preview", startedAt, baseline.detail, "baseline");
    await this.persistCheck(candidate, record, "preview", startedAt, detail);
    await db().update(patches).set({ previewRunEvidence: { baseline, patched: preview, reproduced } }).where(eq(patches.id, candidate.patchId));
    await this.event("preview.finished", pass ? "Browser-to-inbox preview delivered the test message" : "Browser-to-inbox preview did not deliver", { pass });
    return { ok: pass, content: { pass, baseline: baseline.detail, patched: preview.detail }, reasonCode: pass ? undefined : "preview_failed" };
  }

  private async readCheck(check: CheckName): Promise<ToolOutcome> {
    const record = this.candidate?.checks.get(check);
    return record ? { ok: true, content: record } : { ok: false, content: "That check has not run on this candidate.", reasonCode: "not_run" };
  }

  private async finalize(input: ToolInputs["finalize_proposal"]): Promise<ToolOutcome> {
    if (input.nonCodeCause) {
      await db()
        .update(investigations)
        .set({ nonCodeCause: input.nonCodeCause })
        .where(eq(investigations.id, this.investigationId));
      await this.event("investigation.non_code_cause", "The evidence points outside the application code.", { cause: input.nonCodeCause });
      await db()
        .update(incidents)
        .set({
          humanDiagnosis: {
            cause: redactText(input.summary, { keepEmails: true }),
            whatToCheck: (input.whatToCheck ?? []).map((item) => redactText(item, { keepEmails: true })),
          },
          causeCategory: input.nonCodeCause,
        })
        .where(eq(incidents.id, this.context.incident.id));
      return { ok: true, content: "Recorded.", terminal: { kind: "non_code_cause" } };
    }
    const candidate = this.candidate;
    if (!candidate) return { ok: false, content: "There is no candidate patch.", reasonCode: "no_candidate" };
    const required: CheckName[] = [...this.profile.requiredChecks, "fixture-delivery"];
    const missing = required.filter((name) => !candidate.checks.get(name)?.pass);
    if (missing.length > 0) {
      return { ok: false, content: { message: "These checks have not passed on the current candidate.", missing }, reasonCode: "checks_incomplete" };
    }
    await this.closeSession(candidate);
    const notes = (input.riskNotes ?? []).map((note) => redactText(note, { keepEmails: true }));
    const risk = candidate.files.length > 2 || candidate.changedLines > 40 ? "medium" : "low";
    await db()
      .update(patches)
      .set({ status: "ready", riskLevel: risk, riskNotes: notes, rationale: redactText(input.summary, { keepEmails: true }) })
      .where(eq(patches.id, candidate.patchId));
    await this.moveIncident("patch_ready", { patch: { currentPatchId: candidate.patchId, causeCategory: "application_code" } });
    await this.moveIncident("awaiting_approval");
    await this.event("investigation.patch_ready", "Tested patch ready");
    return { ok: true, content: "Proposal accepted.", terminal: { kind: "patch_ready" } };
  }

  get attemptsUsed(): number {
    return this.attempts;
  }

  async dispose(): Promise<void> {
    if (this.candidate) await this.closeSession(this.candidate);
  }

  async markCurrentFailed(): Promise<void> {
    if (!this.candidate) return;
    await db().update(patches).set({ status: "failed" }).where(eq(patches.id, this.candidate.patchId));
  }
}

async function destroyPreviewBrowser(handle: { destroy(): Promise<{ verified: boolean }>; sessionId: string }): Promise<void> {
  const { sandboxSessions } = await import("@inlet/database");
  const outcome = await handle.destroy();
  await db()
    .update(sandboxSessions)
    .set({ cleanupVerified: outcome.verified, cleanupVerifiedAt: outcome.verified ? new Date() : null })
    .where(eq(sandboxSessions.id, handle.sessionId));
}

export class RepairEnvironmentError extends Error {
  constructor() {
    super("repair_environment_failed");
  }
}

export async function appendInvestigationEvent(
  investigationId: string,
  type: InvestigationEventType,
  summary: string,
  attempt: number | null,
  payload?: Record<string, string | number | boolean>,
): Promise<void> {
  const [row] = await db()
    .update(investigations)
    .set({ eventSequence: sql`${investigations.eventSequence} + 1` })
    .where(eq(investigations.id, investigationId))
    .returning({ sequence: investigations.eventSequence });
  if (!row) return;
  await db().insert(investigationEvents).values({ id: newId(), investigationId, sequence: row.sequence, eventType: type, summary, attempt, payload });
  publishInvestigation(investigationId, row.sequence);
}

export async function destinationNameFor(siteId: string): Promise<string> {
  const [destination] = await db().select({ name: destinations.displayName }).from(destinations).where(eq(destinations.siteId, siteId)).limit(1);
  return destination?.name ?? "the connected destination";
}
