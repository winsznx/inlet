import { execFile, spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startAttackPage } from "../attack/server.mjs";

const run = promisify(execFile);

const ROOT = "/opt/fixture";
const DATA = "/data";
const REPO = join(DATA, "repo");
const SLOT_DIR = join(DATA, "slots/broken/current");
const TOKEN = process.env.FIXTURE_CONTROL_TOKEN;
if (!TOKEN) throw new Error("FIXTURE_CONTROL_TOKEN is required");

const FAULT_LABEL = "Controlled fault-injection example";
const REPAIRABLE_BRANCH = "deploy/broken";
const FAULT_REF = "fault/missing-notification";

const slots = {
  healthy: { port: 3110, cwd: join(ROOT, "builds/healthy"), label: "Sample environment", branch: "main" },
  broken: { port: 3111, cwd: SLOT_DIR, label: FAULT_LABEL, branch: REPAIRABLE_BRANCH },
  "demo-broken": { port: 3112, cwd: join(ROOT, "builds/broken"), label: FAULT_LABEL, branch: FAULT_REF },
};

const identity = {
  GIT_AUTHOR_NAME: "Inlet fixture deploy",
  GIT_AUTHOR_EMAIL: "deploy@acme-demo.test",
  GIT_COMMITTER_NAME: "Inlet fixture deploy",
  GIT_COMMITTER_EMAIL: "deploy@acme-demo.test",
};

const git = async (cwd, ...args) =>
  (await run("git", args, { cwd, env: { ...process.env, ...identity }, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();

const children = new Map();
let deploying = false;

function startSlot(name) {
  const slot = slots[name];
  const child = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(slot.port), "-H", "0.0.0.0"], {
    cwd: slot.cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      FIXTURE_CONTROL_TOKEN: undefined,
      FIXTURE_ENV_LABEL: slot.label,
      ENQUIRY_NOTIFY_ADDRESS: `enquiries@${name}.acme-demo.test`,
      NOTIFY_FROM: `website@${name}.acme-demo.test`,
      SMTP_HOST: process.env.SMTP_HOST ?? "mailpit",
      SMTP_PORT: process.env.SMTP_PORT ?? "1025",
    },
  });
  children.set(name, child);
}

