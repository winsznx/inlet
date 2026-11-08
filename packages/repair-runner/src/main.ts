import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { extract } from "./untar";
import { repairMessageSchema, REPAIR_PROFILES } from "@inlet/domain";
import type { RepairMessage, RepairProfile } from "@inlet/domain";
import { BUILD_PROFILES, commandForProfile, PROFILE_TIMEOUT_MS } from "@inlet/policy";
import type { PackageManager } from "@inlet/policy";

const WORK = "/work/app";
const OUTPUT_LIMIT = 30_000;

type Command = { id: string; profile: RepairProfile };

function emit(message: RepairMessage): void {
  process.stdout.write(`${JSON.stringify(repairMessageSchema.parse(message))}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

let previewProcess: ChildProcess | null = null;

function tail(value: string): string {
  return value.length > OUTPUT_LIMIT ? value.slice(-OUTPUT_LIMIT) : value;
}

function runProfile(manager: PackageManager, previewEnv: Record<string, string>, command: Command): Promise<void> {
  const started = Date.now();
  if (command.profile === "preview_stop") {
    previewProcess?.kill("SIGKILL");
    previewProcess = null;
    emit({ t: "profile_result", id: command.id, profile: command.profile, exitCode: 0, timedOut: false, durationMs: 0, stdout: "", stderr: "" });
    return Promise.resolve();
  }
  const argv = commandForProfile(manager, command.profile);
  if (!argv?.[0]) throw new Error("Unknown profile");

  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: "/tmp/home",
    NODE_ENV: command.profile === "unit" ? "test" : "production",
    NEXT_TELEMETRY_DISABLED: "1",
    CI: "1",
    ...(command.profile === "preview_start" ? previewEnv : {}),
  };

  if (command.profile === "preview_start") return startPreview(argv, environment, command, started);

  return new Promise((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), { cwd: WORK, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = tail(stdout + chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString());
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROFILE_TIMEOUT_MS[command.profile]);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      emit({ t: "profile_result", id: command.id, profile: command.profile, exitCode, timedOut, durationMs: Date.now() - started, stdout, stderr });
      resolve();
    });
  });
}

async function startPreview(argv: string[], environment: NodeJS.ProcessEnv, command: Command, started: number): Promise<void> {
  let stdout = "";
  const child = spawn(argv[0] as string, argv.slice(1), { cwd: WORK, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  previewProcess = child;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = tail(stdout + chunk.toString());
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stdout = tail(stdout + chunk.toString());
  });
  const deadline = Date.now() + PROFILE_TIMEOUT_MS.preview_start;
  let ready = false;
  while (Date.now() < deadline && child.exitCode === null) {
    const response = await fetch("http://127.0.0.1:3000/", { signal: AbortSignal.timeout(1_000), redirect: "manual" }).catch(() => null);
    if (response) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  emit({
    t: "profile_result",
    id: command.id,
    profile: "preview_start",
    exitCode: ready ? 0 : 1,
    timedOut: !ready && child.exitCode === null,
    durationMs: Date.now() - started,
    stdout,
    stderr: "",
  });
}

async function prepareDependencies(raw: string): Promise<void> {
  const job = JSON.parse(raw) as { tarGzB64: string; installCommand: string[] };
  const directory = "/tmp/prep";
  await extract(Readable.from(Buffer.from(job.tarGzB64, "base64")), directory);
  const [command, ...args] = job.installCommand;
  const allowed = Object.values(BUILD_PROFILES).some((profile) => profile.installCommand.join(" ") === job.installCommand.join(" "));
  if (!command || !allowed) {
    process.stdout.write(`${JSON.stringify({ t: "prep_result", exitCode: 126, stderr: "Install command not allowed" })}\n`);
    process.exit(0);
  }
  const exitCode = await new Promise<number | null>((resolve) => {
    let stderr = "";
    const child = spawn(command, args, { cwd: directory, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: "/tmp/home" } });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString());
    });
    child.on("close", (code) => {
      if (code !== 0) process.stdout.write(`${JSON.stringify({ t: "prep_result", exitCode: code, stderr })}\n`);
      resolve(code);
    });
  });
  if (exitCode !== 0) process.exit(0);
  const copied = await new Promise<number | null>((resolve) => {
    spawn("cp", ["-a", `${directory}/node_modules/.`, "/deps/"], { stdio: "ignore" }).on("close", resolve);
  });
  process.stdout.write(`${JSON.stringify({ t: "prep_result", exitCode: copied, stderr: "" })}\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) process.exit(2);
  if (process.argv[2] === "prep") {
    await prepareDependencies(first.value);
    return;
  }
  const job = JSON.parse(first.value) as {
    packageManager: PackageManager;
    tarGzB64: string;
    previewEnv: Record<string, string>;
  };
  const sourceFiles = await extract(Readable.from(Buffer.from(job.tarGzB64, "base64")), WORK);
  emit({ t: "ready", sourceFiles, nodeVersion: process.version });

  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    const command = JSON.parse(next.value) as Command;
    if (!(REPAIR_PROFILES as readonly string[]).includes(command.profile)) {
      emit({ t: "profile_result", id: command.id, profile: "typecheck", exitCode: 126, timedOut: false, durationMs: 0, stdout: "", stderr: "Profile not allowed" });
      continue;
    }
    await runProfile(job.packageManager, job.previewEnv, command);
  }
  previewProcess?.kill("SIGKILL");
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
