import { describe, expect, it } from "vitest";
import { checkPublicTarget, isPublicAddress, parsePublicTarget } from "@inlet/policy";
import type { Resolver, TargetRejection } from "@inlet/policy";

const PUBLIC_V4 = ["93.184.216.34"];
const publicResolver: Resolver = () => Promise.resolve(PUBLIC_V4);

function rejection(raw: string): TargetRejection | "accepted" {
  const parsed = parsePublicTarget(raw);
  return parsed.ok ? "accepted" : parsed.reason;
}

describe("parsePublicTarget scheme and shape", () => {
  it.each([
    ["http://example.com/contact", "scheme_not_allowed"],
    ["ftp://example.com/", "scheme_not_allowed"],
    ["file:///etc/passwd", "scheme_not_allowed"],
    ["javascript:alert(1)", "scheme_not_allowed"],
    ["gopher://example.com/", "scheme_not_allowed"],
    ["not a url", "invalid_url"],
    ["", "invalid_url"],
    ["https://user:pass@example.com/", "credentials_in_url"],
    ["https://user@example.com/", "credentials_in_url"],
    ["https://example.com/contact#frag", "fragment_not_allowed"],
  ] satisfies [string, TargetRejection][])("rejects %s as %s", (raw, reason) => {
    expect(rejection(raw)).toBe(reason);
  });

  it("accepts a plain https URL", () => {
    expect(rejection("https://example.com/contact")).toBe("accepted");
  });
});

describe("parsePublicTarget hostname canonicalization", () => {
  it("lowercases a mixed-case scheme and host", () => {
    const parsed = parsePublicTarget("HtTpS://ExAmPlE.CoM/Contact");
    expect(parsed.ok && parsed.url.hostname).toBe("example.com");
    expect(parsed.ok && parsed.url.pathname).toBe("/Contact");
  });

  it("converts a homoglyph host to punycode so allowlists see the real name", () => {
    const parsed = parsePublicTarget("https://аpple.com/");
    expect(parsed.ok && parsed.url.hostname).toMatch(/^xn--/);
  });

  it("keeps explicit punycode intact", () => {
    const parsed = parsePublicTarget("https://xn--mller-kva.de/");
    expect(parsed.ok && parsed.url.hostname).toBe("xn--mller-kva.de");
  });

  it.each([
    "https://localhost/",
    "https://LOCALHOST/",
    "https://localhost./",
    "https://localhost。/",
    "https://ⓛocalhost/",
    "https://intranet/",
    "https://foo.local/",
    "https://foo.LOCAL/",
    "https://foo.local./",
    "https://api.localhost/",
    "https://db.internal/",
    "https://nas.lan/",
    "https://printer.home/",
    "https://wiki.corp/",
    "https://acme-demo.test/",
  ])("rejects non-public hostname %s", (raw) => {
    expect(rejection(raw)).toBe("hostname_not_allowed");
  });

  it.each([
    "https://127.0.0.1/",
    "https://10.0.0.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://8.8.8.8/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://0177.0.0.1/",
    "https://0x7f.0.0.1/",
    "https://127.1/",
    "https://１２７.０.０.１/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[2606:4700:4700::1111]/",
  ])("rejects IP literal %s", (raw) => {
    expect(rejection(raw)).toBe("ip_literal_not_allowed");
  });
});

describe("parsePublicTarget ports", () => {
  it("accepts the default https port and drops it", () => {
    const parsed = parsePublicTarget("https://example.com:443/");
    expect(parsed.ok && parsed.url.port).toBe("");
  });

  it.each(["https://example.com:8443/", "https://example.com:22/", "https://example.com:80/", "https://example.com:6379/"])("rejects %s", (raw) => {
    expect(rejection(raw)).toBe("port_not_allowed");
  });
});

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "0.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
  ])("blocks IPv4 %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.169.0.1", "198.17.255.255", "198.20.0.0", "223.255.255.255"])(
    "allows public IPv4 %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "FE80::1",
    "febf::1",
    "ff02::1",
    "2001:db8::1",
    "2001:0db8:85a3::8a2e:370:7334",
    "64:ff9b::7f00:1",
  ])("blocks IPv6 %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "::ffff:127.0.0.1",
    "::FFFF:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "0:0:0:0:0:ffff:127.0.0.1",
    "0000:0000:0000:0000:0000:ffff:7f00:0001",
    "::127.0.0.1",
    "::7f00:1",
    "::ffff:0:7f00:1",
    "2002:7f00:1::",
    "2002:a00:1::1",
  ])("blocks IPv4-embedding IPv6 %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8", "::ffff:808:808"])("allows public IPv6 %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(["example.com", "", "999.1.1.1", "1.2.3", "fe80::1%lo0"])("treats non-address %j as not public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe("checkPublicTarget with an injected resolver", () => {
  it("returns the pinned addresses for a public host", async () => {
    const check = await checkPublicTarget("https://example.com/contact", publicResolver);
    expect(check).toMatchObject({ ok: true, origin: "https://example.com", addresses: PUBLIC_V4 });
  });

  it("does not consult DNS for a syntactically rejected target", async () => {
    let lookups = 0;
    const counting: Resolver = () => {
      lookups += 1;
      return Promise.resolve(PUBLIC_V4);
    };
    await checkPublicTarget("http://example.com/", counting);
    expect(lookups).toBe(0);
  });

  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::1", "::ffff:192.168.0.1"])("rejects a public-looking name resolving to %s", async (address) => {
    const check = await checkPublicTarget("https://totally-public.example.com/", () => Promise.resolve([address]));
    expect(check).toEqual({ ok: false, reason: "resolves_to_private_address" });
  });

  it("rejects when any one of several records is private", async () => {
    const check = await checkPublicTarget("https://mixed.example.com/", () => Promise.resolve(["93.184.216.34", "10.0.0.5"]));
    expect(check).toEqual({ ok: false, reason: "resolves_to_private_address" });
  });

  it("catches DNS rebinding because every check resolves afresh", async () => {
    const answers = [["93.184.216.34"], ["127.0.0.1"]];
    const rebinding: Resolver = () => Promise.resolve(answers.shift() ?? []);
    expect((await checkPublicTarget("https://rebind.example.com/", rebinding)).ok).toBe(true);
    expect(await checkPublicTarget("https://rebind.example.com/", rebinding)).toEqual({ ok: false, reason: "resolves_to_private_address" });
  });

  it("reports resolver failure and empty answers as dns_failed, never as safe", async () => {
    expect(await checkPublicTarget("https://gone.example.com/", () => Promise.reject(new Error("ENOTFOUND")))).toEqual({ ok: false, reason: "dns_failed" });
    expect(await checkPublicTarget("https://empty.example.com/", () => Promise.resolve([]))).toEqual({ ok: false, reason: "dns_failed" });
  });

  it("applies the same checks to each hop of a redirect chain", async () => {
    const hops = ["https://example.com/start", "http://example.com/plain", "https://10.0.0.1/admin", "https://metadata.example.com/"];
    const resolver: Resolver = (hostname) => Promise.resolve(hostname === "metadata.example.com" ? ["169.254.169.254"] : PUBLIC_V4);
    const verdicts = await Promise.all(hops.map(async (hop) => {
      const check = await checkPublicTarget(hop, resolver);
      return check.ok ? "ok" : check.reason;
    }));
    expect(verdicts).toEqual(["ok", "scheme_not_allowed", "ip_literal_not_allowed", "resolves_to_private_address"]);
  });
});
