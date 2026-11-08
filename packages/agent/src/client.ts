import { env } from "@inlet/config";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ChatResult = {
  message: { content: string | null; tool_calls?: ToolCall[] };
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number };
  responseId: string | null;
  requestId: string | null;
  httpStatus: number;
  durationMs: number;
  startedAt: Date;
  modelId: string;
};

export type ChatRequest = { messages: ChatMessage[]; tools: ToolDefinition[]; maxTokens?: number; toolChoice?: "auto" | "required" };

export interface InferenceClient {
  readonly modelId: string;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
}

export class InferenceError extends Error {
  constructor(
    readonly code: "not_configured" | "auth_rejected" | "rate_limited" | "provider_error" | "timeout" | "malformed_response",
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "InferenceError";
  }
}

type RawCompletion = {
  id?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;

export class VultrInferenceClient implements InferenceClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    readonly modelId: string,
    options?: { apiKey?: string; baseUrl?: string },
  ) {
    const key = options?.apiKey ?? env().VULTR_INFERENCE_API_KEY;
    if (!key) throw new InferenceError("not_configured", "VULTR_INFERENCE_API_KEY is not set");
    this.apiKey = key;
    this.baseUrl = options?.baseUrl ?? env().VULTR_INFERENCE_BASE_URL;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    let lastError: InferenceError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.send(request, signal);
      } catch (error) {
        if (!(error instanceof InferenceError)) throw error;
        lastError = error;
        if (!["rate_limited", "provider_error", "timeout"].includes(error.code) || attempt === MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
      }
    }
    throw lastError ?? new InferenceError("provider_error", "Inference failed");
  }

  private async send(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const startedAt = new Date();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      const body: Record<string, unknown> = {
        model: this.modelId,
        messages: request.messages,
        temperature: 0.1,
        max_tokens: request.maxTokens ?? 4_000,
      };
      if (request.tools.length > 0) {
        body.tools = request.tools;
        body.tool_choice = request.toolChoice ?? "auto";
      }
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new InferenceError("timeout", error instanceof Error ? error.message : "request failed");
    }
    const durationMs = Date.now() - startedAt.getTime();
    if (response.status === 401 || response.status === 403) {
      throw new InferenceError("auth_rejected", "The inference key was rejected", response.status);
    }
    if (response.status === 429) throw new InferenceError("rate_limited", "Inference rate limited", 429);
    if (!response.ok) throw new InferenceError("provider_error", `Inference returned ${response.status}`, response.status);

    const body = (await response.json().catch(() => null)) as RawCompletion | null;
    const choice = body?.choices?.[0];
    if (!body || !choice?.message) throw new InferenceError("malformed_response", "Inference returned no choices", response.status);
    return {
      message: { content: choice.message.content ?? null, tool_calls: choice.message.tool_calls },
      finishReason: choice.finish_reason ?? null,
      usage: { promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0 },
      responseId: body.id ?? null,
      requestId: response.headers.get("x-request-id"),
      httpStatus: response.status,
      durationMs,
      startedAt,
      modelId: this.modelId,
    };
  }
}
