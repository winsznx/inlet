import type { Enquiry } from "./enquiry.ts";
import type { Mailer } from "./mailer.ts";
import type { NotificationSettings } from "./settings.ts";

export type NotifyOutcome = { delivered: true } | { delivered: false; reason: string };

export async function notifyTeam(
  enquiry: Enquiry,
  settings: NotificationSettings,
  send: Mailer,
): Promise<NotifyOutcome> {
  if (!settings.recipient) {
    return { delivered: false, reason: "recipient_not_configured" };
  }
  await send({
    to: settings.recipient,
    from: settings.sender,
    replyTo: enquiry.email,
    subject: `New enquiry: ${enquiry.subject || enquiry.name}`,
    text: [`From: ${enquiry.name} <${enquiry.email}>`, "", enquiry.message].join("\n"),
  });
  return { delivered: true };
}
