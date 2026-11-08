import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

const BLOCKED_V4: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4ToInt(address: string): number {
  return address.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inRange(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(address) & mask) === (v4ToInt(base) & mask);
}

function expandV6(address: string): string {
  const hexOnly = address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_match, a: string, b: string, c: string, d: string) => {
    const group = (high: string, low: string) => ((Number(high) << 8) | Number(low)).toString(16);
    return `${group(a, b)}:${group(c, d)}`;
  });
  const [head = "", tail = ""] = hexOnly.toLowerCase().split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const fill = hexOnly.includes("::") ? 8 - headParts.length - tailParts.length : 0;
  return [...headParts, ...Array<string>(Math.max(fill, 0)).fill("0"), ...tailParts]
    .map((part) => part.padStart(4, "0"))
    .join(":");
}

// IPv4-compatible (::a.b.c.d), IPv4-mapped (::ffff:a.b.c.d) and IPv4-translated (::ffff:0:a.b.c.d).
const EMBEDS_V4 = /^0000:0000:0000:0000:(0000:0000|0000:ffff|ffff:0000):/;

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !BLOCKED_V4.some(([base, bits]) => inRange(address, base, bits));
  if (family !== 6) return false;
  const full = expandV6(address);
  if (EMBEDS_V4.test(full)) {
    const parts = full.split(":");
    const high = Number.parseInt(parts[6] ?? "0", 16);
    const low = Number.parseInt(parts[7] ?? "0", 16);
    return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return !/^(f[cd]|fe[89ab]|ff|2001:0db8|0064:ff9b|2002)/.test(full);
}

export type TargetRejection =
  | "invalid_url"
  | "scheme_not_allowed"
  | "credentials_in_url"
  | "fragment_not_allowed"
  | "ip_literal_not_allowed"
  | "port_not_allowed"
  | "hostname_not_allowed"
  | "dns_failed"
  | "resolves_to_private_address";

export type TargetCheck = { ok: true; url: URL; origin: string; addresses: string[] } | { ok: false; reason: TargetRejection };

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((item) => item.address);
};

const FORBIDDEN_SUFFIXES = [".local", ".localhost", ".internal", ".intranet", ".lan", ".home", ".corp", ".test"];

export function parsePublicTarget(raw: string): { ok: true; url: URL } | { ok: false; reason: TargetRejection } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "scheme_not_allowed" };
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };
  if (url.hash) return { ok: false, reason: "fragment_not_allowed" };
  if (url.port && url.port !== "443") return { ok: false, reason: "port_not_allowed" };
  const hostname = url.hostname.replace(/\.$/, "");
  if (net.isIP(hostname.replace(/^\[|\]$/g, ""))) return { ok: false, reason: "ip_literal_not_allowed" };
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) return { ok: false, reason: "ip_literal_not_allowed" };
  if (!hostname.includes(".") || hostname === "localhost") return { ok: false, reason: "hostname_not_allowed" };
  if (FORBIDDEN_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return { ok: false, reason: "hostname_not_allowed" };
  }
  return { ok: true, url };
}

export async function checkPublicTarget(raw: string, resolver: Resolver = defaultResolver): Promise<TargetCheck> {
  const parsed = parsePublicTarget(raw);
  if (!parsed.ok) return parsed;
  let addresses: string[];
  try {
    addresses = await resolver(parsed.url.hostname);
  } catch {
    return { ok: false, reason: "dns_failed" };
  }
  if (addresses.length === 0) return { ok: false, reason: "dns_failed" };
  if (addresses.some((address) => !isPublicAddress(address))) {
    return { ok: false, reason: "resolves_to_private_address" };
  }
  return { ok: true, url: parsed.url, origin: parsed.url.origin, addresses };
}

export const TARGET_REJECTION_COPY: Record<TargetRejection, string> = {
  invalid_url: "That is not a valid web address.",
  scheme_not_allowed: "Only https:// addresses can be tested.",
  credentials_in_url: "Remove the username or password from the address.",
  fragment_not_allowed: "Remove the #fragment from the address.",
  ip_literal_not_allowed: "Use a domain name, not an IP address.",
  port_not_allowed: "Only the standard https port can be tested.",
  hostname_not_allowed: "That hostname is not a public website.",
  dns_failed: "That hostname could not be resolved.",
  resolves_to_private_address: "That hostname points to a private network, which Inlet will not contact.",
};

export function verificationRecord(token: string): string {
  return `inlet-verification=${token}`;
}
