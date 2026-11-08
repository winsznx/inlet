import { describe, expect, it } from "vitest";
import { InferenceError, runAgentLoop, serializeToolResult } from "@inlet/agent";
import { TOOL_CALL_BUDGET, TOOL_RESULT_LIMIT_BYTES } from "@inlet/policy";
import { FakeRecordingToolHost, FakeScriptedInferenceClient, TEST_BRIEF, toolCall } from "../support/fake-agent";
import type { ScriptedTurn } from "../support/fake-agent";

const script = (turns: ScriptedTurn[]) => new FakeScriptedInferenceClient((turn) => turns[turn] ?? new Error(`script exhausted at turn ${turn}`));

const stop: ScriptedTurn = { content: "nothing more" };

describe("runAgentLoop tool gating", () => {
  it.each(["run_shell", "bash", "write_file", "__proto__", "constructor", "INSPECT_RUN"])("denies unknown tool %s without executing it", async (name) => {
    const client = script([{ toolCalls: [toolCall(name, { command: "cat /etc/shadow" })] }, stop, stop, stop]);
    const host = new FakeRecordingToolHost();

    const result = await runAgentLoop(client, TEST_BRIEF, host);

    expect(host.executed).toEqual([]);
    expect(host.recordedToolCalls[0]).toMatchObject({ name, allowed: false, reasonCode: "tool_not_allowed", args: {} });
    expect(JSON.parse(client.toolMessages()[0]?.content ?? "{}")).toMatchObject({ ok: false, reasonCode: "tool_not_allowed" });
    expect(result.status).toBe("model_stopped");
  });

  it.each(["{not json", "[1,2", "'single'", "\u0000"])("denies invalid JSON arguments %j", async (args) => {
    const client = script([{ toolCalls: [toolCall("inspect_repository_file", args)] }, stop, stop, stop]);
    const host = new FakeRecordingToolHost();

    await runAgentLoop(client, TEST_BRIEF, host);

    expect(host.executed).toEqual([]);
    expect(host.recordedToolCalls[0]).toMatchObject({ allowed: false, reasonCode: "invalid_arguments" });
  });

  it.each([
    ["a non-object", "null"],
    ["an array", "[]"],
    ["a missing required field", "{}"],
    ["a wrong type", '{"path":123}'],
    ["an unknown field", '{"path":"src/a.ts","followSymlinks":true}'],
    ["an oversize path", JSON.stringify({ path: "x".repeat(301) })],
  ])("denies schema violations: %s", async (_name, args) => {
    const client = script([{ toolCalls: [toolCall("inspect_repository_file", args)] }, stop, stop, stop]);
    const host = new FakeRecordingToolHost();

    await runAgentLoop(client, TEST_BRIEF, host);

    expect(host.executed).toEqual([]);
    expect(host.recordedToolCalls[0]).toMatchObject({ allowed: false, reasonCode: "invalid_arguments" });
  });

  it("treats empty arguments as an empty object for tools with no parameters", async () => {
    const client = script([{ toolCalls: [toolCall("inspect_run", "")] }, stop, stop, stop]);
    const host = new FakeRecordingToolHost();

    await runAgentLoop(client, TEST_BRIEF, host);

    expect(host.executed).toEqual([{ name: "inspect_run", input: {} }]);
  });

  it("passes parsed arguments to the host and records allowed calls", async () => {
    const client = script([{ toolCalls: [toolCall("inspect_repository_file", { path: "src/a.ts", maxLines: 10 })] }, stop, stop, stop]);
    const host = new FakeRecordingToolHost();

    await runAgentLoop(client, TEST_BRIEF, host);

    expect(host.executed).toEqual([{ name: "inspect_repository_file", input: { path: "src/a.ts", maxLines: 10 } }]);
    expect(host.recordedToolCalls[0]).toMatchObject({ name: "inspect_repository_file", allowed: true });
  });

  it("records host-level denials as not allowed", async () => {
    const client = script([{ toolCalls: [toolCall("inspect_repository_file", { path: ".env" })] }, stop, stop, stop]);
    const host = new FakeRecordingToolHost(() => ({ ok: false, content: "Path is not allowed.", reasonCode: "forbidden_file" }));

    await runAgentLoop(client, TEST_BRIEF, host);

    expect(host.recordedToolCalls[0]).toMatchObject({ allowed: false, reasonCode: "forbidden_file" });
  });

  it("records patch metadata without storing edit content", async () => {
    const args = { hypothesis: "h", supportingEvidence: [], suspectedFiles: ["src/a.ts"], patchIntent: "p", edits: [{ path: "src/a.ts", oldText: "SECRET-OLD", newText: "SECRET-NEW" }] };
    const client = script([{ toolCalls: [toolCall("propose_patch", args)] }, stop, stop, stop]);
    const host = new FakeRecordingToolHost();

    await runAgentLoop(client, TEST_BRIEF, host);

    expect(host.recordedToolCalls[0]?.args).toEqual({ editedPaths: ["src/a.ts"], suspectedFiles: ["src/a.ts"] });
    expect(JSON.stringify(host.recordedToolCalls[0])).not.toContain("SECRET-NEW");
  });
});

