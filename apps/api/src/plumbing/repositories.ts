import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { initRepositoryFromTree, refreshFixtureRepository as refreshStored, SanitizedWorktree } from "@inlet/control";
import { db, eq, sourceConnections } from "@inlet/database";
import { AppError } from "@inlet/domain";
import { checkReadablePath } from "@inlet/policy";
import { extractArchive } from "../routes/sites";

async function loadConnection(id: string): Promise<typeof sourceConnections.$inferSelect> {
  const [connection] = await db().select().from(sourceConnections).where(eq(sourceConnections.id, id));
  if (!connection) throw new AppError("NOT_FOUND", "That repository connection does not exist.");
  return connection;
}

export async function refreshFixtureRepository(id: string): Promise<string> {
  return refreshStored(await loadConnection(id));
}

export async function initRepositoryFromUpload(id: string, archive: Buffer, stripComponents: number): Promise<string> {
  const { directory, dispose } = await extractArchive(archive, stripComponents);
  try {
    return await initRepositoryFromTree(id, directory);
  } finally {
    await dispose();
  }
}

export type RepositoryValidation = { ok: boolean; checks: { name: string; pass: boolean; detail: string }[] };

export async function validateRepository(id: string): Promise<RepositoryValidation> {
  const connection = await loadConnection(id);
  const worktree = await SanitizedWorktree.create(connection);
  try {
    const files = await worktree.listFiles();
    const manifest = JSON.parse(await readFile(join(worktree.path, "package.json"), "utf8").catch(() => "{}")) as { scripts?: Record<string, string> };
    const lock = connection.packageManager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
    const inScope = files.filter((path) => checkReadablePath(path, connection.approvedPaths) === null);
    const requiredScripts = ["typecheck", "lint", "test:unit", "build", "start"];
    const missing = requiredScripts.filter((name) => !manifest.scripts?.[name]);
    const checks = [
      { name: "Lockfile", pass: files.includes(lock), detail: files.includes(lock) ? `${lock} found.` : `${lock} is required for repeatable installs.` },
      { name: "Approved paths", pass: inScope.length > 0, detail: `${inScope.length} files are inside the approved paths.` },
      { name: "Build scripts", pass: missing.length === 0, detail: missing.length === 0 ? "All required scripts exist." : `Missing scripts: ${missing.join(", ")}.` },
      { name: "Secrets excluded", pass: true, detail: `${worktree.excluded.length} files were left out of the sanitized copy.` },
    ];
    const ok = checks.every((check) => check.pass);
    await db().update(sourceConnections).set({ status: ok ? "connected" : "error", lastValidatedAt: new Date(), lastError: ok ? null : "validation_failed", updatedAt: new Date() }).where(eq(sourceConnections.id, id));
    return { ok, checks };
  } finally {
    await worktree.dispose();
  }
}
