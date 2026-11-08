import { randomUUID } from "node:crypto";
import { FIXTURE_FIELD_MAP } from "@inlet/control";

export const API_URL = "http://localhost:4000/api/v1";
export const ORIGIN = "http://localhost:3000";
export const MAILPIT_URL = "http://localhost:8025";
export const HEALTHY_SITE_URL = "http://localhost:3110/contact";
export const PASSWORD = "correct-horse-battery-staple";

export type RequestOptions = { body?: unknown; headers?: Record<string, string>; origin?: string | null; cookie?: string | null };

export type ApiResponse = { status: number; text: string; headers: Headers; json: <T = Record<string, unknown>>() => T };

export async function apiRequest(method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${API_URL}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), redirect: "manual" });
  const text = await response.text();
  return { status: response.status, text, headers: response.headers, json: <T>() => JSON.parse(text) as T };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ApiClient {
  cookie: string | null = null;
  rawSetCookie = "";

  request(method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse> {
    return apiRequest(method, path, { cookie: this.cookie, ...options });
  }

  async ok<T = Record<string, unknown>>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(method, path, options);
    if (response.status >= 300) throw new Error(`${method} ${path} -> ${response.status}: ${response.text}`);
    return response.json<T>();
  }

  capture(response: ApiResponse): void {
    const raw = response.headers.getSetCookie().find((value) => value.startsWith("inlet_session="));
    if (!raw) throw new Error("No session cookie in response");
    this.rawSetCookie = raw;
    this.cookie = raw.split(";")[0] ?? null;
  }
}

export function uniqueEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 12)}@tests.inlet.test`;
}

// Registration is limited to 12 per five minutes per IP, so a rerun can land inside the previous run's window.
async function registerWithBackoff(body: unknown): Promise<ApiResponse> {
  let response = await apiRequest("POST", "/auth/register", { body });
  if (response.status === 429) {
    await sleep(Number(response.headers.get("retry-after") ?? "300") * 1000 + 500);
    response = await apiRequest("POST", "/auth/register", { body });
  }
  return response;
}

export async function registerUser(label: string, extra: Record<string, unknown> = {}): Promise<{ client: ApiClient; email: string; userId: string }> {
  const email = typeof extra.email === "string" ? extra.email : uniqueEmail(label);
  const response = await registerWithBackoff({ name: `Test ${label}`, email, password: PASSWORD, ...extra });
  if (response.status !== 201) throw new Error(`register ${label} -> ${response.status}: ${response.text}`);
  const client = new ApiClient();
  client.capture(response);
  return { client, email, userId: response.json<{ id: string }>().id };
}

export async function registerOwner(label: string): Promise<{ client: ApiClient; email: string; userId: string; organizationId: string }> {
  const user = await registerUser(label);
  const { id } = await user.client.ok<{ id: string }>("POST", "/organizations", { body: { name: `Org ${label} ${randomUUID().slice(0, 8)}` } });
  return { ...user, organizationId: id };
}

type MailpitMessage = { ID: string; To: { Address: string }[] };

export async function mailpitSearch(query: string): Promise<{ messages: MailpitMessage[]; count: number }> {
  const response = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(query)}&limit=50`);
  const body = (await response.json()) as { messages: MailpitMessage[]; messages_count: number };
  return { messages: body.messages, count: body.messages_count };
}

export async function inviteAndRegister(owner: { client: ApiClient; organizationId: string }, role: "viewer" | "maintainer" | "admin", label: string): Promise<{ client: ApiClient; email: string; userId: string }> {
  const email = uniqueEmail(label);
  await owner.client.ok("POST", `/organizations/${owner.organizationId}/invitations`, { body: { email, role } });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { messages } = await mailpitSearch(`to:"${email}"`);
    const id = messages[0]?.ID;
    if (id) {
      const message = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${id}`)).json()) as { Text: string };
      const inviteToken = /invite=([^&\s]+)/.exec(message.Text)?.[1];
      if (!inviteToken) throw new Error("Invitation email has no token");
      return registerUser(label, { email, inviteToken });
    }
    await sleep(200);
  }
  throw new Error(`Invitation email for ${email} never arrived`);
}

export async function createSite(owner: { client: ApiClient }, name: string, url = HEALTHY_SITE_URL): Promise<string> {
  const { id } = await owner.client.ok<{ id: string }>("POST", "/sites", { body: { name, formUrl: url, authorized: true } });
  return id;
}

export async function mapForm(owner: { client: ApiClient }, siteId: string, overrides: Record<string, string> = {}): Promise<void> {
  await owner.client.ok("PATCH", `/sites/${siteId}/form-config`, { body: { fieldMap: { ...FIXTURE_FIELD_MAP, ...overrides } } });
}

export type RunEvent = { eventId: string; sequence: number; type: string; stage: string; summary: string };

export type RunDetail = {
  runId: string;
  state: string;
  result: string | null;
  summary: string | null;
  incidentId: string | null;
  testToken: string;
  browser: { submissionObserved: boolean; submitClicked: boolean; failure: string | null; failureDetail: string | null; successUiObserved: boolean } | null;
  delivery: { status: string | null; correlatedReceiptFound: boolean; accessible: boolean | null; errorCode: string | null };
  evidence: { id: string; kind: string }[];
  events: RunEvent[];
};

export async function waitForRun(client: ApiClient, runId: string, timeoutMs = 150_000): Promise<RunDetail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await client.ok<RunDetail>("GET", `/runs/${runId}`);
    if (run.state === "cleanup_complete") return run;
    await sleep(1_000);
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms`);
}

export async function startRun(client: ApiClient, siteId: string, idempotencyKey?: string): Promise<ApiResponse> {
  return client.request("POST", `/sites/${siteId}/runs`, { body: {}, headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {} });
}

export type SseFrame = { id: number | null; event: string | null; data: string };

export async function readSse(client: ApiClient, path: string, headers: Record<string, string> = {}): Promise<SseFrame[]> {
  const response = await fetch(`${API_URL}${path}`, { headers: { cookie: client.cookie ?? "", ...headers }, signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200) throw new Error(`${path} -> ${response.status}`);
  return (await response.text())
    .split("\n\n")
    .filter((block) => block.trim() !== "" && !block.startsWith(":"))
    .map((block) => {
      const field = (name: string) => block.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
      const id = field("id");
      return { id: id === null ? null : Number(id), event: field("event"), data: field("data") ?? "" };
    });
}

export const randomId = (): string => "01960000-0000-7000-8000-" + randomUUID().slice(-12);
