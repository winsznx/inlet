import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImapVerifier } from "@inlet/integrations";

const CONTAINER = `inlet-test-imap-${randomUUID().slice(0, 8)}`;
const IMAP_PORT = 13143;
const SMTP_PORT = 13025;
const USER = "enquiries@imap.inlet.test";
const PASSWORD = "imap-test-password";

function verifier(password = PASSWORD): ImapVerifier {
  return new ImapVerifier({ host: "127.0.0.1", port: IMAP_PORT, secure: false, user: USER, password, folder: "INBOX" });
}

async function sendMail(token: string): Promise<void> {
  const transport = nodemailer.createTransport({ host: "127.0.0.1", port: SMTP_PORT, secure: false });
  await transport.sendMail({ from: "site@imap.inlet.test", to: USER, subject: "New enquiry", text: `Reference: ${token}` });
}

beforeAll(async () => {
  execFileSync("docker", ["run", "--detach", "--rm", "--name", CONTAINER, "--publish", `127.0.0.1:${IMAP_PORT}:3143`, "--publish", `127.0.0.1:${SMTP_PORT}:3025`, "--env", `GREENMAIL_OPTS=-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=enquiries:${PASSWORD}@imap.inlet.test -Dgreenmail.users.login=email`, "greenmail/standalone:2.1.3"]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await verifier().validateConnection()).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The IMAP test server did not start");
}, 60_000);

afterAll(() => {
  execFileSync("docker", ["rm", "--force", CONTAINER], { stdio: "ignore" });
});

describe("ImapVerifier against a real IMAP server", () => {
  it("opens the mailbox with valid credentials", async () => {
    // #when
    const check = await verifier().validateConnection();
    // #then
    expect(check.ok).toBe(true);
  });

  it("reports rejected credentials as an authentication problem", async () => {
    // #when
    const check = await verifier("wrong-password").validateConnection();
    // #then
    expect(check).toMatchObject({ ok: false, errorCode: "auth_rejected" });
  });

  it("finds the message that carries the token", async () => {
    // #given
    const token = `INLET-TEST-${randomUUID().replaceAll("-", "")}`;
    const after = new Date();
    await sendMail(token);
    // #when
    const receipt = await verifier().findReceipt({ token, after, deadline: new Date(Date.now() + 15_000) });
    // #then
    expect(receipt.status).toBe("found");
    expect(receipt.remoteIdHash).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it("ends as not_found when no message matches", async () => {
    // #given
    const token = `INLET-TEST-${randomUUID().replaceAll("-", "")}`;
    // #when
    const receipt = await verifier().findReceipt({ token, after: new Date(), deadline: new Date(Date.now() + 3_000) });
    // #then
    expect(receipt.status).toBe("not_found");
  }, 20_000);

  it("reports rejected credentials as unavailable, never as not received", async () => {
    // #given
    const token = `INLET-TEST-${randomUUID().replaceAll("-", "")}`;
    // #when
    const receipt = await verifier("wrong-password").findReceipt({ token, after: new Date(), deadline: new Date(Date.now() + 3_000) });
    // #then
    expect(receipt).toMatchObject({ status: "unavailable", errorCode: "auth_rejected" });
  }, 20_000);
});
