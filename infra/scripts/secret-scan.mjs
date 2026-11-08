import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((file) => !file.startsWith("internal/") && !file.startsWith("tests/") && !file.endsWith(".lock") && !file.startsWith(".env"));

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const trackedForbidden = tracked.filter((file) => file.startsWith("internal/") || /(^|\/)\.env(\.(?!example$)|$)/.test(file) || file === "infra/production.env");
if (trackedForbidden.length > 0) {
  console.error("Private files are tracked:");
  trackedForbidden.forEach((file) => console.error(`  ${file}`));
  process.exit(1);
}

const patterns = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["github_app_token", /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["connection_string", /\b[a-z][a-z0-9+.-]+:\/\/[^\s:/@]+:[^\s:/@]+@/i],
];

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text = text.replaceAll("postgres://unit-tests-never-connect:unused@127.0.0.1:1/none", "");
  text = text.replaceAll("postgresql://inlet:inlet@localhost:5433/inlet", "");
  text = text.replaceAll("redis://127.0.0.1:1", "");
  for (const [name, pattern] of patterns) {
    if (pattern.test(text)) findings.push(`${file}: ${name}`);
  }
}

if (findings.length > 0) {
  console.error("Potential secrets found:");
  findings.forEach((finding) => console.error(`  ${finding}`));
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed (${files.length} files checked).`);
}
