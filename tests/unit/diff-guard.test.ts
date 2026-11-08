import { describe, expect, it } from "vitest";
import { checkRepoPath, guardDiff, isExcludedFromSnapshot, normalizeRepoPath, PATCH_BUDGET } from "@inlet/policy";

const APPROVED = ["src"];

function fileDiff(path: string, body = "@@ -1,1 +1,1 @@\n-old\n+new", header = ""): string {
  return `diff --git a/${path} b/${path}\n${header}index 111..222 100644\n--- a/${path}\n+++ b/${path}\n${body}\n`;
}

function codes(diff: string, approved: readonly string[] = APPROVED): string[] {
  return guardDiff(diff, approved).failures.map((failure) => failure.code);
}

describe("guardDiff happy path", () => {
  it("accepts a small edit in an approved path", () => {
    const result = guardDiff(fileDiff("src/lib/settings.ts"), APPROVED);
    expect(result).toMatchObject({ ok: true, failures: [], changedLines: 2 });
    expect(result.files[0]).toMatchObject({ path: "src/lib/settings.ts", additions: 1, deletions: 1 });
  });

  it("accepts a new file in an approved path", () => {
    const diff = "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\nindex 000..111\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const value = 1;\n";
    const result = guardDiff(diff, APPROVED);
    expect(result.ok).toBe(true);
    expect(result.files[0]?.isNew).toBe(true);
  });

  it("accepts several files within budget", () => {
    expect(guardDiff(`${fileDiff("src/a.ts")}${fileDiff("src/b.ts")}`, APPROVED).ok).toBe(true);
  });
});

describe("guardDiff path rules", () => {
  it.each([
    ["src/../../etc/passwd", "path_traversal"],
    ["src/../.env", "path_traversal"],
    ["../outside.ts", "path_traversal"],
    ["lib/other.ts", "outside_approved_paths"],
    ["srcfoo/other.ts", "outside_approved_paths"],
    [".env", "forbidden_file"],
    [".env.production", "forbidden_file"],
    ["src/.env.local", "forbidden_file"],
    ["src/.envrc", "forbidden_file"],
    [".npmrc", "forbidden_file"],
    [".github/workflows/ci.yml", "forbidden_file"],
    [".gitlab-ci.yml", "forbidden_file"],
    [".circleci/config.yml", "forbidden_file"],
    ["src/server.pem", "forbidden_file"],
    ["src/server.key", "forbidden_file"],
    ["src/id_rsa", "forbidden_file"],
    ["src/.ssh/config", "forbidden_file"],
    ["src/.aws/credentials", "forbidden_file"],
    ["src/secrets.json", "forbidden_file"],
    ["src/credentials", "forbidden_file"],
    ["Dockerfile", "forbidden_file"],
    ["src/docker-compose.yml", "forbidden_file"],
    ["src/policy/rules.ts", "forbidden_file"],
    ["package.json", "dependency_manifest"],
    ["src/package.json", "dependency_manifest"],
    ["pnpm-lock.yaml", "dependency_manifest"],
    ["package-lock.json", "dependency_manifest"],
    ["yarn.lock", "dependency_manifest"],
    ["pnpm-workspace.yaml", "dependency_manifest"],
    ["src/lib/notify.test.ts", "guardrail_test"],
    ["src/lib/notify.spec.tsx", "guardrail_test"],
    ["src/__tests__/notify.ts", "guardrail_test"],
    ["src/tests/notify.ts", "guardrail_test"],
    ["src/e2e/flow.ts", "guardrail_test"],
  ])("rejects a patch to %s with %s", (path, code) => {
    expect(codes(fileDiff(path))).toContain(code);
  });

  it("rejects an absolute path in the header", () => {
    expect(codes("diff --git a//etc/passwd b//etc/passwd\n--- a//etc/passwd\n+++ b//etc/passwd\n@@ -1 +1 @@\n-a\n+b\n")).toContain("absolute_path");
  });

  it("checks the old path as well as the new one", () => {
    expect(codes("diff --git a/.env b/src/x.ts\n--- a/.env\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n")).toContain("forbidden_file");
  });

  it("rejects when one file among several is forbidden", () => {
    expect(guardDiff(`${fileDiff("src/ok.ts")}${fileDiff("package.json")}`, APPROVED).ok).toBe(false);
  });

  it("honours a root-level approval without letting it reach forbidden files", () => {
    expect(guardDiff(fileDiff("anywhere/file.ts"), ["."]).ok).toBe(true);
    expect(codes(fileDiff(".env"), ["."])).toContain("forbidden_file");
  });
});

