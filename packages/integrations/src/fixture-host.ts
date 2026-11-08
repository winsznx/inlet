import { env } from "@inlet/config";

function authHeaders(): Record<string, string> {
  const token = env().FIXTURE_CONTROL_TOKEN;
  if (!token) throw new Error("FIXTURE_CONTROL_TOKEN is not configured");
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

export type FixtureSlotState = { slot: string; port: number; label: string; branch: string; sha: string; running: boolean };

export async function fixtureState(): Promise<{ slots: FixtureSlotState[]; deploying: boolean } | null> {
  const response = await fetch(`${env().FIXTURE_CONTROL_URL}/state`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json()) as { slots: FixtureSlotState[]; deploying: boolean };
}

export async function fetchFixtureBundle(slot: string): Promise<Buffer> {
  const response = await fetch(`${env().FIXTURE_CONTROL_URL}/repo/${slot}.bundle`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Could not read the sample repository (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

export type FixtureDeployResult =
  | { ok: true; deployedSha: string; previousSha: string }
  | { ok: false; code: string; detail?: string; currentSha?: string };

export async function deployFixturePatch(patch: string, expectedBaseSha: string): Promise<FixtureDeployResult> {
  const response = await fetch(`${env().FIXTURE_CONTROL_URL}/deploy`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ patch, expectedBaseSha }),
    signal: AbortSignal.timeout(280_000),
  });
  const body = (await response.json()) as { deployedSha?: string; previousSha?: string; error?: string; detail?: string; currentSha?: string };
  if (response.ok && body.deployedSha && body.previousSha) {
    return { ok: true, deployedSha: body.deployedSha, previousSha: body.previousSha };
  }
  return { ok: false, code: body.error ?? `status_${response.status}`, detail: body.detail, currentSha: body.currentSha };
}

export async function resetFixture(): Promise<{ sha: string }> {
  const response = await fetch(`${env().FIXTURE_CONTROL_URL}/reset`, {
    method: "POST",
    headers: authHeaders(),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Sample site reset failed (${response.status})`);
  return (await response.json()) as { sha: string };
}
