import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { artifactRoot } from "@inlet/config";
import { db, eq, sourceConnections } from "@inlet/database";
import { fetchFixtureBundle } from "@inlet/integrations";
import { isExcludedFromSnapshot, normalizeRepoPath, SNAPSHOT_MAX_FILE_BYTES, SNAPSHOT_MAX_FILES, SNAPSHOT_MAX_TOTAL_BYTES } from "@inlet/policy";

const exec = promisify(execFile);

const IDENTITY = {
  GIT_AUTHOR_NAME: "Inlet",
  GIT_AUTHOR_EMAIL: "repair@inlet.invalid",
  GIT_COMMITTER_NAME: "Inlet",
  GIT_COMMITTER_EMAIL: "repair@inlet.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(cwd: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<string> {
  const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", ...args], {
    cwd,
    env: { ...process.env, ...IDENTITY },
    maxBuffer,
  });
  return stdout;
}

export function repoStorePath(connectionId: string): string {
  return join(artifactRoot(), "repos", connectionId, "repo.git");
}

type Connection = typeof sourceConnections.$inferSelect;

export async function refreshFixtureRepository(connection: Connection): Promise<string> {
  const slot = (connection.storageRef ?? "").replace("fixture:", "");
  const store = repoStorePath(connection.id);
  await rm(store, { recursive: true, force: true });
  await mkdir(store, { recursive: true });
  await git(store, ["init", "--quiet", "--bare", "--initial-branch=main"]);
  const bundlePath = `${store}.bundle`;
  await writeFile(bundlePath, await fetchFixtureBundle(slot), { mode: 0o600 });
  await git(store, ["fetch", "--quiet", bundlePath, "+HEAD:refs/heads/main"]);
  await rm(bundlePath, { force: true });
  const sha = (await git(store, ["rev-parse", "refs/heads/main"])).trim();
  await db().update(sourceConnections).set({ baseCommitSha: sha, status: "connected", lastValidatedAt: new Date(), updatedAt: new Date() }).where(eq(sourceConnections.id, connection.id));
  return sha;
}

export class SanitizedWorktree {
  private constructor(
    readonly path: string,
    readonly baseCommitSha: string,
    readonly lockfileHash: string,
    readonly excluded: string[],
  ) {}

