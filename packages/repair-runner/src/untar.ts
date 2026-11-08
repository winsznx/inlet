import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Readable } from "node:stream";

export async function extract(archive: Readable, target: string): Promise<number> {
  mkdirSync(target, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzvmf", "-", "--no-same-owner", "--no-same-permissions", "--no-overwrite-dir", "-C", target], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let listing = "";
    child.stdout.on("data", (chunk: Buffer) => {
      listing += chunk.toString();
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve(listing.split("\n").filter((line) => line && !line.endsWith("/")).length);
      else reject(new Error(`Could not unpack the sanitized source (${code}): ${stderr.slice(-300)}`));
    });
    archive.pipe(child.stdin);
  });
}
