import { isAllowedTool, redactSecrets, TOOL_CALL_BUDGET, TOOL_RESULT_LIMIT_BYTES } from "@inlet/policy";
import type { AgentToolName } from "@inlet/policy";
import { InferenceError } from "./client";
import type { ChatMessage, ChatResult, InferenceClient, ToolCall } from "./client";
import { buildBrief, SYSTEM_PROMPT } from "./prompt";
import type { InvestigationBrief } from "./prompt";
import { toolDefinitions, toolSchemas } from "./tools";
import type { ToolInputs } from "./tools";

export type ToolOutcome = {
  ok: boolean;
  content: unknown;
  reasonCode?: string;
  terminal?: { kind: "patch_ready" } | { kind: "non_code_cause" };
};

export interface ToolHost {
  execute<K extends AgentToolName>(name: K, input: ToolInputs[K]): Promise<ToolOutcome>;
  recordToolCall(input: { name: string; args: unknown; allowed: boolean; reasonCode?: string; durationMs: number; result: string }): Promise<void>;
  recordModelCall(result: ChatResult, tools: string[]): Promise<void>;
  recordModelFailure(input: { code: string; httpStatus?: number; durationMs: number }): Promise<void>;
  isCanceled?(): Promise<boolean>;
}

export type LoopResult =
  | { status: "patch_ready" }
  | { status: "non_code_cause" }
  | { status: "budget_exhausted"; detail: string }
  | { status: "model_stopped"; detail: string }
  | { status: "inference_error"; code: string; detail: string };

function truncate(text: string): string {
  return text.length > TOOL_RESULT_LIMIT_BYTES ? `${text.slice(0, TOOL_RESULT_LIMIT_BYTES)}\n[truncated by controller]` : text;
}

export function serializeToolResult(outcome: ToolOutcome): string {
  return truncate(redactSecrets(JSON.stringify({ ok: outcome.ok, reasonCode: outcome.reasonCode, result: outcome.content })));
}

function redactArgs(name: string, args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null) return {};
  if (name === "propose_patch") {
    const input = args as { edits?: { path: string }[]; changedFiles?: { path: string }[]; suspectedFiles?: string[] };
    return {
      editedPaths: (input.edits ?? input.changedFiles ?? []).map((item) => item.path),
      suspectedFiles: input.suspectedFiles,
    };
  }
  return JSON.parse(redactSecrets(JSON.stringify(args))) as Record<string, unknown>;
}

async function dispatch(call: ToolCall, host: ToolHost): Promise<{ text: string; terminal?: ToolOutcome["terminal"] }> {
  const started = Date.now();
  const name = call.function.name;

  const finish = async (outcome: ToolOutcome, allowed: boolean, args: unknown) => {
    const text = serializeToolResult(outcome);
    await host.recordToolCall({
      name,
      args: redactArgs(name, args),
      allowed,
      reasonCode: outcome.reasonCode,
      durationMs: Date.now() - started,
      result: text,
    });
    return { text, terminal: outcome.terminal };
  };

  if (!isAllowedTool(name)) {
    return finish({ ok: false, content: "That tool does not exist.", reasonCode: "tool_not_allowed" }, false, {});
  }
  let raw: unknown;
  try {
    raw = JSON.parse(call.function.arguments || "{}");
  } catch {
    return finish({ ok: false, content: "Arguments were not valid JSON.", reasonCode: "invalid_arguments" }, false, {});
  }
  const parsed = toolSchemas[name].safeParse(raw);
  if (!parsed.success) {
    return finish({ ok: false, content: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`), reasonCode: "invalid_arguments" }, false, raw);
  }
  const outcome = await host.execute(name, parsed.data as ToolInputs[typeof name]);
  return finish(outcome, outcome.reasonCode === undefined || outcome.ok, parsed.data);
}

export async function runAgentLoop(client: InferenceClient, brief: InvestigationBrief, host: ToolHost, signal?: AbortSignal): Promise<LoopResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildBrief(brief) },
  ];
  const tools = toolDefinitions();
  let toolCalls = 0;
  let promptTokens = 0;
  let nudges = 0;

  for (let turn = 0; turn < TOOL_CALL_BUDGET.modelCallsPerInvestigation; turn += 1) {
    if (await host.isCanceled?.()) return { status: "model_stopped", detail: "Canceled" };
    let result: ChatResult;
    const started = Date.now();
    try {
      result = await client.chat({ messages, tools }, signal);
    } catch (error) {
      const inference = error instanceof InferenceError ? error : new InferenceError("provider_error", String(error));
      await host.recordModelFailure({ code: inference.code, httpStatus: inference.httpStatus, durationMs: Date.now() - started });
      return { status: "inference_error", code: inference.code, detail: inference.message };
    }
    const calls = result.message.tool_calls ?? [];
    await host.recordModelCall(result, calls.map((call) => call.function.name));
    promptTokens += result.usage.promptTokens;
    if (promptTokens > TOOL_CALL_BUDGET.maxPromptTokens) return { status: "budget_exhausted", detail: "Token budget reached" };

    messages.push({ role: "assistant", content: result.message.content, tool_calls: calls.length > 0 ? calls : undefined });

    if (calls.length === 0) {
      nudges += 1;
      if (nudges > 2) return { status: "model_stopped", detail: "The model stopped without calling finalize_proposal." };
      messages.push({ role: "user", content: "Continue by calling one of the tools. Only finalize_proposal ends the investigation." });
      continue;
    }

    for (const call of calls) {
      toolCalls += 1;
      if (toolCalls > TOOL_CALL_BUDGET.perAttempt * 3) return { status: "budget_exhausted", detail: "Tool call budget reached" };
      const { text, terminal } = await dispatch(call, host);
      messages.push({ role: "tool", tool_call_id: call.id, content: text });
      if (terminal) return { status: terminal.kind };
    }
  }
  return { status: "budget_exhausted", detail: "Model call budget reached" };
}
