import type { destinations} from "@inlet/database";
import { and, db, desc, eq, gte, inboundReceipts, secrets } from "@inlet/database";
import { env } from "@inlet/config";
import { decryptSecret } from "@inlet/evidence";
import { ImapVerifier, InboundWebhookVerifier, MailpitVerifier } from "@inlet/integrations";
import type { DestinationVerifier } from "@inlet/integrations";

type Destination = typeof destinations.$inferSelect;

async function credential(destination: Destination): Promise<string> {
  if (!destination.encryptedCredentialId) throw new Error("Destination has no stored credential");
  const [row] = await db().select().from(secrets).where(eq(secrets.id, destination.encryptedCredentialId));
  if (!row) throw new Error("Destination credential is missing");
  return decryptSecret(row.ciphertext);
}

export async function verifierFor(destination: Destination): Promise<DestinationVerifier> {
  switch (destination.type) {
    case "mailpit":
      return new MailpitVerifier(env().MAILPIT_API_URL);
    case "imap":
      return new ImapVerifier({
        host: destination.host ?? "",
        port: destination.port ?? 993,
        secure: destination.settings.secure !== false,
        user: String(destination.settings.user ?? ""),
        password: await credential(destination),
        folder: String(destination.settings.folder ?? "INBOX"),
      });
    case "webhook":
      return new InboundWebhookVerifier(
        async (tokenHash, after) => {
          const [receipt] = await db()
            .select()
            .from(inboundReceipts)
            .where(
              and(
                eq(inboundReceipts.destinationId, destination.id),
                eq(inboundReceipts.tokenHash, tokenHash),
                gte(inboundReceipts.receivedAt, after),
              ),
            )
            .orderBy(desc(inboundReceipts.receivedAt))
            .limit(1);
          return receipt ? { receivedAt: receipt.receivedAt, remoteIdHash: receipt.remoteIdHash } : null;
        },
        async () => {
          const [any] = await db()
            .select({ id: inboundReceipts.id })
            .from(inboundReceipts)
            .where(eq(inboundReceipts.destinationId, destination.id))
            .limit(1);
          return Boolean(any);
        },
      );
  }
}
