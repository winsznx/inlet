import { env } from "@inlet/config";
import { db, runArtifacts } from "@inlet/database";
import { newId, runnerMessageSchema } from "@inlet/domain";
import type { BrowserJob, BrowserOutcome, RunnerArtifact } from "@inlet/domain";
import { ArtifactCollector, objectKey, putObject, REDACTION_VERSION } from "@inlet/evidence";
import type { EgressDecision, ExitInfo, NetworkPlan, SandboxHandle } from "@inlet/sandbox";
import { sandboxProvider } from "./context";
import { recordEgressDecisions, recordSandboxExit, recordSandboxStarted, reserveSandboxSession } from "./sandbox-records";
import type { SandboxOwner } from "./sandbox-records";

export const BROWSER_LIMITS = { cpus: 1, memoryMb: 768, pids: 256, wallSeconds: 120, artifactBytes: 256 * 1024 * 1024 };

export type StoredArtifact = { id: string; kind: string; mime: string };

export type BrowserCallbacks = {
  onSandboxStarted?: (handle: SandboxHandle) => Promise<void>;
  onStage?: (stage: "opening_form" | "mapping_fields" | "submitting") => Promise<void>;
  onSubmitRequest?: () => Promise<boolean>;
  onArtifact?: (artifact: StoredArtifact) => Promise<void>;
  onDecisions?: (decisions: EgressDecision[]) => Promise<void>;
};

export type BrowserSessionResult = {
  outcome: BrowserOutcome | null;
  exit: ExitInfo;
  handle: SandboxHandle;
  artifacts: StoredArtifact[];
  sessionId: string;
};

export async function storeArtifact(
  owner: SandboxOwner,
  artifact: { name: string; kind: string; mime: string; data: Buffer },
  expiresAt: Date,
): Promise<StoredArtifact> {
  const id = newId();
  const key = objectKey(owner.organizationId, owner.runId ?? owner.investigationId ?? "misc", `${id}-${artifact.name}`);
  const stored = await putObject(key, artifact.data);
  await db().insert(runArtifacts).values({
    id,
    organizationId: owner.organizationId,
    runId: owner.runId,
    investigationId: owner.investigationId,
    kind: artifact.kind,
    objectKey: key,
    sha256: stored.sha256,
    sizeBytes: stored.sizeBytes,
    mime: artifact.mime,
    redactionVersion: REDACTION_VERSION,
    expiresAt,
  });
  return { id, kind: artifact.kind, mime: artifact.mime };
}

export async function runBrowserSandbox(input: {
  owner: SandboxOwner;
  role: "browser" | "preview-browser";
  job: BrowserJob;
  network: NetworkPlan;
  retentionDays: number;
  callbacks?: BrowserCallbacks;
}): Promise<BrowserSessionResult> {
  const { owner, role, job, network, callbacks } = input;
  const spec = {
    role,
    image: env().SANDBOX_BROWSER_IMAGE,
    command: ["node", "/runner/main.mjs"],
    user: "pwuser",
    cpus: BROWSER_LIMITS.cpus,
    memoryMb: BROWSER_LIMITS.memoryMb,
    pids: BROWSER_LIMITS.pids,
    wallSeconds: BROWSER_LIMITS.wallSeconds,
    shmMb: 128,
    tmpfs: [{ path: "/tmp", sizeMb: 256 }],
    network,
    env: { HOME: "/tmp/home", XDG_CONFIG_HOME: "/tmp/home/.config", XDG_CACHE_HOME: "/tmp/home/.cache" },
  };
  const sessionId = await reserveSandboxSession(owner, spec);
  const handle = await sandboxProvider().create({ ...spec, sessionId });
  await recordSandboxStarted(handle);
  await callbacks?.onSandboxStarted?.(handle);

  const collector = new ArtifactCollector({ maxBytes: BROWSER_LIMITS.artifactBytes, maxFiles: 24 });
  const expiresAt = new Date(Date.now() + input.retentionDays * 86_400_000);
  const artifacts: StoredArtifact[] = [];
  let outcome: BrowserOutcome | null = null;

  const pumpDecisions = async () => {
    const decisions = await handle.drainEgressDecisions().catch(() => []);
    if (decisions.length === 0) return;
    await recordEgressDecisions(sessionId, decisions);
    await callbacks?.onDecisions?.(decisions);
  };
  let pumping = Promise.resolve();
  const poller = setInterval(() => {
    pumping = pumping.then(pumpDecisions).catch(() => undefined);
  }, 750);

  handle.send(job);
  try {
    for await (const line of handle.messages()) {
      const parsed = runnerMessageSchema.safeParse(safeJson(line));
      if (!parsed.success) continue;
      const message = parsed.data;
      switch (message.t) {
        case "stage":
          await callbacks?.onStage?.(message.stage);
          break;
        case "submit_request": {
          const go = (await callbacks?.onSubmitRequest?.()) ?? false;
          handle.send({ go });
          break;
        }
        case "artifact": {
          const accepted = collector.accept(message as RunnerArtifact);
          if (accepted) {
            const stored = await storeArtifact(owner, accepted, expiresAt);
            artifacts.push(stored);
            await callbacks?.onArtifact?.(stored);
          }
          break;
        }
        case "result":
          outcome = message;
          break;
      }
    }
  } finally {
    clearInterval(poller);
    await pumping;
  }
  const exit = await handle.waitForExit();
  await pumpDecisions();
  await recordSandboxExit(sessionId, exit);
  return { outcome, exit, handle, artifacts, sessionId };
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
