export type NotificationSettings = {
  recipient: string | undefined;
  sender: string;
  smtpHost: string;
  smtpPort: number;
};

export function readNotificationSettings(env: Record<string, string | undefined> = process.env): NotificationSettings {
  return {
    recipient: env.ENQUIRY_NOTIFY_ADDRESS,
    sender: env.NOTIFY_FROM ?? "website@acme-demo.test",
    smtpHost: env.SMTP_HOST ?? "localhost",
    smtpPort: Number(env.SMTP_PORT ?? 1025),
  };
}
