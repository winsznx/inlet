import nodemailer from "nodemailer";
import { env } from "@inlet/config";

export type ProductEmail = { to: string; subject: string; text: string };

export async function sendProductEmail(mail: ProductEmail): Promise<void> {
  const config = env();
  const transport = nodemailer.createTransport({
    host: config.NOTIFY_SMTP_HOST,
    port: config.NOTIFY_SMTP_PORT,
    secure: config.NOTIFY_SMTP_PORT === 465,
    connectionTimeout: 8_000,
    auth: config.NOTIFY_SMTP_USER ? { user: config.NOTIFY_SMTP_USER, pass: config.NOTIFY_SMTP_PASSWORD ?? "" } : undefined,
  });
  await transport.sendMail({ from: config.NOTIFY_FROM, ...mail });
}
