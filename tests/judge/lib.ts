import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { repoRoot } from "@inlet/config";

const API = process.env.JUDGE_API_URL ?? "http://localhost:4000/api/v1";
const ORIGIN = process.env.JUDGE_ORIGIN ?? "http://localhost:3000";
const MAILPIT = process.env.JUDGE_MAILPIT_URL ?? "http://localhost:8025";

export class JudgeFailure extends Error {}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new JudgeFailure(message);
}

export class Client {
  private cookie = "";

  async call<T>(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
      headers: { origin: ORIGIN, cookie: this.cookie, ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...options.headers },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0] ?? "";
    const text = await response.text();
    if (!response.ok) throw new JudgeFailure(`${options.method ?? "GET"} ${path} returned ${response.status}: ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async bytes(path: string): Promise<Buffer> {
    const response = await fetch(`${API}${path}`, { headers: { cookie: this.cookie } });
    assert(response.ok, `GET ${path} returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

export async function newWorkspace(label: string): Promise<Client> {
  const client = new Client();
  await client.call("/auth/register", { body: { name: "Judge Harness", email: `judge-${label}-${randomUUID().slice(0, 8)}@inlet.test`, password: "judge-harness-password" } });
  await client.call("/organizations", { body: { name: `Judge ${label}`, timezone: "UTC" } });
  return client;
}

export const FIELD_MAP = { name: "#name", email: "#email", subject: "#subject", message: "#message", submit: 'button[type="submit"]', successIndicator: "#form-success" };

export async function addFixtureSite(client: Client, name: string, url: string, repository: boolean): Promise<string> {
  const { id } = await client.call<{ id: string }>("/sites", { body: { name, formUrl: url, formPurpose: "contact", authorized: true } });
  await client.call(`/sites/${id}/destinations`, { body: { type: "mailpit", displayName: "Test inbox" } });
  await client.call(`/sites/${id}/form-config`, { method: "PATCH", body: { fieldMap: FIELD_MAP } });
  if (repository) await client.call(`/sites/${id}/repository/connect`, { body: { provider: "controlled_fixture" } });
  return id;
}

export type Run = {
  runId: string;
  state: string;
  result: string | null;
  summary: string | null;
  testToken: string;
  incidentId: string | null;
  browser: { successUiObserved: boolean; submitClicked: boolean } | null;
  delivery: { status: string | null; matchedAt: string | null };
  evidence: { id: string; kind: string; mime: string; sizeBytes: number }[];
  events: { type: string; summary: string }[];
  sandboxes: { containerName: string; cleanupVerified: boolean; denialCount: number; exitReason: string | null; exitCode: number | null; oomKilled: boolean | null; hardening: string[] }[];
  policyDecisions: { allowed: boolean; target: string; reasonCode: string; layer: string }[];
};

export async function startCheck(client: Client, siteId: string): Promise<string> {
  const { runId } = await client.call<{ runId: string }>(`/sites/${siteId}/runs`, { body: { trigger: "manual" }, headers: { "idempotency-key": randomUUID() } });
  return runId;
}

export async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  }
}

export function waitForRun(client: Client, runId: string, path = `/runs/${runId}`): Promise<Run> {
  return pollUntil(() => client.call<Run>(path), (run) => run.state === "cleanup_complete", 180_000, `run ${runId}`);
}

export async function mailpitCount(token: string): Promise<number> {
  const response = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`"${token}"`)}`);
  assert(response.ok, "Mailpit search failed");
  return ((await response.json()) as { messages_count: number }).messages_count;
}

export async function assertRealScreenshot(client: Client, run: Run): Promise<void> {
  const shot = run.evidence.find((item) => item.kind === "screenshot-after");
  assert(shot, `Run ${run.runId} has no screenshot`);
  const data = await client.bytes(`/artifacts/${shot.id}/download`);
  assert(data.length > 2_000 && data.subarray(1, 4).toString() === "PNG", `Run ${run.runId} screenshot is empty or invalid`);
}

export function assertTornDown(run: Run): void {
  assert(run.sandboxes.length > 0, `Run ${run.runId} recorded no sandbox`);
  for (const sandbox of run.sandboxes) assert(sandbox.cleanupVerified, `Sandbox ${sandbox.containerName} was not verified removed`);
}

export class EvidenceLog {
  readonly id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
  private readonly dir: string;
  private readonly facts: Record<string, unknown> = {};

  constructor(readonly gate: string) {
    this.dir = resolve(repoRoot, ".local-artifacts", "qa", this.id);
    mkdirSync(this.dir, { recursive: true });
  }

  record(key: string, value: unknown): void {
    this.facts[key] = value;
    console.log(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }

  finish(): string {
    const path = join(this.dir, "manifest.json");
    writeFileSync(path, JSON.stringify({ gate: this.gate, at: new Date().toISOString(), node: process.version, facts: this.facts }, null, 2));
    return path;
  }
}

export async function main(task: () => Promise<void>): Promise<void> {
  try {
    await task();
    process.exit(0);
  } catch (error) {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