describe("guardDiff structural rules", () => {
  it("rejects creating a symlink", () => {
    expect(codes("diff --git a/src/link b/src/link\nnew file mode 120000\n--- /dev/null\n+++ b/src/link\n@@ -0,0 +1 @@\n+/etc/passwd\n")).toContain("symlink_change");
  });

  it.each(["old mode 120000", "new mode 120000", "deleted file mode 120000"])("rejects a symlink mode change via %s", (modeLine) => {
    expect(codes(fileDiff("src/link", "@@ -1 +1 @@\n-a\n+b", `${modeLine}\n`))).toContain("symlink_change");
  });

  it("rejects renames and copies", () => {
    expect(codes("diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\nrename from src/a.ts\nrename to src/b.ts\n")).toContain("rename_not_allowed");
    expect(codes("diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\ncopy from src/a.ts\ncopy to src/b.ts\n")).toContain("rename_not_allowed");
  });

  it("rejects binary changes", () => {
    expect(codes("diff --git a/src/a.png b/src/a.png\nBinary files a/src/a.png and b/src/a.png differ\n")).toContain("binary_change");
    expect(codes("diff --git a/src/a.png b/src/a.png\nGIT binary patch\nliteral 1\n")).toContain("binary_change");
  });

  it.each(["", "   \n\t\n"])("rejects an empty diff %j", (diff) => {
    expect(codes(diff)).toEqual(["empty_diff"]);
  });

  it.each([
    ["no file header", "@@ -1 +1 @@\n-a\n+b\n"],
    ["plain text", "please apply this change\n"],
    ["a header with too many paths", "diff --git a/src/x b/src/x c/src/x\n@@ -1 +1 @@\n-a\n+b\n"],
    ["a file with no hunks", "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n"],
    ["a unified diff with no git header", "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n"],
  ])("rejects a malformed diff: %s", (_name, diff) => {
    expect(codes(diff)).toContain("malformed_diff");
  });

  it("never approves a malformed section hidden beside a valid one", () => {
    expect(guardDiff(`${fileDiff("src/ok.ts")}diff --git a/src/empty.ts b/src/empty.ts\n`, APPROVED).ok).toBe(false);
  });
});

