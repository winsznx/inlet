import { randomUUID } from "node:crypto";
import { env } from "@inlet/config";
import { repairMessageSchema } from "@inlet/domain";
import type { RepairProfile, RepairResult } from "@inlet/domain";
import { containerAddress, createPreviewEnvironment, createVolume, ensureDependencyVolume, removeVolume, SINK_ALIAS } from "@inlet/sandbox";
import type { PreviewEnvironment, SandboxHandle } from "@inlet/sandbox";
import { commandForProfile } from "@inlet/policy";
import type { PackageManager } from "@inlet/policy";
import { sandboxProvider } from "../context";
import { destroySandbox, recordEgressDecisions, recordSandboxExit, recordSandboxStarted, reserveSandboxSession } from "../sandbox-records";
import type { SandboxOwner } from "../sandbox-records";

export const REPAIR_LIMITS = { cpus: 2, memoryMb: 2048, pids: 256, wallSeconds: 300, workspaceMb: 512 };
export const PREVIEW_ALIAS = "inlet-preview-app";

async function firstMessage(handle: SandboxHandle): Promise<unknown> {
  for await (const line of handle.messages()) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

export async function ensureDependencies(input: {
  owner: SandboxOwner;
  lockfileHash: string;
  manifestTarGz: Buffer;
  installCommand: string[];
  onProgress?: (summary: string) => Promise<void>;
}): Promise<string> {
  const volume = `inlet-deps-${input.lockfileHash}`;
  if (await ensureDependencyVolume(volume)) return volume;

  await removeVolume(volume);
  const staging = `${volume}-prep`;
  await removeVolume(staging);
  await createVolume(staging, {});
  await input.onProgress?.("Installing locked dependencies in a separate environment with scripts disabled.");

  const proxy = `http://${env().EGRESS_PROXY_HOST}:${env().EGRESS_PROXY_PORT}`;
  const spec = {
    role: "dependency-prep" as const,
    image: env().SANDBOX_REPAIR_IMAGE,
    command: ["node", "/runner/main.mjs", "prep"],
    user: "node",
    cpus: 2,
    memoryMb: 2048,
    pids: 256,
    wallSeconds: 240,
    tmpfs: [{ path: "/tmp", sizeMb: 1024, exec: true }],
    network: { mode: "egress" as const, allow: [{ host: "registry.npmjs.org", port: 443, scope: "mirror" as const }] },
    env: { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, npm_config_registry: "https://registry.npmjs.org/" },
    volumes: [{ name: staging, target: "/deps", readOnly: false }],
  };
  const sessionId = await reserveSandboxSession(input.owner, spec);
  const handle = await sandboxProvider().create({ ...spec, sessionId });
  await recordSandboxStarted(handle);
  try {
    handle.send({ tarGzB64: input.manifestTarGz.toString("base64"), installCommand: input.installCommand });
    const result = (await firstMessage(handle)) as { t?: string; exitCode?: number; stderr?: string } | null;
    const exit = await handle.waitForExit();
    await recordSandboxExit(sessionId, exit);
    await recordEgressDecisions(sessionId, await handle.drainEgressDecisions().catch(() => []));
    if (result?.t !== "prep_result" || result.exitCode !== 0) {
      throw new Error(`Dependency install failed: ${(result?.stderr ?? handle.stderrTail()).slice(-400)}`);
    }
  } finally {
    await destroySandbox(handle);
  }
  await promoteVolume(staging, volume);
  return volume;
}

async function promoteVolume(staging: string, target: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await createVolume(target, { "inlet.ready": "1" });
  try {
    await exec(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=volume,source=${staging},target=/tmp/from,readonly`,
        "--mount",
        `type=volume,source=${target},target=/deps`,
        env().SANDBOX_REPAIR_IMAGE,
        "sh",
        "-c",
        "cp -a /tmp/from/. /deps/",
      ],
      { timeout: 180_000 },
    );
  } catch (error) {
    await removeVolume(target);
    throw error;
  } finally {
    await removeVolume(staging);
  }
}

export type RepairSessionConfig = {
  owner: SandboxOwner;
  tarGz: Buffer;
  packageManager: PackageManager;
  dependencyVolume: string;
  previewEnv: Record<string, string>;
};

export class RepairSession {
  private pending = new Map<string, (result: RepairResult) => void>();
  private pump: Promise<void> | null = null;
  private ready!: Promise<void>;

  private constructor(
    readonly handle: SandboxHandle,
    readonly preview: PreviewEnvironment,
  ) {}

  static async start(config: RepairSessionConfig): Promise<RepairSession> {
    const previewId = randomUUID().slice(0, 18);
    const preview = await createPreviewEnvironment(previewId);
    try {
      const spec = {
        role: "repair" as const,
        image: env().SANDBOX_REPAIR_IMAGE,
        command: ["node", "/runner/main.mjs"],
        user: "node",
        cpus: REPAIR_LIMITS.cpus,
        memoryMb: REPAIR_LIMITS.memoryMb,
        pids: REPAIR_LIMITS.pids,
        wallSeconds: REPAIR_LIMITS.wallSeconds,
        tmpfs: [
          { path: "/tmp", sizeMb: 256, exec: true },
          { path: "/work/app", sizeMb: REPAIR_LIMITS.workspaceMb, exec: true },
        ],
        network: { mode: "private" as const, network: preview.networkName, hosts: { [SINK_ALIAS]: preview.sinkAddress } },
        volumes: [{ name: config.dependencyVolume, target: "/work/app/node_modules", readOnly: true }],
        env: { HOME: "/tmp/home" },
      };
      const sessionId = await reserveSandboxSession(config.owner, spec);
      const handle = await sandboxProvider().create({ ...spec, sessionId });
      await recordSandboxStarted(handle);
      const session = new RepairSession(handle, preview);
      session.begin(config);
      try {
        await session.ready;
      } catch (error) {
        await session.close();
        throw error;
      }
      return session;
    } catch (error) {
      await preview.destroy();
      throw error;
    }
  }

  async previewAppAddress(): Promise<string> {
    return containerAddress(this.handle.containerName, this.preview.networkName);
  }

  private begin(config: RepairSessionConfig): void {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.handle.send({
      packageManager: config.packageManager,
      tarGzB64: config.tarGz.toString("base64"),
      previewEnv: { ...config.previewEnv, SMTP_HOST: SINK_ALIAS, SMTP_PORT: "1025" },
    });
    this.pump = (async () => {
      for await (const line of this.handle.messages()) {
        let parsedLine: unknown;
        try {
          parsedLine = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = repairMessageSchema.safeParse(parsedLine);
        if (!parsed.success) continue;
        if (parsed.data.t === "ready") {
          resolveReady();
        } else {
          const resolver = this.pending.get(parsed.data.id);
          this.pending.delete(parsed.data.id);
          resolver?.(parsed.data);
        }
      }
      rejectReady(new Error(`The repair environment stopped early: ${this.handle.stderrTail().slice(-300)}`));
      for (const [id, resolver] of this.pending) {
        resolver({ t: "profile_result", id, profile: "typecheck", exitCode: null, timedOut: true, durationMs: 0, stdout: "", stderr: "The repair environment stopped." });
      }
      this.pending.clear();
    })();
  }

  run(profile: RepairProfile, packageManager: PackageManager): Promise<RepairResult> {
    if (profile !== "preview_stop" && !commandForProfile(packageManager, profile)) {
      throw new Error(`Profile not allowed: ${profile}`);
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.handle.send({ id, profile });
    });
  }

  async close(): Promise<{ sandboxVerified: boolean; previewVerified: boolean }> {
    await this.handle.stop("exited");
    const exit = await this.handle.waitForExit();
    await recordSandboxExit(this.handle.sessionId, exit);
    await this.pump?.catch(() => undefined);
    const sandboxVerified = await destroySandbox(this.handle);
    const preview = await this.preview.destroy();
    return { sandboxVerified, previewVerified: preview.verified };
  }
}
