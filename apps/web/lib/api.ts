export type ApiErrorBody = {
  code: string;
  message: string;
  nextAction?: string;
  requestId: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.body = body;
  }

  fieldErrors(): Record<string, string> {
    const fields = this.body.details?.fields as { path: string; message: string }[] | undefined;
    return Object.fromEntries((fields ?? []).map((field) => [field.path, field.message]));
  }
}

type RequestOptions = { method?: string; body?: unknown; idempotencyKey?: string; rawBody?: BodyInit; contentType?: string };

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.contentType) headers["content-type"] = options.contentType;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? (options.body !== undefined || options.rawBody ? "POST" : "GET"),
      headers,
      credentials: "same-origin",
      body: options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
    });
  } catch {
    throw new ApiError(0, { code: "OFFLINE", message: "Inlet can't be reached right now.", nextAction: "Check your connection and try again.", requestId: "", retryable: true });
  }
  if (response.status === 401 && typeof window !== "undefined" && window.location.pathname.startsWith("/app")) {
    window.location.assign(`/login?expired=1&next=${encodeURIComponent(window.location.pathname)}`);
  }
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as { error?: ApiErrorBody } | null;
    throw new ApiError(response.status, parsed?.error ?? { code: "INTERNAL", message: "Something went wrong.", requestId: response.headers.get("x-request-id") ?? "", retryable: true });
  }
  const type = response.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? await response.json() : await response.text()) as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.body.nextAction ? `${error.message} ${error.body.nextAction}` : error.message;
  return "Something went wrong.";
}

export async function downloadPost(path: string, filename: string): Promise<void> {
  const response = await fetch(`/api/v1${path}`, { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw new ApiError(response.status, { code: "INTERNAL", message: "That download failed.", requestId: "", retryable: true });
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
