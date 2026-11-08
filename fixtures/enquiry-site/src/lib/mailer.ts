import nodemailer from "nodemailer";
import type { NotificationSettings } from "./settings.ts";

export type OutboundMail = {
  to: string;
  from: string;
  subject: string;
  text: string;
  replyTo: string;
};

export type Mailer = (mail: OutboundMail) => Promise<void>;

export function smtpMailer(settings: NotificationSettings): Mailer {
  const transport = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: false,
    connectionTimeout: 5_000,
  });
  return async (mail) => {
    await transport.sendMail(mail);
  };
}
