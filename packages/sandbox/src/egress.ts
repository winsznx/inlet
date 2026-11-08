import { env } from "@inlet/config";
import type { EgressDecision } from "./types";

export type EgressAllowEntry = { host: string; port: number; scope: "fixture" | "verified" | "mirror" };

function headers(): Record<string, string> {
  const token = env().EGRESS_CONTROL_TOKEN;
  if (!token) throw new Error("EGRESS_CONTROL_TOKEN is not configured");
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function call(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${env().EGRESS_CONTROL_URL}${path}`, {
    ...init,
    headers: headers(),
    signal: AbortSignal.timeout(5_000),
  });
}

export async function registerEgressSession(input: {
  id: string;
  ip: string;
  allow: EgressAllowEntry[];
  ttlSeconds: number;
  maxBytes: number;
}): Promise<void> {
  const response = await call(`/sessions/${input.id}`, { method: "PUT", body: JSON.stringify(input) });
  if (!response.ok) throw new Error(`Egress gateway refused the session (${response.status})`);
}

export async function fetchEgressDecisions(id: string, after: number): Promise<{ decisions: EgressDecision[]; total: number }> {
  const response = await call(`/sessions/${id}/decisions?after=${after}`, { method: "GET" });
  if (response.status === 404) return { decisions: [], total: after };
  if (!response.ok) throw new Error(`Egress gateway error (${response.status})`);
  return (await response.json()) as { decisions: EgressDecision[]; total: number };
}

export async function removeEgressSession(id: string): Promise<void> {
  await call(`/sessions/${id}`, { method: "DELETE" });
}

export async function egressHealthy(): Promise<boolean> {
  const response = await fetch(`${env().EGRESS_CONTROL_URL}/health`, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
  return response?.ok ?? false;
}
