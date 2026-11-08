import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = resolve(root, ".env.local");

const generated = {
  SESSION_SECRET: () => randomBytes(48).toString("base64url"),
  MASTER_ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
  FIXTURE_CONTROL_TOKEN: () => randomBytes(32).toString("hex"),
  EGRESS_CONTROL_TOKEN: () => randomBytes(32).toString("hex"),
  DEPLOY_WEBHOOK_SECRET: () => randomBytes(32).toString("hex"),
};

const source = existsSync(target)
  ? readFileSync(target, "utf8")
  : readFileSync(resolve(root, ".env.example"), "utf8");

let changed = !existsSync(target);
const lines = source.split("\n").map((line) => {
  const match = /^([A-Z0-9_]+)=$/.exec(line);
  const make = match ? generated[match[1]] : undefined;
  if (!make) return line;
  changed = true;
  return `${match[1]}=${make()}`;
});

if (changed) {
  writeFileSync(target, lines.join("\n"), { mode: 0o600 });
  console.log("Wrote .env.local with generated local secrets.");
} else {
  console.log(".env.local already has its secrets.");
}
