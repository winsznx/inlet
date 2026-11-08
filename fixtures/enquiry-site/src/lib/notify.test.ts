import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutboundMail } from "./mailer.ts";
import { notifyTeam } from "./notify.ts";
import { readNotificationSettings } from "./settings.ts";

const enquiry = {
  name: "Test Visitor",
  email: "visitor@example.test",
  subject: "Quote",
  message: "Hello there",
};

test("the deployed recipient setting reaches the notification", async () => {
  const sent: OutboundMail[] = [];
  const settings = readNotificationSettings({
    ENQUIRY_NOTIFY_ADDRESS: "enquiries@acme-demo.test",
  });
  const outcome = await notifyTeam(enquiry, settings, async (mail) => {
    sent.push(mail);
  });
  assert.deepEqual(outcome, { delivered: true });
  assert.equal(sent[0]?.to, "enquiries@acme-demo.test");
  assert.match(sent[0]?.text ?? "", /Hello there/);
});

test("a missing recipient reports that nothing was delivered", async () => {
  const settings = readNotificationSettings({});
  const outcome = await notifyTeam(enquiry, settings, async () => {
    throw new Error("must not send");
  });
  assert.equal(outcome.delivered, false);
});
