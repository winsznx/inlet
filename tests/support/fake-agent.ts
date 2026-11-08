import type { ChatRequest, ChatResult, InferenceClient, InvestigationBrief, ToolCall, ToolHost, ToolInputs, ToolOutcome } from "@inlet/agent";
import type { AgentToolName } from "@inlet/policy";

export const TEST_BRIEF: InvestigationBrief = {
  siteName: "Unit test site",
  destinationName: "Unit test inbox",
  observationWindowSeconds: 30,
  approvedPaths: ["src"],
  buildProfile: "next-pnpm",
  requiredChecks: ["typecheck", "lint", "unit", "build"],
};

export type ScriptedTurn = { content?: string | null; toolCalls?: ToolCall[]; promptTokens?: number } | Error;

export function toolCall(name: string, args: unknown = {}, id = `call_${name}`): ToolCall {
  return { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
}

export class FakeScriptedInferenceClient implements InferenceClient {
  readonly modelId = "fake-model-never-a-real-inference-call";
  readonly requests: ChatRequest[] = [];

  constructor(private readonly nextTurn: (turn: number) => ScriptedTurn) {}

  chat(request: ChatRequest): Promise<ChatResult> {
    const turn = this.requests.length;
    this.requests.push(structuredClone(request));
    const scripted = this.nextTurn(turn);
    if (scripted instanceof Error) return Promise.reject(scripted);
    return Promise.resolve({
      message: { content: scripted.content ?? null, tool_calls: scripted.toolCalls },
      finishReason: scripted.toolCalls?.length ? "tool_calls" : "stop",
      usage: { promptTokens: scripted.promptTokens ?? 10, completionTokens: 5 },
      responseId: `fake-response-${turn}`,
      requestId: `fake-request-${turn}`,
      httpStatus: 200,
      durationMs: 1,
      startedAt: new Date(),
      modelId: this.modelId,
    });
  }

  toolMessages(): { tool_call_id: string; content: string }[] {
    const last = this.requests.at(-1);
    return (last?.messages ?? []).flatMap((message) => (message.role === "tool" ? [{ tool_call_id: message.tool_call_id, content: message.content }] : []));
  }
}

export type RecordedToolCall = Parameters<ToolHost["recordToolCall"]>[0];

export class FakeRecordingToolHost implements ToolHost {
  readonly executed: { name: AgentToolName; input: unknown }[] = [];
  readonly recordedToolCalls: RecordedToolCall[] = [];
  readonly modelCalls: string[][] = [];
  readonly modelFailures: { code: string; httpStatus?: number }[] = [];
  canceled = false;

  constructor(private readonly respond: (name: AgentToolName, input: unknown) => ToolOutcome = () => ({ ok: true, content: "fake tool output" })) {}

  execute<K extends AgentToolName>(name: K, input: ToolInputs[K]): Promise<ToolOutcome> {
    this.executed.push({ name, input });
    return Promise.resolve(this.respond(name, input));
  }

  recordToolCall(input: RecordedToolCall): Promise<void> {
    this.recordedToolCalls.push(input);
    return Promise.resolve();
  }

  recordModelCall(_result: ChatResult, tools: string[]): Promise<void> {
    this.modelCalls.push(tools);
    return Promise.resolve();
  }

  recordModelFailure(input: { code: string; httpStatus?: number; durationMs: number }): Promise<void> {
    this.modelFailures.push({ code: input.code, httpStatus: input.httpStatus });
    return Promise.resolve();
  }

  isCanceled(): Promise<boolean> {
    return Promise.resolve(this.canceled);
  }
}
