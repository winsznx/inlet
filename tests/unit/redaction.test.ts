import { describe, expect, it } from "vitest";
import { ArtifactCollector, redactText, redactUrl, REDACTION_VERSION } from "@inlet/evidence";
import { findSecretPatterns, redactSecrets } from "@inlet/policy";
import type { RunnerArtifact } from "@inlet/domain";

const SAMPLES: [string, string][] = [
  ["private_key", "-----BEGIN RSA PRIVATE KEY-----"],
  ["private_key", "-----BEGIN PRIVATE KEY-----"],
  ["private_key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
  ["aws_access_key", "AKIAIOSFODNN7EXAMPLE"],
  ["github_token", `ghp_${"a1B2".repeat(10)}`],
  ["github_token", `ghs_${"a1B2".repeat(10)}`],
  ["github_app_token", `github_pat_${"a1B2_".repeat(9)}`],
  ["slack_token", "xoxb-1234567890-abcdefghij"],
  ["stripe_key", `sk_live_${"a1B2".repeat(6)}`],
  ["stripe_key", `rk_live_${"a1B2".repeat(6)}`],
  ["openai_style_key", `sk-${"a1B2".repeat(10)}`],
  ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLWJ5dGVz"],
  ["connection_string", "postgres://admin:hunter22@db.example.com:5432/app"],
  ["connection_string", "redis://user:pa55word@cache.example.com/0"],
  ["assigned_secret", 'password = "hunter2hunter2"'],
  ["assigned_secret", "API_KEY: 'abcdefgh12345678'"],
  ["assigned_secret", 'auth-token="abcdefgh12345678"'],
];

describe("secret patterns", () => {
  it.each(SAMPLES)("%s detects %s", (name, sample) => {
    expect(findSecretPatterns(`before ${sample} after`)).toContain(name);
  });

  it.each(SAMPLES)("%s is removed from %s", (name, sample) => {
    const redacted = redactSecrets(`before ${sample} after`);
    expect(redacted).not.toContain(sample);
    expect(redacted).toContain(`[redacted:${name}]`);
    expect(redacted.startsWith("before ")).toBe(true);
  });

  it.each([
    "const total = items.length;",
    "password must be at least 10 characters",
    'password = "short"',
    "postgres://localhost:5432/app",
    "https://example.com/path",
    "sk-short",
    "AKIA123",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(findSecretPatterns(text)).toEqual([]);
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts every occurrence, not just the first", () => {
    const redacted = redactSecrets("AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLF");
    expect(redacted).toBe("[redacted:aws_access_key] and [redacted:aws_access_key]");
  });

  it("removes the body of a PEM private key, not just its header", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    const redacted = redactSecrets(`log line\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nnext line`);
    expect(redacted).not.toContain(body);
    expect(redacted).toBe("log line\n[redacted:private_key]\nnext line");
  });

  it("removes a truncated PEM private key through to the end of the text", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    expect(redactSecrets(`-----BEGIN PRIVATE KEY-----\n${body}`)).toBe("[redacted:private_key]");
  });
});

describe("redactText", () => {
  const token = `INLET-TEST-${"a".repeat(28)}1234`;

  it("masks correlation tokens down to their suffix", () => {
    const redacted = redactText(`submitted ${token} ok`);
    expect(redacted).toBe("submitted INLET-TEST-••••1234 ok");
  });

  it("removes email addresses by default", () => {
    expect(redactText("from person.name+tag@example.co.uk now")).toBe("from [email] now");
  });

  it("can keep email addresses when asked", () => {
    expect(redactText("to ops@example.com", { keepEmails: true })).toBe("to ops@example.com");
  });

  it("removes secrets and tokens from the same text", () => {
    const redacted = redactText(`${token} AKIAIOSFODNN7EXAMPLE`);
    expect(redacted).not.toContain("AKIA");
    expect(redacted).not.toContain("a".repeat(28));
  });
});

describe("redactUrl", () => {
  it("drops the query string and fragment", () => {
    expect(redactUrl("https://example.com/contact?token=abc#frag")).toBe("https://example.com/contact");
  });

  it("drops embedded credentials", () => {
    expect(redactUrl("https://user:secret@example.com/x")).toBe("https://example.com/x");
  });

  it("does not echo invalid input", () => {
    expect(redactUrl("not a url with secret")).toBe("[invalid-url]");
  });
});

describe("ArtifactCollector", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("image-bytes")]);

  const text = (name: string, body: string): RunnerArtifact => ({ t: "artifact", kind: "log", name, mime: "text/plain", b64: Buffer.from(body).toString("base64") });
  const png = (name: string, data: Buffer): RunnerArtifact => ({ t: "artifact", kind: "screenshot-after", name, mime: "image/png", b64: data.toString("base64") });

  it("redacts text artifacts before accepting them", () => {
    const accepted = new ArtifactCollector({ maxBytes: 10_000, maxFiles: 5 }).accept(text("log.txt", "key AKIAIOSFODNN7EXAMPLE from me@example.com"));
    expect(accepted?.data.toString()).toBe("key [redacted:aws_access_key] from [email]");
  });

  it("accepts a real PNG unchanged", () => {
    expect(new ArtifactCollector({ maxBytes: 10_000, maxFiles: 5 }).accept(png("a.png", PNG))?.data.equals(PNG)).toBe(true);
  });

  it("rejects a file claiming to be a PNG", () => {
    const collector = new ArtifactCollector({ maxBytes: 10_000, maxFiles: 5 });
    expect(collector.accept(png("a.png", Buffer.from("<script>alert(1)</script>")))).toBeNull();
    expect(collector.rejected).toEqual(["a.png: not a PNG"]);
  });

  it("enforces the file budget", () => {
    const collector = new ArtifactCollector({ maxBytes: 10_000, maxFiles: 1 });
    expect(collector.accept(text("one.txt", "one"))).not.toBeNull();
    expect(collector.accept(text("two.txt", "two"))).toBeNull();
    expect(collector.rejected).toEqual(["two.txt: over budget"]);
  });

  it("enforces the byte budget", () => {
    const collector = new ArtifactCollector({ maxBytes: 5, maxFiles: 10 });
    expect(collector.accept(text("big.txt", "123456"))).toBeNull();
    expect(collector.accept(text("ok.txt", "12345"))).not.toBeNull();
    expect(collector.accept(text("more.txt", "1"))).toBeNull();
  });

  it("publishes a redaction version so stored evidence can be audited", () => {
    expect(REDACTION_VERSION).toBeGreaterThanOrEqual(1);
  });
});
