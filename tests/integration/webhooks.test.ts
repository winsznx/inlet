import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@inlet/config";
import { closeDb, count, db, eq, inboundReceipts } from "@inlet/database";
import { apiRequest, createSite, randomId, registerOwner } from "../support/api";
import type { ApiResponse } from "../support/api";

const nowSeconds = () => Math.floor(Date.now() / 1000);
const sign = (secret: string, timestamp: number | string, body: string) => `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
const token = () => `INLET-TEST-${randomUUID().replaceAll("-", "")}`;
const code = (response: ApiResponse) => response.json<{ error: { code: string } }>().error.code;

function post(path: string, body: string, headers: Record<string, string>): Promise<ApiResponse> {
  return fetch(`http://localhost:4000/api/v1${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }).then(async (response) => {
    const text = await response.text();
    return { status: response.status, text, headers: response.headers, json: <T>() => JSON.parse(text) as T };
  });
}

let path: string;
let destinationId: string;
let secret: string;
let otherSecret: string;

function deliver(body: string, timestamp: number | string = nowSeconds(), signature?: string): Promise<ApiResponse> {
  return post(path, body, { "x-inlet-timestamp": String(timestamp), "x-inlet-signature": signature ?? sign(secret, timestamp, body) });
}

beforeAll(async () => {
  const owner = await registerOwner("webhooks");
  const siteId = await createSite(owner, "Webhook site");
  const created = await owner.client.ok<{ id: string; signingSecret: string }>("POST", `/sites/${siteId}/destinations`, { body: { type: "webhook", displayName: "Inbound" } });
  destinationId = created.id;
  secret = created.signingSecret;
  path = `/webhooks/inbound/${destinationId}`;
  const otherSite = await createSite(owner, "Other webhook site");
  otherSecret = (await owner.client.ok<{ signingSecret: string }>("POST", `/sites/${otherSite}/destinations`, { body: { type: "webhook", displayName: "Other" } })).signingSecret;
});

afterAll(async () => {
  await closeDb();
});

describe("inbound webhook signature", () => {
  const payload = () => JSON.stringify({ token: token(), messageId: randomUUID() });

  it("accepts a correctly signed delivery", async () => {
    expect((await deliver(payload())).status).toBe(200);
  });

  it("works without an Origin header because it is not cookie-authenticated", async () => {
    const body = payload();
    const timestamp = nowSeconds();
    const response = await post(path, body, { "x-inlet-timestamp": String(timestamp), "x-inlet-signature": sign(secret, timestamp, body) });
    expect(response.status).toBe(200);
  });

  it("rejects a missing signature", async () => {
    const response = await post(path, payload(), { "x-inlet-timestamp": String(nowSeconds()) });
    expect(response.status).toBe(401);
    expect(code(response)).toBe("SIGNATURE_INVALID");
  });

  it("rejects a missing timestamp", async () => {
    const body = payload();
    const response = await post(path, body, { "x-inlet-signature": sign(secret, nowSeconds(), body) });
    expect(response.status).toBe(401);
  });

  it("rejects a forged signature", async () => {
    expect((await deliver(payload(), nowSeconds(), `sha256=${"0".repeat(64)}`)).status).toBe(401);
  });

  it("rejects a signature that is not hex", async () => {
    expect((await deliver(payload(), nowSeconds(), "sha256=zzzz")).status).toBe(401);
  });

  it("rejects a tampered body", async () => {
    const original = payload();
    const timestamp = nowSeconds();
    expect((await deliver(payload(), timestamp, sign(secret, timestamp, original))).status).toBe(401);
  });

  it("rejects another destination's signing secret", async () => {
    const body = payload();
    const timestamp = nowSeconds();
    expect((await deliver(body, timestamp, sign(otherSecret, timestamp, body))).status).toBe(401);
  });

  it("rejects a signature over a different timestamp", async () => {
    const body = payload();
    const timestamp = nowSeconds();
    expect((await deliver(body, timestamp, sign(secret, timestamp - 1, body))).status).toBe(401);
  });

  it.each([
    ["six minutes old", -360],
    ["six minutes in the future", 360],
  ])("rejects a validly signed delivery %s", async (_name, offset) => {
    const response = await deliver(payload(), nowSeconds() + offset);
    expect(response.status).toBe(401);
    expect(code(response)).toBe("SIGNATURE_INVALID");
  });

  it("rejects a non-numeric timestamp", async () => {
    expect((await deliver(payload(), "yesterday")).status).toBe(401);
  });

  it("rejects a signed payload whose token is not a correlation token", async () => {
    const response = await deliver(JSON.stringify({ token: "hello", messageId: "m" }));
    expect(response.status).toBe(400);
    expect(code(response)).toBe("INVALID_INPUT");
  });

  it("does not reveal whether an unknown destination exists", async () => {
    const body = payload();
    const timestamp = nowSeconds();
    expect((await post(`/webhooks/inbound/${randomId()}`, body, { "x-inlet-timestamp": String(timestamp), "x-inlet-signature": sign(secret, timestamp, body) })).status).toBe(404);
  });
});

