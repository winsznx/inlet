import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { timingSafeEqual, createHash } from "node:crypto";
import { evaluate, isPublicAddress } from "./policy.mjs";

const PROFILE = process.env.SANDBOX_EGRESS_PROFILE ?? "fixture-only";
const SUBNET = process.env.SANDBOX_SUBNET_PREFIX ?? "172.30.";
const FIXTURE_SUFFIX = process.env.FIXTURE_DOMAIN_SUFFIX ?? ".acme-demo.test";
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 3128);
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 3191);
const TOKEN = process.env.EGRESS_CONTROL_TOKEN;
if (!TOKEN) throw new Error("EGRESS_CONTROL_TOKEN is required");

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const sessionsByIp = new Map();
const sessionsById = new Map();
const unattributedDenials = [];

const interfaces = Object.values(networkInterfaces())
  .flat()
  .filter((item) => item?.family === "IPv4" && !item.internal);
const sandboxAddress = interfaces.find((item) => item.address.startsWith(SUBNET))?.address;
const controlAddress = interfaces.find((item) => !item.address.startsWith(SUBNET))?.address;
if (!sandboxAddress || !controlAddress) {
  throw new Error("Gateway must be attached to both the sandbox and the control network");
}

function normalizeIp(address) {
  return (address ?? "").replace(/^::ffff:/, "");
}

function record(session, entry) {
  const decision = { at: new Date().toISOString(), ...entry };
  console.log(JSON.stringify({ event: "egress.decision", session: session?.id ?? null, ...decision }));
  if (!session) {
    unattributedDenials.push(decision);
    if (unattributedDenials.length > 500) unattributedDenials.shift();
    return;
  }
  session.decisions.push(decision);
  if (session.decisions.length > 2000) session.decisions.shift();
}

async function resolveTarget(host, mode) {
  if (net.isIP(host)) {
    if (mode === "public" && !isPublicAddress(host)) throw new Error("private_address");
    return host;
  }
  const results = await lookup(host, { all: true });
  if (results.length === 0) throw new Error("dns_empty");
  if (mode === "public") {
    if (results.some((item) => !isPublicAddress(item.address))) throw new Error("private_address");
  }
  return results[0].address;
}

async function authorize(sourceIp, host, port, action, path) {
  const session = sessionsByIp.get(sourceIp);
  const verdict = evaluate({ session, host, port, profile: PROFILE, fixtureSuffix: FIXTURE_SUFFIX });
  const target = `${host}:${port}`;
  if (!verdict.allowed) {
    record(session, { action, target, path, allowed: false, reason: verdict.reason, sourceIp });
    return null;
  }
  try {
    const address = await resolveTarget(host, verdict.resolveMode);
    record(session, { action, target, path, allowed: true, reason: verdict.reason, sourceIp });
    return { session, address };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "dns_failed";
    record(session, { action, target, path, allowed: false, reason, sourceIp });
    return null;
  }
}

function parseTarget(authority, defaultPort) {
  try {
    const url = new URL(`http://${authority}`);
    return { host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: Number(url.port || defaultPort) };
  } catch {
    return null;
  }
}

const proxy = http.createServer(async (req, res) => {
  const sourceIp = normalizeIp(req.socket.remoteAddress);
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end("absolute-form request required");
    return;
  }
  if (url.protocol !== "http:") {
    res.writeHead(400).end("unsupported scheme");
    return;
  }
  const host = url.hostname.toLowerCase();
  const port = Number(url.port || 80);
  const granted = await authorize(sourceIp, host, port, "http", url.pathname);
  if (!granted) {
    res.writeHead(403, { "content-type": "text/plain", "x-inlet-egress": "denied" });
    res.end("Blocked by Inlet egress policy");
    return;
  }
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())),
  );
  const upstream = http.request(
    { host: granted.address, port, method: req.method, path: url.pathname + url.search, headers, timeout: 30_000 },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.on("data", (chunk) => {
        granted.session.bytes += chunk.length;
      });
      response.pipe(res);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502).end("Upstream connection failed");
    else res.destroy();
  });
  req.pipe(upstream);
});

