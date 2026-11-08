import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, safeEqual, signDownload, verifyDownload } from "@inlet/evidence";

const ARTIFACT = "01960000-0000-7000-8000-000000000001";
const USER = "01960000-0000-7000-8000-00000000000a";
const FIVE_MINUTES = 5 * 60_000;
const NOW = 1_800_000_000_000;

describe("download tokens", () => {
  it("verifies for the same artifact and subject", () => {
    expect(verifyDownload(ARTIFACT, USER, signDownload(ARTIFACT, USER, NOW), NOW)).toBe(true);
  });

  it("is bound to the artifact", () => {
    expect(verifyDownload("01960000-0000-7000-8000-000000000002", USER, signDownload(ARTIFACT, USER, NOW), NOW)).toBe(false);
  });

  it("is bound to the subject", () => {
    expect(verifyDownload(ARTIFACT, "01960000-0000-7000-8000-00000000000b", signDownload(ARTIFACT, USER, NOW), NOW)).toBe(false);
  });

  it("is valid until its five-minute expiry and not after", () => {
    const token = signDownload(ARTIFACT, USER, NOW);
    expect(verifyDownload(ARTIFACT, USER, token, NOW + FIVE_MINUTES)).toBe(true);
    expect(verifyDownload(ARTIFACT, USER, token, NOW + FIVE_MINUTES + 1)).toBe(false);
  });

  it("rejects an extended expiry because the signature covers it", () => {
    const [expires, signature] = signDownload(ARTIFACT, USER, NOW).split(".");
    expect(verifyDownload(ARTIFACT, USER, `${Number(expires) + 86_400_000}.${signature}`, NOW + FIVE_MINUTES + 1)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const [expires, signature = ""] = signDownload(ARTIFACT, USER, NOW).split(".");
    const flipped = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect(verifyDownload(ARTIFACT, USER, `${expires}.${flipped}`, NOW)).toBe(false);
  });

  it.each(["", ".", "abc", `${NOW + 1000}`, `${NOW + 1000}.`, ".signature", "not.a.token", "NaN.signature"])("rejects malformed token %j", (token) => {
    expect(verifyDownload(ARTIFACT, USER, token, NOW)).toBe(false);
  });
});

describe("secret encryption", () => {
  it.each(["hunter2", "", "unicode ✓ päss", "x".repeat(10_000)])("round-trips %j", (plain) => {
    expect(decryptSecret(encryptSecret(plain))).toBe(plain);
  });

  it("uses a fresh IV, so equal secrets never share ciphertext", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("does not contain the plaintext", () => {
    const plain = "plaintext-marker-value";
    const sealed = encryptSecret(plain);
    expect(sealed).not.toContain(plain);
    expect(Buffer.from(sealed.split(".")[3] ?? "", "base64").toString("utf8")).not.toContain(plain);
  });

  it("uses the versioned v1 envelope", () => {
    expect(encryptSecret("x").split(".")).toHaveLength(4);
    expect(encryptSecret("x").startsWith("v1.")).toBe(true);
  });

  function tamper(sealed: string, index: 1 | 2 | 3): string {
    const parts = sealed.split(".");
    const bytes = Buffer.from(parts[index] ?? "", "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    parts[index] = bytes.toString("base64");
    return parts.join(".");
  }

  it.each([
    ["iv", 1],
    ["auth tag", 2],
    ["ciphertext", 3],
  ] as const)("detects tampering with the %s", (_name, index) => {
    expect(() => decryptSecret(tamper(encryptSecret("do not touch me"), index))).toThrow();
  });

  it("rejects ciphertext moved onto another secret's tag", () => {
    const first = encryptSecret("first-secret").split(".");
    const second = encryptSecret("second-secret").split(".");
    expect(() => decryptSecret(["v1", first[1], first[2], second[3]].join("."))).toThrow();
  });

  it.each(["", "v1", "v1.a", "v1.a.b", "v2.AAAA.AAAA.AAAA", "plaintext"])("refuses malformed envelope %j", (sealed) => {
    expect(() => decryptSecret(sealed)).toThrow();
  });
});

describe("safeEqual", () => {
  it("compares by value", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
  });

  it("does not throw on different lengths", () => {
    expect(safeEqual("short", "a much longer value")).toBe(false);
  });
});