async function stopSlot(name) {
  const child = children.get(name);
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/contact`).catch(() => null);
    if (response?.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function linkModules(target) {
  symlinkSync(join(ROOT, "site/node_modules"), join(target, "node_modules"));
}

async function bootstrapData() {
  if (!existsSync(REPO)) {
    mkdirSync(DATA, { recursive: true });
    await git(DATA, "clone", "-q", join(ROOT, "repo"), REPO);
    await git(REPO, "branch", "-f", FAULT_REF, `origin/${FAULT_REF}`);
    await git(REPO, "branch", "-f", REPAIRABLE_BRANCH, `origin/${FAULT_REF}`);
  }
  if (!existsSync(SLOT_DIR)) await restoreBrokenSlot();
}

async function restoreBrokenSlot() {
  rmSync(SLOT_DIR, { recursive: true, force: true });
  mkdirSync(join(DATA, "slots/broken"), { recursive: true });
  await git(REPO, "checkout", "-q", "--detach");
  await git(REPO, "branch", "-f", REPAIRABLE_BRANCH, FAULT_REF);
  await git(DATA, "clone", "-q", "--branch", REPAIRABLE_BRANCH, REPO, SLOT_DIR);
  linkModules(SLOT_DIR);
  cpSync(join(ROOT, "builds/broken/.next"), join(SLOT_DIR, ".next"), { recursive: true });
}

async function deploy({ patch, expectedBaseSha }) {
  const currentSha = await git(SLOT_DIR, "rev-parse", "HEAD");
  if (expectedBaseSha !== currentSha) {
    return { status: 409, body: { error: "base_moved", currentSha } };
  }
  const staging = join(DATA, "slots/broken/next");
  rmSync(staging, { recursive: true, force: true });
  await git(DATA, "clone", "-q", "--branch", REPAIRABLE_BRANCH, REPO, staging);
  linkModules(staging);
  const patchDir = mkdtempSync(join(tmpdir(), "inlet-patch-"));
  const patchFile = join(patchDir, "approved.patch");
  writeFileSync(patchFile, patch, { mode: 0o600 });
  try {
    await git(staging, "apply", "--check", patchFile);
    await git(staging, "apply", patchFile);
    await git(staging, "add", "-A", "--", ":!node_modules");
    await git(staging, "commit", "-q", "-m", "Apply reviewed Inlet patch");
    const build = await run("pnpm", ["run", "build"], { cwd: staging, maxBuffer: 16 * 1024 * 1024 }).catch(
      (error) => ({ failed: true, stderr: String(error.stderr ?? error.message).slice(-4000) }),
    );
    if (build.failed) return { status: 422, body: { error: "build_failed", detail: build.stderr } };
  } finally {
    rmSync(patchDir, { recursive: true, force: true });
  }
  const deployedSha = await git(staging, "rev-parse", "HEAD");
  await git(staging, "push", "-q", "origin", `HEAD:refs/heads/${REPAIRABLE_BRANCH}`).catch(async () => {
    await git(REPO, "checkout", "-q", "--detach");
    await git(staging, "push", "-q", "origin", `HEAD:refs/heads/${REPAIRABLE_BRANCH}`);
  });
  await stopSlot("broken");
  rmSync(SLOT_DIR, { recursive: true, force: true });
  renameSync(staging, SLOT_DIR);
  startSlot("broken");
  const ready = await waitForPort(slots.broken.port);
  return { status: ready ? 200 : 503, body: { deployedSha, previousSha: currentSha, ready } };
}

function authorized(req) {
  const expected = createHash("sha256").update(`Bearer ${TOKEN}`).digest();
  const actual = createHash("sha256").update(req.headers.authorization ?? "").digest();
  return timingSafeEqual(expected, actual);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new Error("too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function slotState(name) {
  const slot = slots[name];
  return {
    slot: name,
    port: slot.port,
    label: slot.label,
    branch: slot.branch,
    sha: await git(slot.cwd, "rev-parse", "HEAD"),
    running: children.get(name)?.exitCode === null,
  };
}

const control = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://control");
  try {
    if (url.pathname === "/health") {
      const ready = (await Promise.all(Object.values(slots).map((slot) => waitOnce(slot.port)))).every(Boolean);
      return json(res, ready ? 200 : 503, { ready });
    }
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && url.pathname === "/state") {
      return json(res, 200, { slots: await Promise.all(Object.keys(slots).map(slotState)), deploying });
    }

    const bundle = /^\/repo\/([\w-]+)\.bundle$/.exec(url.pathname);
    if (req.method === "GET" && bundle) {
      const slot = slots[bundle[1]];
      if (!slot) return json(res, 404, { error: "unknown_slot" });
      const child = spawn("git", ["bundle", "create", "-", slot.cwd === SLOT_DIR ? "HEAD" : "HEAD"], { cwd: slot.cwd });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      child.stdout.pipe(res);
      return undefined;
    }

    if (req.method === "POST" && url.pathname === "/deploy") {
      if (deploying) return json(res, 409, { error: "deploy_in_progress" });
      const body = await readJson(req);
      if (typeof body.patch !== "string" || typeof body.expectedBaseSha !== "string") {
        return json(res, 400, { error: "invalid_body" });
      }
      deploying = true;
      try {
        const result = await deploy(body);
        return json(res, result.status, result.body);
      } finally {
        deploying = false;
      }
    }

    if (req.method === "POST" && url.pathname === "/reset") {
      if (deploying) return json(res, 409, { error: "deploy_in_progress" });
      deploying = true;
      try {
        await stopSlot("broken");
        await restoreBrokenSlot();
        startSlot("broken");
        const ready = await waitForPort(slots.broken.port);
        return json(res, ready ? 200 : 503, { ready, sha: await git(SLOT_DIR, "rev-parse", "HEAD") });
      } finally {
        deploying = false;
      }
    }
    return json(res, 404, { error: "not_found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "fixture_host_error" });
  }
});

async function waitOnce(port) {
  const response = await fetch(`http://127.0.0.1:${port}/contact`).catch(() => null);
  return response?.ok ?? false;
}

await bootstrapData();
for (const name of Object.keys(slots)) startSlot(name);
startAttackPage(3113);
control.listen(3190, "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    for (const child of children.values()) child.kill("SIGTERM");
    process.exit(0);
  });
}
