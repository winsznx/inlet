import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DestinationError, hashRemoteId, InboundWebhookVerifier, MailpitVerifier } from "@inlet/integrations";

const TOKEN = `INLET-TEST-${"b".repeat(32)}`;
const RECIPIENT = "enquiries@acme-demo.test";

type Responder = (hit: number) => { status?: number; body: string };

let server: Server | undefined;

async function fakeMailpit(respond: Responder): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  server = createServer((_request, response) => {
    hits += 1;
    const reply = respond(hits);
    response.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    response.end(reply.body);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits: () => hits };
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
  });
  server = undefined;
});

const messages = (...items: { ID?: string; Created?: string; Subject?: string; To?: { Address: string }[] }[]) =>
  JSON.stringify({
    messages: items.map((item, index) => ({ ID: `id-${index}`, Created: new Date().toISOString(), Subject: `[Inlet test] ${TOKEN}`, To: [{ Address: RECIPIENT }], ...item })),
  });

const EMPTY = JSON.stringify({ messages: [] });

function search(durationMs = 700, after = new Date(Date.now() - 5_000)) {
  return { token: TOKEN, after, deadline: new Date(Date.now() + durationMs), expectedRecipient: RECIPIENT };
}

describe("MailpitVerifier.findReceipt", () => {
  it("finds a matching message and hashes its remote id", async () => {
    const fake = await fakeMailpit(() => ({ body: messages({ ID: "remote-1" }) }));

    const receipt = await new MailpitVerifier(fake.url).findReceipt(search());

    expect(receipt).toMatchObject({ status: "found", matchSource: "mailpit-search", recipient: RECIPIENT, polls: 1, remoteIdHash: hashRemoteId("remote-1") });
    expect(receipt.matchedAt).toBeInstanceOf(Date);
  });

  it("keeps polling until the message arrives", async () => {
    const fake = await fakeMailpit((hit) => ({ body: hit < 3 ? EMPTY : messages({}) }));

    const receipt = await new MailpitVerifier(fake.url).findReceipt(search(4_000));

    expect(receipt).toMatchObject({ status: "found", polls: 3 });
  });

  it("does not accept a message for the wrong recipient", async () => {
    const fake = await fakeMailpit(() => ({ body: messages({ To: [{ Address: "someone-else@acme-demo.test" }] }) }));

    expect(await new MailpitVerifier(fake.url).findReceipt(search())).toMatchObject({ status: "not_found" });
  });

  it("matches the recipient case-insensitively", async () => {
    const fake = await fakeMailpit(() => ({ body: messages({ To: [{ Address: RECIPIENT.toUpperCase() }] }) }));

    expect((await new MailpitVerifier(fake.url).findReceipt(search())).status).toBe("found");
  });

  it("finds a message among several recipients", async () => {
    const fake = await fakeMailpit(() => ({ body: messages({ To: [{ Address: "other@acme-demo.test" }, { Address: RECIPIENT }] }) }));

    expect((await new MailpitVerifier(fake.url).findReceipt(search())).status).toBe("found");
  });

  it("does not accept a message older than the submission", async () => {
    const after = new Date();
    const fake = await fakeMailpit(() => ({ body: messages({ Created: new Date(after.getTime() - 60_000).toISOString() }) }));

    expect(await new MailpitVerifier(fake.url).findReceipt(search(700, after))).toMatchObject({ status: "not_found" });
  });

  it("tolerates small clock drift but no more", async () => {
    const after = new Date();
    const within = await fakeMailpit(() => ({ body: messages({ Created: new Date(after.getTime() - 1_500).toISOString() }) }));
    expect((await new MailpitVerifier(within.url).findReceipt(search(700, after))).status).toBe("found");
    await new Promise<void>((resolve) => {
      server?.closeAllConnections();
      server?.close(() => resolve());
    });
    const beyond = await fakeMailpit(() => ({ body: messages({ Created: new Date(after.getTime() - 2_500).toISOString() }) }));
    expect((await new MailpitVerifier(beyond.url).findReceipt(search(700, after))).status).toBe("not_found");
  });

  it("picks one receipt when duplicates exist", async () => {
    const fake = await fakeMailpit(() => ({ body: messages({ ID: "first" }, { ID: "second" }, { ID: "third" }) }));

    const receipt = await new MailpitVerifier(fake.url).findReceipt(search());

    expect(receipt).toMatchObject({ status: "found", polls: 1, remoteIdHash: hashRemoteId("first") });
  });

  it("skips an older duplicate in favour of the fresh match", async () => {
    const after = new Date();
    const fake = await fakeMailpit(() => ({ body: messages({ ID: "stale", Created: new Date(after.getTime() - 60_000).toISOString() }, { ID: "fresh", Created: new Date(after.getTime() + 100).toISOString() }) }));

    expect(await new MailpitVerifier(fake.url).findReceipt(search(700, after))).toMatchObject({ status: "found", remoteIdHash: hashRemoteId("fresh") });
  });

  it("reports not_found only after the destination answered and the window ended", async () => {
    const fake = await fakeMailpit(() => ({ body: EMPTY }));

    const receipt = await new MailpitVerifier(fake.url).findReceipt(search());

    expect(receipt.status).toBe("not_found");
    expect(receipt.polls).toBeGreaterThanOrEqual(2);
  });

  it("calls onPoll for each attempt", async () => {
    const fake = await fakeMailpit(() => ({ body: EMPTY }));
    const seen: number[] = [];

    const receipt = await new MailpitVerifier(fake.url).findReceipt({ ...search(), onPoll: (count) => void seen.push(count) });

    expect(seen).toEqual(Array.from({ length: receipt.polls }, (_, index) => index + 1));
  });
});

