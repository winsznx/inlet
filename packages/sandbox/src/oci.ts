import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { promisify } from "node:util";
import { env } from "@inlet/config";
import { egressHealthy, fetchEgressDecisions, registerEgressSession, removeEgressSession } from "./egress";
import type {
  DestroyResult,
  EgressDecision,
  ExitInfo,
  NetworkPlan,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from "./types";

const exec = promisify(execFile);

const MANAGED_LABEL = "inlet.sandbox";
const MAX_STDOUT_LINE = 24 * 1024 * 1024;
const STDERR_TAIL = 16_000;

async function docker(args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await exec("docker", args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

function allocateSandboxIp(): string {
  return `172.30.${randomInt(1, 250)}.${randomInt(2, 250)}`;
}

function networkArgs(plan: NetworkPlan, ip: string | null): string[] {
  switch (plan.mode) {
    case "none":
      return ["--network", "none"];
    case "private":
      return ["--network", plan.network, ...(plan.alias ? ["--network-alias", plan.alias] : []), "--dns", "127.0.0.1"];
    case "egress":
      return ["--network", env().SANDBOX_NETWORK, "--ip", ip ?? "", "--dns", "127.0.0.1"];
  }
}

function describeHardening(spec: SandboxSpec, runtime: string): string[] {
  return [
    `oci-runtime:${runtime}`,
    "read-only-rootfs",
    "cap-drop:ALL",
    "no-new-privileges",
    `user:${spec.user}`,
    `pids-limit:${spec.pids}`,
    `memory:${spec.memoryMb}m`,
    `memory-swap:${spec.memoryMb}m`,
    `cpus:${spec.cpus}`,
    `wall-limit:${spec.wallSeconds}s`,
    `network:${spec.network.mode}`,
    "no-docker-socket",
    "no-host-mounts",
  ];
}

function policyDocument(spec: SandboxSpec): Record<string, unknown> {
  if (spec.network.mode === "egress") return { mode: "egress-gateway", allow: spec.network.allow };
  if (spec.network.mode === "private") return { mode: "private-internal-network", network: spec.network.network };
  return { mode: "no-network" };
}

class OciSandbox implements SandboxHandle {
  private process: ChildProcess | null = null;
  private exitPromise: Promise<ExitInfo> | null = null;
  private stderr = "";
  private forcedReason: ExitInfo["reason"] | null = null;
  private wallTimer: NodeJS.Timeout | null = null;
  private decisionCursor = 0;
  private queue: string[] = [];
  private wake: (() => void) | null = null;
  private stdoutClosed = false;

  constructor(
    readonly spec: SandboxSpec,
    readonly containerName: string,
    readonly containerId: string,
    readonly imageDigest: string,
    readonly address: string | null,
    readonly hardening: readonly string[],
    readonly policy: Record<string, unknown>,
    readonly policyHash: string,
  ) {}

  get sessionId(): string {
    return this.spec.sessionId;
  }

  attach(): void {
    const child = spawn("docker", ["start", "--attach", "--interactive", this.containerName], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_STDOUT_LINE) buffer = "";
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        this.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.stdout?.on("close", () => {
      this.stdoutClosed = true;
      this.wake?.();
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    child.stdin?.on("error", () => undefined);

    this.exitPromise = new Promise<ExitInfo>((resolve) => {
      child.once("close", () => {
        if (this.wallTimer) clearTimeout(this.wallTimer);
        void this.inspectExit().then(resolve);
      });
    });

    this.wallTimer = setTimeout(() => {
      void this.stop("wall_limit");
    }, this.spec.wallSeconds * 1000);
  }

  private push(line: string): void {
    this.queue.push(line);
    this.wake?.();
  }

  private async inspectExit(): Promise<ExitInfo> {
    try {
      const raw = await docker(["inspect", "--format", "{{.State.ExitCode}} {{.State.OOMKilled}}", this.containerName]);
      const [code, oom] = raw.split(" ");
      const oomKilled = oom === "true";
      const reason = this.forcedReason ?? (oomKilled ? "oom" : "exited");
      return { exitCode: Number(code), oomKilled, reason };
    } catch {
      return { exitCode: null, oomKilled: false, reason: this.forcedReason ?? "killed" };
    }
  }

  send(message: unknown): void {
    this.process?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  async *messages(): AsyncIterable<string> {
    for (;;) {
      while (this.queue.length > 0) {
        const line = this.queue.shift();
        if (line !== undefined) yield line;
      }
      if (this.stdoutClosed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  stderrTail(): string {
    return this.stderr;
  }

  async stop(reason: ExitInfo["reason"] = "killed"): Promise<void> {
    this.forcedReason ??= reason;
    await docker(["kill", this.containerName], 10_000).catch(() => undefined);
  }

  async waitForExit(): Promise<ExitInfo> {
    if (!this.exitPromise) return { exitCode: null, oomKilled: false, reason: "start_failed" };
    return this.exitPromise;
  }

  async drainEgressDecisions(): Promise<EgressDecision[]> {
    if (this.spec.network.mode !== "egress") return [];
    const { decisions, total } = await fetchEgressDecisions(this.sessionId, this.decisionCursor);
    this.decisionCursor = total;
    return decisions;
  }

  async destroy(): Promise<DestroyResult> {
    if (this.wallTimer) clearTimeout(this.wallTimer);
    if (this.spec.network.mode === "egress") {
      await removeEgressSession(this.sessionId).catch(() => undefined);
    }
    return removeAndVerify(this.containerName);
  }
}

async function containerExists(name: string): Promise<boolean> {
  try {
    await docker(["inspect", "--format", "{{.Id}}", name], 10_000);
    return true;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (/no such (object|container)/i.test(stderr)) return false;
    throw error;
  }
}

async function removeAndVerify(name: string): Promise<DestroyResult> {
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await docker(["rm", "--force", "--volumes", name], 20_000).catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error);
    });
    try {
      if (!(await containerExists(name))) return { verified: true, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }
  return { verified: false, attempts: 5, error: lastError ?? "Container still present after removal" };
}

export class OciSandboxProvider implements SandboxProvider {
  readonly name: string;
  readonly ociRuntime: string;

  constructor() {
    const config = env();
    this.name = config.SANDBOX_BACKEND;
    this.ociRuntime = config.SANDBOX_BACKEND === "vultr-gvisor" ? "runsc" : config.SANDBOX_OCI_RUNTIME;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const containerName = `inlet-sbx-${spec.sessionId}`;
    const imageDigest = await docker(["image", "inspect", "--format", "{{.Id}}", spec.image]);
    const ip = spec.network.mode === "egress" ? allocateSandboxIp() : null;

    if (spec.network.mode === "egress" && ip) {
      await registerEgressSession({
        id: spec.sessionId,
        ip,
        allow: spec.network.allow,
        ttlSeconds: spec.wallSeconds + 30,
        maxBytes: 512 * 1024 * 1024,
      });
    }

    const args = [
      "create",
      "--interactive",
      "--name",
      containerName,
      "--label",
      `${MANAGED_LABEL}=1`,
      "--label",
      `inlet.session=${spec.sessionId}`,
      "--label",
      `inlet.role=${spec.role}`,
      "--runtime",
      this.ociRuntime,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      spec.user,
      "--pids-limit",
      String(spec.pids),
      "--memory",
      `${spec.memoryMb}m`,
      "--memory-swap",
      `${spec.memoryMb}m`,
      "--cpus",
      String(spec.cpus),
      "--init",
      "--stop-timeout",
      "2",
      ...(spec.shmMb ? ["--shm-size", `${spec.shmMb}m`] : []),
      ...spec.tmpfs.flatMap((mount) => [
        "--tmpfs",
        `${mount.path}:rw,nosuid,nodev,${mount.exec ? "exec" : "noexec"},size=${mount.sizeMb}m,mode=1777`,
      ]),
      ...(spec.volumes ?? []).flatMap((volume) => [
        "--mount",
        `type=volume,source=${volume.name},target=${volume.target}${volume.readOnly ? ",readonly" : ""}`,
      ]),
      ...Object.entries(spec.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      ...(spec.workdir ? ["--workdir", spec.workdir] : []),
      ...networkArgs(spec.network, ip),
      spec.image,
      ...(spec.command ?? []),
    ];

    const containerId = await docker(args);
    const policy = policyDocument(spec);
    const sandbox = new OciSandbox(
      spec,
      containerName,
      containerId,
      imageDigest,
      ip,
      describeHardening(spec, this.ociRuntime),
      policy,
      createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    );
    sandbox.attach();
    return sandbox;
  }

  async verifyGone(containerName: string): Promise<boolean> {
    return !(await containerExists(containerName));
  }

  async listManaged(): Promise<{ name: string; state: string; sessionId: string }[]> {
    const output = await docker([
      "ps",
      "--all",
      "--filter",
      `label=${MANAGED_LABEL}=1`,
      "--format",
      '{{.Names}}|{{.State}}|{{.Label "inlet.session"}}',
    ]);
    if (!output) return [];
    return output.split("\n").map((line) => {
      const [name = "", state = "", sessionId = ""] = line.split("|");
      return { name, state, sessionId };
    });
  }

  async forceRemove(containerName: string): Promise<boolean> {
    return (await removeAndVerify(containerName)).verified;
  }

  async checkReady(): Promise<{ ready: boolean; detail: string }> {
    try {
      const runtimes = await docker(["info", "--format", "{{json .Runtimes}}"]);
      if (!runtimes.includes(`"${this.ociRuntime}"`)) {
        return { ready: false, detail: `OCI runtime ${this.ociRuntime} is not installed` };
      }
      if (!(await egressHealthy())) return { ready: false, detail: "Egress gateway is not reachable" };
      return { ready: true, detail: `${this.name} (${this.ociRuntime})` };
    } catch {
      return { ready: false, detail: "Container engine is not reachable" };
    }
  }
}
