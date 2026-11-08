import { describe, expect, it } from "vitest";
import { evaluate, isPublicAddress, PACKAGE_MIRRORS } from "../../infra/egress-gateway/policy.mjs";
import type { EgressSession } from "../../infra/egress-gateway/policy.mjs";

const NOW = Date.now();
const SUFFIX = ".acme-demo.test";

function session(overrides: Partial<EgressSession> = {}): EgressSession {
  return {
    expiresAt: NOW + 60_000,
    bytes: 0,
    maxBytes: 1_000,
    allow: [
      { host: "healthy.acme-demo.test", port: 3110, scope: "fixture" },
      { host: "www.customer.com", port: 443, scope: "verified" },
      { host: "registry.npmjs.org", port: 443, scope: "mirror" },
    ],
    ...overrides,
  };
}

const input = { profile: "fixture-only", fixtureSuffix: SUFFIX };

describe("egress evaluate", () => {
  it("denies with no session", () => {
    expect(evaluate({ ...input, session: null, host: "healthy.acme-demo.test", port: 3110 })).toEqual({ allowed: false, reason: "no_session" });
  });

  it("denies an expired session", () => {
    expect(evaluate({ ...input, session: session({ expiresAt: NOW - 1 }), host: "healthy.acme-demo.test", port: 3110 }).reason).toBe("session_expired");
  });

  it("denies when the byte budget is spent", () => {
    expect(evaluate({ ...input, session: session({ bytes: 1_001 }), host: "healthy.acme-demo.test", port: 3110 }).reason).toBe("byte_budget_exceeded");
  });

  it.each([
    ["evil.net", 443],
    ["healthy.acme-demo.test", 3111],
    ["169.254.169.254", 80],
    ["www.customer.com", 80],
  ])("denies %s:%d as not authorized", (host, port) => {
    expect(evaluate({ ...input, session: session(), host, port })).toEqual({ allowed: false, reason: "destination_not_authorized" });
  });

  it("allows an authorized fixture host via docker DNS", () => {
    expect(evaluate({ ...input, session: session(), host: "healthy.acme-demo.test", port: 3110 })).toEqual({ allowed: true, reason: "authorized_fixture", resolveMode: "docker" });
  });

  it("refuses a fixture entry that points outside the fixture domain", () => {
    const forged = session({ allow: [{ host: "evil.net", port: 80, scope: "fixture" }] });
    expect(evaluate({ ...input, session: forged, host: "evil.net", port: 80 })).toEqual({ allowed: false, reason: "not_a_fixture_host" });
  });

  it("allows only the approved package mirror", () => {
    expect([...PACKAGE_MIRRORS]).toEqual(["registry.npmjs.org:443"]);
    expect(evaluate({ ...input, session: session(), host: "registry.npmjs.org", port: 443 })).toEqual({ allowed: true, reason: "authorized_mirror", resolveMode: "public" });
    const forged = session({ allow: [{ host: "evil.net", port: 443, scope: "mirror" }] });
    expect(evaluate({ ...input, session: forged, host: "evil.net", port: 443 })).toEqual({ allowed: false, reason: "not_an_approved_mirror" });
  });

  it("keeps verified customer origins disabled outside the verified-public profile", () => {
    expect(evaluate({ ...input, session: session(), host: "www.customer.com", port: 443 })).toEqual({ allowed: false, reason: "public_egress_disabled" });
  });

  it("allows a verified origin under the verified-public profile", () => {
    expect(evaluate({ ...input, profile: "verified-public", session: session(), host: "www.customer.com", port: 443 })).toEqual({ allowed: true, reason: "authorized_origin", resolveMode: "public" });
  });
});

describe("egress isPublicAddress", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "ff02::1", "2001:db8::1", "64:ff9b::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-address"])(
    "blocks %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );

  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(["::ffff:7f00:1", "::127.0.0.1", "::7f00:1", "0:0:0:0:0:ffff:127.0.0.1", "2002:7f00:1::"])("rejects IPv6 forms that embed a private IPv4 address: %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});
