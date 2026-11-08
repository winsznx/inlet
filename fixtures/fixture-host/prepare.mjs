import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/opt/fixture";
const SITE = join(ROOT, "site");
const REPO = join(ROOT, "repo");
const BUILDS = join(ROOT, "builds");
const FAULT_PATCH = join(ROOT, "host/faults/missing-notification.patch");

const identity = {
  GIT_AUTHOR_NAME: "Acme Demo",
  GIT_AUTHOR_EMAIL: "dev@acme-demo.test",
  GIT_COMMITTER_NAME: "Acme Demo",
  GIT_COMMITTER_EMAIL: "dev@acme-demo.test",
};

function git(cwd, args, date) {
  const env = date
    ? { ...process.env, ...identity, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    : { ...process.env, ...identity };
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

function createRepository() {
  rmSync(REPO, { recursive: true, force: true });
  cpSync(SITE, REPO, {
    recursive: true,
    filter: (path) => !path.includes("/node_modules") && !path.includes("/.next"),
  });
  git(REPO, ["init", "-q", "-b", "main"]);
  git(REPO, ["add", "-A"]);
  git(REPO, ["commit", "-q", "-m", "Add contact form and enquiry notifications"], "2026-11-01T09:00:00Z");
  git(REPO, ["checkout", "-q", "-b", "fault/missing-notification"]);
  git(REPO, ["apply", FAULT_PATCH]);
  git(REPO, ["add", "-A"]);
  git(REPO, ["commit", "-q", "-m", "Tidy notification settings"], "2026-11-02T09:00:00Z");
  git(REPO, ["checkout", "-q", "main"]);
}

function buildRevision(name, ref) {
  const target = join(BUILDS, name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(BUILDS, { recursive: true });
  git(ROOT, ["clone", "-q", "--branch", ref, REPO, target]);
  symlinkSync(join(SITE, "node_modules"), join(target, "node_modules"));
  execFileSync("pnpm", ["run", "build"], { cwd: target, stdio: "inherit" });
}

createRepository();
buildRevision("healthy", "main");
buildRevision("broken", "fault/missing-notification");
