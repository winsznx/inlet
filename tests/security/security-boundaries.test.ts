import { describe, expect, it } from "vitest";
import { findSecretPatterns, guardDiff, parsePublicTarget, redactSecrets } from "@inlet/policy";

describe("security boundaries", () => {
  it("rejects private, credential-bearing, and unsafe targets before network access", () => {
    expect(parsePublicTarget("https://user:password@example.com/")).toMatchObject({ ok: false, reason: "credentials_in_url" });
    expect(parsePublicTarget("https://127.0.0.1/")).toMatchObject({ ok: false, reason: "ip_literal_not_allowed" });
    expect(parsePublicTarget("file:///etc/passwd")).toMatchObject({ ok: false, reason: "scheme_not_allowed" });
  });

  it("detects and redacts representative credentials", () => {
    const secret = "const key = \"AKIAIOSFODNN7EXAMPLE\";";
    expect(findSecretPatterns(secret)).toContain("aws_access_key");
    expect(redactSecrets(secret)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("rejects a patch that escapes approved source paths or adds a secret", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+const key = \"AKIAIOSFODNN7EXAMPLE\";",
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +1 @@",
      "-old",
      "+secret",
    ].join("\n");
    const result = guardDiff(diff, ["src"]);
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toEqual(expect.arrayContaining(["secret_pattern", "forbidden_file"]));
    expect(JSON.stringify(result.failures)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
