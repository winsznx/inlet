import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { parseEnquiry } from "../../../lib/enquiry.ts";
import { smtpMailer } from "../../../lib/mailer.ts";
import { notifyTeam } from "../../../lib/notify.ts";
import { readNotificationSettings } from "../../../lib/settings.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const parsed = parseEnquiry(await request.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, field: parsed.field }, { status: 400 });
  }

  const traceId = randomUUID();
  const settings = readNotificationSettings();
  const outcome = await notifyTeam(parsed.enquiry, settings, smtpMailer(settings)).catch((error: unknown) => ({
    delivered: false as const,
    reason: error instanceof Error ? error.message : "send_failed",
  }));

  console.info(JSON.stringify({ event: "enquiry.processed", traceId, ...outcome }));

  if (!outcome.delivered) {
    return NextResponse.json({ ok: false, traceId }, { status: 502 });
  }
  return NextResponse.json({ ok: true, traceId });
}