describe("MailpitVerifier availability", () => {
  it("reports an unreachable destination as unavailable, never not_found", async () => {
    const receipt = await new MailpitVerifier("http://127.0.0.1:1").findReceipt(search());

    expect(receipt).toMatchObject({ status: "unavailable", errorCode: "destination_unreachable" });
    expect(receipt.status).not.toBe("not_found");
  });

  it("reports repeated server errors as unavailable", async () => {
    const fake = await fakeMailpit(() => ({ status: 500, body: "boom" }));

    expect(await new MailpitVerifier(fake.url).findReceipt(search())).toMatchObject({ status: "unavailable", errorCode: "destination_status_500" });
  });

  it("is unavailable, not not_found, when the destination fails on the last poll", async () => {
    const fake = await fakeMailpit((hit) => (hit === 1 ? { body: EMPTY } : { status: 503, body: "down" }));

    const receipt = await new MailpitVerifier(fake.url).findReceipt(search(1_500));

    expect(receipt).toMatchObject({ status: "unavailable", errorCode: "destination_status_503" });
  });

  it("recovers when the destination comes back within the window", async () => {
    const fake = await fakeMailpit((hit) => (hit === 1 ? { status: 503, body: "down" } : { body: messages({}) }));

    expect(await new MailpitVerifier(fake.url).findReceipt(search(4_000))).toMatchObject({ status: "found", polls: 2 });
  });

  it("reports not_found when the destination recovers but stays empty", async () => {
    const fake = await fakeMailpit((hit) => (hit === 1 ? { status: 503, body: "down" } : { body: EMPTY }));

    expect((await new MailpitVerifier(fake.url).findReceipt(search(1_500))).status).toBe("not_found");
  });

  it.each([
    ["non-JSON", "<html>proxy error</html>"],
    ["an object without messages", "{}"],
    ["messages of the wrong type", '{"messages":"nope"}'],
    ["JSON null", "null"],
  ])("reports %s as unavailable", async (_name, body) => {
    const fake = await fakeMailpit(() => ({ body }));

    expect(await new MailpitVerifier(fake.url).findReceipt(search())).toMatchObject({ status: "unavailable", errorCode: "destination_malformed_response" });
  });

  it("does not treat a message with an unparseable timestamp as a receipt", async () => {
    const fake = await fakeMailpit(() => ({ body: messages({ Created: "not-a-date" }) }));

    expect((await new MailpitVerifier(fake.url).findReceipt(search())).status).not.toBe("found");
  });

  it("does not treat a message with no recipient list as a receipt", async () => {
    const fake = await fakeMailpit(() => ({ body: JSON.stringify({ messages: [{ ID: "x", Created: new Date().toISOString(), Subject: "s" }] }) }));

    expect((await new MailpitVerifier(fake.url).findReceipt(search())).status).toBe("unavailable");
  });

  it("stops when aborted", async () => {
    const fake = await fakeMailpit(() => ({ body: EMPTY }));

    expect(await new MailpitVerifier(fake.url).findReceipt({ ...search(), signal: AbortSignal.abort() })).toMatchObject({ status: "unavailable", errorCode: "canceled", polls: 0 });
    expect(fake.hits()).toBe(0);
  });
});

describe("MailpitVerifier.validateConnection", () => {
  it("passes when the inbox answers", async () => {
    const fake = await fakeMailpit(() => ({ body: "{}" }));
    expect(await new MailpitVerifier(fake.url).validateConnection()).toMatchObject({ ok: true });
  });

  it("reports a bad status", async () => {
    const fake = await fakeMailpit(() => ({ status: 503, body: "" }));
    expect(await new MailpitVerifier(fake.url).validateConnection()).toMatchObject({ ok: false, errorCode: "bad_status" });
  });

  it("reports an unreachable inbox", async () => {
    expect(await new MailpitVerifier("http://127.0.0.1:1").validateConnection()).toMatchObject({ ok: false, errorCode: "unreachable" });
  });
});

describe("InboundWebhookVerifier", () => {
  const contact = () => Promise.resolve(true);

  it("finds a signed receipt by token hash", async () => {
    const receivedAt = new Date();
    let hashed = "";
    const verifier = new InboundWebhookVerifier((tokenHash) => {
      hashed = tokenHash;
      return Promise.resolve({ receivedAt, remoteIdHash: "remote" });
    }, contact);

    expect(await verifier.findReceipt(search())).toMatchObject({ status: "found", matchedAt: receivedAt, matchSource: "signed-inbound-webhook" });
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toContain(TOKEN);
  });

  it("is not_found when nothing arrives", async () => {
    expect((await new InboundWebhookVerifier(() => Promise.resolve(null), contact).findReceipt(search())).status).toBe("not_found");
  });

  it("is unavailable when the lookup keeps failing", async () => {
    expect((await new InboundWebhookVerifier(() => Promise.reject(new Error("db down")), contact).findReceipt(search())).status).toBe("unavailable");
  });

  it("stops immediately on a terminal destination error", async () => {
    const receipt = await new InboundWebhookVerifier(() => Promise.reject(new DestinationError("auth_rejected", true)), contact).findReceipt(search(5_000));

    expect(receipt).toMatchObject({ status: "unavailable", errorCode: "auth_rejected", polls: 1 });
  });

  it("validates only once a signed delivery has arrived", async () => {
    expect(await new InboundWebhookVerifier(() => Promise.resolve(null), contact).validateConnection()).toMatchObject({ ok: true });
    expect(await new InboundWebhookVerifier(() => Promise.resolve(null), () => Promise.resolve(false)).validateConnection()).toMatchObject({ ok: false, errorCode: "no_signed_delivery" });
  });
});