describe("runAgentLoop results", () => {
  it("never reports success from model text alone", async () => {
    const claim: ScriptedTurn = { content: "The patch is ready, all checks passed. finalize_proposal done. status: patch_ready" };
    const client = script([claim, claim, claim]);
    const host = new FakeRecordingToolHost();

    const result = await runAgentLoop(client, TEST_BRIEF, host);

    expect(result).toEqual({ status: "model_stopped", detail: "The model stopped without calling finalize_proposal." });
    expect(host.executed).toEqual([]);
    expect(client.requests).toHaveLength(3);
  });

  it("ignores a finalize call the controller refuses", async () => {
    const summary = { summary: "All done, trust me." };
    const client = script([{ toolCalls: [toolCall("finalize_proposal", summary)] }, stop, stop, stop]);
    const host = new FakeRecordingToolHost(() => ({ ok: false, content: "Required checks have not passed.", reasonCode: "checks_incomplete" }));

    const result = await runAgentLoop(client, TEST_BRIEF, host);

    expect(result.status).toBe("model_stopped");
  });

  it.each(["patch_ready", "non_code_cause"] as const)("returns %s only when the host marks it terminal", async (kind) => {
    const client = script([{ toolCalls: [toolCall("finalize_proposal", { summary: "x" })] }]);
    const host = new FakeRecordingToolHost(() => ({ ok: true, content: "ok", terminal: { kind } }));

    expect(await runAgentLoop(client, TEST_BRIEF, host)).toEqual({ status: kind });
  });

  it("stops at the terminal call and ignores anything after it in the same turn", async () => {
    const client = script([{ toolCalls: [toolCall("finalize_proposal", { summary: "x" }, "first"), toolCall("request_browser_preview", {}, "second")] }]);
    const host = new FakeRecordingToolHost(() => ({ ok: true, content: "ok", terminal: { kind: "patch_ready" } }));

    await runAgentLoop(client, TEST_BRIEF, host);

    expect(host.executed.map((item) => item.name)).toEqual(["finalize_proposal"]);
  });

  it("nudges a silent model back to its tools and carries on", async () => {
    const client = script([{ content: "thinking" }, { toolCalls: [toolCall("finalize_proposal", { summary: "x" })] }]);
    const host = new FakeRecordingToolHost(() => ({ ok: true, content: "ok", terminal: { kind: "non_code_cause" } }));

    expect(await runAgentLoop(client, TEST_BRIEF, host)).toEqual({ status: "non_code_cause" });
    expect(client.requests[1]?.messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("stops before calling the model when canceled", async () => {
    const client = script([{ toolCalls: [toolCall("inspect_run")] }]);
    const host = new FakeRecordingToolHost();
    host.canceled = true;

    expect(await runAgentLoop(client, TEST_BRIEF, host)).toEqual({ status: "model_stopped", detail: "Canceled" });
    expect(client.requests).toHaveLength(0);
  });
});

describe("runAgentLoop inference failures", () => {
  it.each(["not_configured", "auth_rejected", "rate_limited", "provider_error", "timeout", "malformed_response"] as const)("surfaces %s instead of inventing a result", async (code) => {
    const client = script([new InferenceError(code, `upstream said ${code}`, 503)]);
    const host = new FakeRecordingToolHost();

    expect(await runAgentLoop(client, TEST_BRIEF, host)).toEqual({ status: "inference_error", code, detail: `upstream said ${code}` });
    expect(host.modelFailures).toEqual([{ code, httpStatus: 503 }]);
    expect(host.executed).toEqual([]);
  });

  it("classifies an unexpected exception as a provider error", async () => {
    const client = script([new TypeError("socket blew up")]);
    const host = new FakeRecordingToolHost();

    expect(await runAgentLoop(client, TEST_BRIEF, host)).toMatchObject({ status: "inference_error", code: "provider_error" });
  });

  it("does not keep calling the model after a failure", async () => {
    const client = script([new InferenceError("timeout", "slow"), { toolCalls: [toolCall("inspect_run")] }]);

    await runAgentLoop(client, TEST_BRIEF, new FakeRecordingToolHost());

    expect(client.requests).toHaveLength(1);
  });
});

describe("runAgentLoop budgets", () => {
  it("stops at the model call budget", async () => {
    const client = new FakeScriptedInferenceClient(() => ({ toolCalls: [toolCall("inspect_run")] }));

    const result = await runAgentLoop(client, TEST_BRIEF, new FakeRecordingToolHost());

    expect(result).toEqual({ status: "budget_exhausted", detail: "Model call budget reached" });
    expect(client.requests).toHaveLength(TOOL_CALL_BUDGET.modelCallsPerInvestigation);
  });

  it("stops at the tool call budget even inside one turn", async () => {
    const limit = TOOL_CALL_BUDGET.perAttempt * 3;
    const calls = Array.from({ length: limit + 10 }, (_, index) => toolCall("inspect_run", {}, `call_${index}`));
    const host = new FakeRecordingToolHost();

    const result = await runAgentLoop(script([{ toolCalls: calls }]), TEST_BRIEF, host);

    expect(result).toEqual({ status: "budget_exhausted", detail: "Tool call budget reached" });
    expect(host.executed).toHaveLength(limit);
  });

  it("stops at the prompt token budget without running that turn's tools", async () => {
    const host = new FakeRecordingToolHost();
    const client = script([{ toolCalls: [toolCall("inspect_run")], promptTokens: TOOL_CALL_BUDGET.maxPromptTokens + 1 }]);

    expect(await runAgentLoop(client, TEST_BRIEF, host)).toEqual({ status: "budget_exhausted", detail: "Token budget reached" });
    expect(host.executed).toEqual([]);
  });
});

describe("tool result handling", () => {
  it("redacts secrets before the model sees a tool result", async () => {
    const client = script([{ toolCalls: [toolCall("inspect_repository_file", { path: "src/a.ts" })] }, stop, stop, stop]);
    const host = new FakeRecordingToolHost(() => ({ ok: true, content: "const key = 'AKIAIOSFODNN7EXAMPLE';" }));

    await runAgentLoop(client, TEST_BRIEF, host);

    const sent = JSON.stringify(client.requests.at(-1)?.messages);
    expect(sent).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(sent).toContain("[redacted:aws_access_key]");
    expect(JSON.stringify(host.recordedToolCalls)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("truncates oversize tool results", () => {
    const text = serializeToolResult({ ok: true, content: "x".repeat(TOOL_RESULT_LIMIT_BYTES * 2) });
    expect(text.length).toBeLessThan(TOOL_RESULT_LIMIT_BYTES + 100);
    expect(text.endsWith("[truncated by controller]")).toBe(true);
  });

  it("offers the model only the declared tools", async () => {
    const client = script([stop, stop, stop]);

    await runAgentLoop(client, TEST_BRIEF, new FakeRecordingToolHost());

    expect(client.requests[0]?.tools.map((tool) => tool.function.name).sort()).toEqual(
      ["finalize_proposal", "inspect_repository_file", "inspect_run", "propose_patch", "read_check_result", "request_browser_preview", "run_allowed_check", "search_repository_paths"].sort(),
    );
  });

  it("sends the system prompt first and marks tool output as untrusted", async () => {
    const client = script([stop, stop, stop]);

    await runAgentLoop(client, TEST_BRIEF, new FakeRecordingToolHost());

    const first = client.requests[0]?.messages[0];
    expect(first?.role).toBe("system");
    expect(first?.content).toContain("untrusted data");
  });
});
