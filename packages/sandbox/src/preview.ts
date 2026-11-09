import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "@inlet/config";

const exec = promisify(execFile);

const docker = async (args: string[], timeout = 30_000): Promise<string> =>
  (await exec("docker", args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();

export const SINK_ALIAS = "inlet-sink";

export type PreviewEnvironment = {
  networkName: string;
  sinkContainer: string;
  sinkApiUrl: string;
  sinkAddress: string;
  destroy(): Promise<{ verified: boolean; error?: string }>;
};

export async function createPreviewEnvironment(sessionId: string): Promise<PreviewEnvironment> {
  const networkName = `inlet-preview-${sessionId}`;
  const sinkContainer = `inlet-sink-${sessionId}`;
  const overNetwork = env().SANDBOX_SINK_ACCESS === "fixtures-network";
  await docker(["network", "create", "--internal", "--label", "inlet.preview=1", networkName]);
  try {
    await docker([
      "run",
      "--detach",
      "--name",
      sinkContainer,
      "--label",
      "inlet.preview=1",
      "--network",
      env().SANDBOX_FIXTURES_NETWORK,
      ...(overNetwork ? [] : ["--publish", "127.0.0.1::8025"]),
      "--env",
      "MP_SMTP_AUTH_ACCEPT_ANY=1",
      "--env",
      "MP_SMTP_AUTH_ALLOW_INSECURE=1",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "128m",
      "--pids-limit",
      "64",
      env().SANDBOX_SINK_IMAGE,
    ]);
    await docker(["network", "connect", networkName, sinkContainer]);
    const sinkAddress = await containerAddress(sinkContainer, networkName);
    const sinkApiUrl = overNetwork ? `http://${sinkContainer}:8025` : await publishedSinkUrl(sinkContainer);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await fetch(`${sinkApiUrl}/readyz`, { signal: AbortSignal.timeout(1_000) }).catch(() => null);
      if (response?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { networkName, sinkContainer, sinkApiUrl, sinkAddress, destroy: () => destroyPreview(networkName, sinkContainer) };
  } catch (error) {
    await destroyPreview(networkName, sinkContainer);
    throw error;
  }
}

// gVisor's netstack cannot reach Docker's embedded DNS on a user-defined network,
// so preview sandboxes get their peers' addresses through --add-host instead.
export async function containerAddress(containerName: string, networkName: string): Promise<string> {
  const address = await docker(["inspect", "--format", `{{(index .NetworkSettings.Networks "${networkName}").IPAddress}}`, containerName]);
  if (!address) throw new Error(`Container ${containerName} has no address on ${networkName}`);
  return address;
}

async function publishedSinkUrl(sinkContainer: string): Promise<string> {
  const mapping = await docker(["port", sinkContainer, "8025/tcp"]);
  const port = mapping.split("\n")[0]?.split(":").pop();
  if (!port) throw new Error("Preview mail sink did not publish a port");
  return `http://127.0.0.1:${port}`;
}

async function destroyPreview(networkName: string, sinkContainer: string): Promise<{ verified: boolean; error?: string }> {
  await docker(["rm", "--force", "--volumes", sinkContainer]).catch(() => undefined);
  await docker(["network", "rm", networkName]).catch(() => undefined);
  try {
    const remaining = await docker(["network", "ls", "--filter", `name=^${networkName}$`, "--format", "{{.Name}}"]);
    const container = await docker(["ps", "--all", "--filter", `name=^${sinkContainer}$`, "--format", "{{.Names}}"]);
    return { verified: remaining === "" && container === "" };
  } catch (error) {
    return { verified: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function sweepOrphanPreviews(activeIds: ReadonlySet<string>): Promise<number> {
  const names = await docker(["network", "ls", "--filter", "label=inlet.preview=1", "--format", "{{.Name}}"]);
  let removed = 0;
  for (const name of names.split("\n").filter(Boolean)) {
    const sessionId = name.replace("inlet-preview-", "");
    if (activeIds.has(sessionId)) continue;
    const outcome = await destroyPreview(name, `inlet-sink-${sessionId}`);
    if (outcome.verified) removed += 1;
  }
  return removed;
}

export async function ensureDependencyVolume(name: string): Promise<boolean> {
  const existing = await docker(["volume", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"]);
  if (existing === name) {
    const marker = await docker(["volume", "inspect", "--format", '{{index .Labels "inlet.ready"}}', name]).catch(() => "");
    return marker === "1";
  }
  return false;
}

export async function createVolume(name: string, labels: Record<string, string>): Promise<void> {
  await docker(["volume", "create", ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), name]);
}

export async function removeVolume(name: string): Promise<void> {
  await docker(["volume", "rm", "--force", name]).catch(() => undefined);
}