  static async create(connection: Connection): Promise<SanitizedWorktree> {
    const store = repoStorePath(connection.id);
    const baseCommitSha = (await git(store, ["rev-parse", "refs/heads/main"])).trim();
    const path = await mkdtemp(join(tmpdir(), "inlet-worktree-"));
    const excluded: string[] = [];
    try {
      await exec("sh", ["-c", `git -C "$0" archive ${baseCommitSha} | tar -x -C "$1"`, store, path], { maxBuffer: 1024 * 1024 });
      await sanitizeTree(path, excluded);
      await git(path, ["init", "--quiet", "--initial-branch=base"]);
      await git(path, ["add", "-A"]);
      await git(path, ["commit", "--quiet", "--allow-empty", "-m", "sanitized base"]);
      const lock = await readFile(join(path, connection.packageManager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json")).catch(() => Buffer.from(""));
      return new SanitizedWorktree(path, baseCommitSha, createHash("sha256").update(lock).digest("hex").slice(0, 24), excluded);
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }

  private resolve(relativePath: string): string | null {
    const normalized = normalizeRepoPath(relativePath);
    if (!normalized) return null;
    const target = resolve(this.path, normalized);
    return relative(this.path, target).startsWith("..") ? null : target;
  }

  async listFiles(): Promise<string[]> {
    return (await git(this.path, ["ls-files"])).split("\n").filter(Boolean);
  }

  async grep(query: string): Promise<string[]> {
    try {
      return (await git(this.path, ["grep", "--files-with-matches", "--fixed-strings", "-I", "--", query])).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  async read(relativePath: string): Promise<string | null> {
    const target = this.resolve(relativePath);
    if (!target) return null;
    const info = await lstat(target).catch(() => null);
    if (!info?.isFile() || info.size > SNAPSHOT_MAX_FILE_BYTES) return null;
    return readFile(target, "utf8");
  }

  async applyEdits(edits: { path: string; oldText: string; newText: string }[]): Promise<string | null> {
    for (const edit of edits) {
      const target = this.resolve(edit.path);
      if (!target) return `Path is not allowed: ${edit.path}`;
      const current = await readFile(target, "utf8").catch(() => null);
      if (current === null) return `File does not exist: ${edit.path}`;
      const occurrences = edit.oldText === "" ? 0 : current.split(edit.oldText).length - 1;
      if (occurrences !== 1) return `oldText must match exactly once in ${edit.path}. It matched ${occurrences} times.`;
      await writeFile(target, current.replace(edit.oldText, () => edit.newText));
    }
    return null;
  }

  async applyUnifiedDiff(diff: string): Promise<string | null> {
    const file = join(this.path, ".git", "candidate.patch");
    await writeFile(file, diff);
    try {
      await git(this.path, ["apply", "--check", "--whitespace=nowarn", file]);
      await git(this.path, ["apply", "--whitespace=nowarn", file]);
      return null;
    } catch (error) {
      return ((error as { stderr?: string }).stderr ?? "The diff did not apply.").replaceAll(file, "patch").slice(0, 600);
    }
  }

  async currentDiff(): Promise<string> {
    await git(this.path, ["add", "-A"]);
    return git(this.path, ["diff", "--cached", "--no-color", "--full-index", "HEAD"]);
  }

  async resetToBase(): Promise<void> {
    await git(this.path, ["reset", "--quiet", "--hard", "HEAD"]);
    await git(this.path, ["clean", "--quiet", "-fdx"]);
  }

  async symlinksEscaping(): Promise<string[]> {
    const escaped: string[] = [];
    await walk(this.path, async (file, info) => {
      if (!info.isSymbolicLink()) return;
      const link = await readlink(file);
      const target = resolve(dirname(file), link);
      if (relative(this.path, target).startsWith("..")) escaped.push(relative(this.path, file));
    });
    return escaped;
  }

  async tarGz(): Promise<Buffer> {
    const entries = (await readdir(this.path)).filter((name) => name !== ".git" && name !== "node_modules");
    const { stdout } = await exec("tar", ["--no-xattrs", "-czf", "-", "-C", this.path, ...entries], {
      encoding: "buffer",
      maxBuffer: SNAPSHOT_MAX_TOTAL_BYTES,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return stdout as unknown as Buffer;
  }

  async dependencyManifestTarGz(): Promise<Buffer> {
    const names = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package-lock.json"];
    const present: string[] = [];
    for (const name of names) {
      if (await lstat(join(this.path, name)).catch(() => null)) present.push(name);
    }
    const { stdout } = await exec("tar", ["--no-xattrs", "-czf", "-", "-C", this.path, ...present], {
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return stdout as unknown as Buffer;
  }

  async dispose(): Promise<void> {
    await rm(this.path, { recursive: true, force: true });
  }
}

async function walk(root: string, visit: (file: string, info: Awaited<ReturnType<typeof lstat>>) => Promise<void>): Promise<void> {
  for (const entry of await readdir(root)) {
    const file = join(root, entry);
    const info = await lstat(file);
    await visit(file, info);
    if (info.isDirectory() && entry !== ".git") await walk(file, visit);
  }
}

async function sanitizeTree(root: string, excluded: string[]): Promise<void> {
  let files = 0;
  let total = 0;
  const pending: string[] = [];
  await walk(root, async (file, info) => {
    pending.push(file);
    void info;
  });
  for (const file of pending) {
    const rel = relative(root, file);
    const info = await lstat(file).catch(() => null);
    if (!info) continue;
    if (isExcludedFromSnapshot(rel) || isExcludedFromSnapshot(`${rel}/`)) {
      excluded.push(rel);
      await rm(file, { recursive: true, force: true });
      continue;
    }
    if (info.isSymbolicLink()) {
      const target = resolve(dirname(file), await readlink(file));
      if (relative(root, target).startsWith("..")) {
        excluded.push(rel);
        await rm(file, { force: true });
      }
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > SNAPSHOT_MAX_FILE_BYTES) {
      excluded.push(rel);
      await rm(file, { force: true });
      continue;
    }
    files += 1;
    total += info.size;
  }
  if (files > SNAPSHOT_MAX_FILES || total > SNAPSHOT_MAX_TOTAL_BYTES) {
    throw new Error("The repository is larger than the repair limits allow.");
  }
}

export async function initRepositoryFromTree(connectionId: string, tree: string): Promise<string> {
  const store = repoStorePath(connectionId);
  await rm(store, { recursive: true, force: true });
  await mkdir(dirname(store), { recursive: true });
  await git(tree, ["init", "--quiet", "--initial-branch=main"]);
  await git(tree, ["add", "-A"]);
  await git(tree, ["commit", "--quiet", "--allow-empty", "-m", "Uploaded source"]);
  await git(dirname(store), ["clone", "--quiet", "--bare", tree, store]);
  return (await git(store, ["rev-parse", "refs/heads/main"])).trim();
}