describe("inbound webhook replay", () => {
  async function receiptCount(): Promise<number> {
    const [row] = await db().select({ value: count() }).from(inboundReceipts).where(eq(inboundReceipts.destinationId, destinationId));
    return row?.value ?? 0;
  }

  it("records one receipt when the same delivery is replayed", async () => {
    const body = JSON.stringify({ token: token(), messageId: randomUUID() });
    const timestamp = nowSeconds();
    const before = await receiptCount();

    expect((await deliver(body, timestamp)).status).toBe(200);
    expect((await deliver(body, timestamp)).status).toBe(200);

    expect(await receiptCount()).toBe(before + 1);
  });

  it("rejects a captured delivery replayed after the window", async () => {
    const body = JSON.stringify({ token: token(), messageId: randomUUID() });
    const staleTimestamp = nowSeconds() - 3_600;
    const before = await receiptCount();

    expect((await deliver(body, staleTimestamp)).status).toBe(401);

    expect(await receiptCount()).toBe(before);
  });
});

describe("deployment webhook", () => {
  const deploySecret = () => {
    const value = env().DEPLOY_WEBHOOK_SECRET;
    if (!value) throw new Error("DEPLOY_WEBHOOK_SECRET must be set in .env.local");
    return value;
  };

  function deploy(body: string, timestamp: number = nowSeconds(), signature?: string): Promise<ApiResponse> {
    return post("/webhooks/deployment", body, { "x-inlet-timestamp": String(timestamp), "x-inlet-signature": signature ?? sign(deploySecret(), timestamp, body) });
  }

  it("rejects a bad signature", async () => {
    expect((await deploy(JSON.stringify({ incidentId: randomId(), deliveryId: randomUUID() }), nowSeconds(), `sha256=${"a".repeat(64)}`)).status).toBe(401);
  });

  it("rejects a stale signature", async () => {
    expect((await deploy(JSON.stringify({ incidentId: randomId(), deliveryId: randomUUID() }), nowSeconds() - 3_600)).status).toBe(401);
  });

  it("processes a delivery ID once and rejects the replay", async () => {
    const body = JSON.stringify({ incidentId: randomId(), deliveryId: randomUUID() });
    const first = await deploy(body);
    const replay = await deploy(body);

    expect(first.status).toBe(409);
    expect(code(first)).toBe("INVALID_TRANSITION");
    expect(replay.status).toBe(409);
    expect(code(replay)).toBe("CONFLICT");
  });
});

describe("github webhook", () => {
  it("rejects an unsigned delivery", async () => {
    const response = await apiRequest("POST", "/webhooks/github", { body: {}, origin: null });
    expect(response.status).toBe(401);
  });

  it("rejects a forged signature", async () => {
    const response = await post("/webhooks/github", "{}", { "x-hub-signature-256": `sha256=${"b".repeat(64)}`, "x-github-delivery": randomUUID() });
    expect(response.status).toBe(401);
  });
});
