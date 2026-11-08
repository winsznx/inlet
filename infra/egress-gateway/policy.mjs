import net from "node:net";

export const PACKAGE_MIRRORS = new Set(["registry.npmjs.org:443"]);

const BLOCKED_V4 = [
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

function v4ToInt(address) {
  return address.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inV4Range(address, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(address) & mask) === (v4ToInt(base) & mask);
}

function expandV6(address) {
  const hexOnly = address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_match, a, b, c, d) => {
    const group = (high, low) => ((Number(high) << 8) | Number(low)).toString(16);
    return `${group(a, b)}:${group(c, d)}`;
  });
  const [head = "", tail = ""] = hexOnly.toLowerCase().split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const fill = hexOnly.includes("::") ? 8 - headParts.length - tailParts.length : 0;
  return [...headParts, ...Array(Math.max(fill, 0)).fill("0"), ...tailParts].map((part) => part.padStart(4, "0")).join(":");
}

const EMBEDS_V4 = /^0000:0000:0000:0000:(0000:0000|0000:ffff|ffff:0000):/;

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !BLOCKED_V4.some(([base, bits]) => inV4Range(address, base, bits));
  if (family !== 6) return false;
  const full = expandV6(address);
  if (EMBEDS_V4.test(full)) {
    const parts = full.split(":");
    const high = Number.parseInt(parts[6], 16);
    const low = Number.parseInt(parts[7], 16);
    return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return !/^(f[cd]|fe[89ab]|ff|2001:0db8|0064:ff9b|2002)/.test(full);
}

export function evaluate({ session, host, port, profile, fixtureSuffix }) {
  const target = `${host}:${port}`;
  if (!session) return { allowed: false, reason: "no_session" };
  if (session.expiresAt < Date.now()) return { allowed: false, reason: "session_expired" };
  if (session.bytes > session.maxBytes) return { allowed: false, reason: "byte_budget_exceeded" };

  const entry = session.allow.find((item) => `${item.host}:${item.port}` === target);
  if (!entry) return { allowed: false, reason: "destination_not_authorized" };

  if (entry.scope === "fixture") {
    if (!host.endsWith(fixtureSuffix)) return { allowed: false, reason: "not_a_fixture_host" };
    return { allowed: true, reason: "authorized_fixture", resolveMode: "docker" };
  }
  if (entry.scope === "mirror") {
    if (!PACKAGE_MIRRORS.has(target)) return { allowed: false, reason: "not_an_approved_mirror" };
    return { allowed: true, reason: "authorized_mirror", resolveMode: "public" };
  }
  if (profile !== "verified-public") return { allowed: false, reason: "public_egress_disabled" };
  return { allowed: true, reason: "authorized_origin", resolveMode: "public" };
}