proxy.on("connect", async (req, clientSocket, head) => {
  const sourceIp = normalizeIp(clientSocket.remoteAddress);
  clientSocket.on("error", () => clientSocket.destroy());
  const target = parseTarget(req.url, 443);
  if (!target) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const granted = await authorize(sourceIp, target.host, target.port, "connect");
  if (!granted) {
    clientSocket.end("HTTP/1.1 403 Forbidden\r\nX-Inlet-Egress: denied\r\n\r\n");
    return;
  }
  const upstream = net.connect(target.port, granted.address, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  upstream.on("data", (chunk) => {
    granted.session.bytes += chunk.length;
    if (granted.session.bytes > granted.session.maxBytes) {
      upstream.destroy();
      clientSocket.destroy();
    }
  });
  upstream.setTimeout(60_000, () => upstream.destroy());
  upstream.on("error", () => clientSocket.destroy());
  upstream.on("close", () => clientSocket.destroy());
  clientSocket.on("close", () => upstream.destroy());
});

function authorized(req) {
  const header = req.headers.authorization ?? "";
  const expected = createHash("sha256").update(`Bearer ${TOKEN}`).digest();
  const actual = createHash("sha256").update(header).digest();
  return timingSafeEqual(expected, actual);
}

function readJson(req, limit = 64_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function removeSession(id) {
  const session = sessionsById.get(id);
  if (!session) return false;
  sessionsById.delete(id);
  sessionsByIp.delete(session.ip);
  return true;
}

const control = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://control");
  if (url.pathname === "/health") {
    send(res, 200, { ok: true, profile: PROFILE, sessions: sessionsById.size, sandboxAddress });
    return;
  }
  if (!authorized(req)) {
    send(res, 401, { error: "unauthorized" });
    return;
  }
  const match = /^\/sessions\/([\w-]+)(\/decisions)?$/.exec(url.pathname);
  if (url.pathname === "/sessions" && req.method === "GET") {
    send(res, 200, { sessions: [...sessionsById.values()].map(({ id, ip, expiresAt }) => ({ id, ip, expiresAt })) });
    return;
  }
  if (url.pathname === "/unattributed" && req.method === "GET") {
    send(res, 200, { decisions: unattributedDenials });
    return;
  }
  if (!match) {
    send(res, 404, { error: "not_found" });
    return;
  }
  const [, id, decisions] = match;
  if (decisions && req.method === "GET") {
    const session = sessionsById.get(id);
    if (!session) return send(res, 404, { error: "unknown_session" });
    const after = Number(url.searchParams.get("after") ?? 0);
    return send(res, 200, { decisions: session.decisions.slice(after), total: session.decisions.length });
  }
  if (req.method === "PUT" && !decisions) {
    try {
      const body = await readJson(req);
      if (typeof body.ip !== "string" || !body.ip.startsWith(SUBNET) || !Array.isArray(body.allow)) {
        return send(res, 400, { error: "invalid_session" });
      }
      removeSession(id);
      const session = {
        id,
        ip: body.ip,
        allow: body.allow,
        expiresAt: Date.now() + Number(body.ttlSeconds ?? 120) * 1000,
        maxBytes: Number(body.maxBytes ?? 256 * 1024 * 1024),
        bytes: 0,
        decisions: [],
      };
      sessionsById.set(id, session);
      sessionsByIp.set(session.ip, session);
      return send(res, 201, { id });
    } catch {
      return send(res, 400, { error: "invalid_body" });
    }
  }
  if (req.method === "DELETE" && !decisions) {
    return send(res, 200, { removed: removeSession(id) });
  }
  return send(res, 405, { error: "method_not_allowed" });
});

setInterval(() => {
  for (const session of sessionsById.values()) {
    if (session.expiresAt + 600_000 < Date.now()) removeSession(session.id);
  }
}, 30_000).unref();

proxy.listen(PROXY_PORT, sandboxAddress, () => {
  console.log(JSON.stringify({ event: "proxy.listening", address: sandboxAddress, port: PROXY_PORT, profile: PROFILE }));
});
control.listen(CONTROL_PORT, controlAddress, () => {
  console.log(JSON.stringify({ event: "control.listening", address: controlAddress, port: CONTROL_PORT }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(0));
}