describe("guardDiff budget", () => {
  const manyLines = (count: number) => `@@ -1,${count} +1,${count} @@\n${Array.from({ length: count }, (_, i) => `-old${i}\n+new${i}`).join("\n")}`;

  it("accepts exactly the file budget", () => {
    const diff = Array.from({ length: PATCH_BUDGET.maxFiles }, (_, i) => fileDiff(`src/f${i}.ts`)).join("");
    expect(guardDiff(diff, APPROVED).ok).toBe(true);
  });

  it("rejects one file over budget", () => {
    const diff = Array.from({ length: PATCH_BUDGET.maxFiles + 1 }, (_, i) => fileDiff(`src/f${i}.ts`)).join("");
    expect(codes(diff)).toContain("too_many_files");
  });

  it("accepts exactly the line budget", () => {
    expect(guardDiff(fileDiff("src/a.ts", manyLines(PATCH_BUDGET.maxChangedLines / 2)), APPROVED).ok).toBe(true);
  });

  it("rejects going over the line budget", () => {
    expect(codes(fileDiff("src/a.ts", manyLines(PATCH_BUDGET.maxChangedLines / 2 + 1)))).toContain("too_many_lines");
  });

  it("counts added lines whose content starts with ++ or --", () => {
    const hidden = `@@ -1,1 +1,${PATCH_BUDGET.maxChangedLines + 1} @@\n${Array.from({ length: PATCH_BUDGET.maxChangedLines + 1 }, (_, i) => `+++i${i}`).join("\n")}`;
    expect(codes(fileDiff("src/a.ts", hidden))).toContain("too_many_lines");
    const removed = `@@ -1,${PATCH_BUDGET.maxChangedLines + 1} +1,1 @@\n${Array.from({ length: PATCH_BUDGET.maxChangedLines + 1 }, (_, i) => `---i${i}`).join("\n")}`;
    expect(codes(fileDiff("src/a.ts", removed))).toContain("too_many_lines");
  });
});

describe("guardDiff secret scanning", () => {
  it("rejects secrets in added lines and names the pattern", () => {
    const result = guardDiff(fileDiff("src/a.ts", '@@ -1 +1 @@\n-a\n+const key = "AKIAIOSFODNN7EXAMPLE";'), APPROVED);
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.message).join(" ")).toContain("aws_access_key");
  });

  it("scans an added line whose content starts with ++", () => {
    expect(codes(fileDiff("src/a.ts", "@@ -1 +1 @@\n-a\n+++x; const k = 'AKIAIOSFODNN7EXAMPLE';"))).toContain("secret_pattern");
  });

  it("does not leak the secret value in the failure message", () => {
    const result = guardDiff(fileDiff("src/a.ts", "@@ -1 +1 @@\n-a\n+AKIAIOSFODNN7EXAMPLE"), APPROVED);
    expect(JSON.stringify(result.failures)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("allows removing a secret", () => {
    expect(guardDiff(fileDiff("src/a.ts", "@@ -1 +1 @@\n-AKIAIOSFODNN7EXAMPLE\n+const key = process.env.KEY;"), APPROVED).ok).toBe(true);
  });
});

describe("repository path helpers", () => {
  it.each([
    ["src/a.ts", "src/a.ts"],
    ["./src/a.ts", "src/a.ts"],
    ["src//a.ts", "src/a.ts"],
    ["src/x/../a.ts", "src/a.ts"],
  ])("normalizes %s", (raw, expected) => {
    expect(normalizeRepoPath(raw)).toBe(expected);
  });

  it.each(["..", "../a", "src/../../a", ".", "a\0b", "a\\b"])("refuses %j", (raw) => {
    expect(normalizeRepoPath(raw)).toBeNull();
  });

  it.each([
    ["C:/windows/system32", "absolute_path"],
    ["src/a\nb.ts", "invalid_characters"],
    ["src\\a.ts", "invalid_characters"],
  ])("checkRepoPath rejects %j as %s", (raw, code) => {
    expect(checkRepoPath(raw, APPROVED)).toBe(code);
  });

  it.each([".env", ".env.local", "apps/x/.env.production", ".envrc", ".npmrc", ".yarnrc.yml", ".git/config", ".ssh/id_rsa", ".aws/credentials", "id_ed25519", "cert.pem", "server.key", "store.p12", "app.pfx", "release.keystore", "node_modules/x/index.js", ".next/cache", "dist/main.js", "coverage/lcov.info"])(
    "snapshot excludes %s",
    (path) => {
      expect(isExcludedFromSnapshot(path)).toBe(true);
    },
  );

  it.each(["src/app/page.tsx", "package.json", "pnpm-lock.yaml", "README.md", "src/env.ts", "src/keyboard.ts"])("snapshot keeps %s", (path) => {
    expect(isExcludedFromSnapshot(path)).toBe(false);
  });
});
