import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";

export const VERIFIER_VERSION = "1.0.0";

export type ConnectionCheck = { ok: true; detail: string } | { ok: false; errorCode: string; detail: string };

export type ReceiptSearch = {
  token: string;
  after: Date;
  deadline: Date;
  expectedRecipient?: string;
  signal?: AbortSignal;
  onPoll?: (count: number) => void | Promise<void>;
};

export type Receipt = {
  status: "found" | "not_found" | "unavailable";
  matchedAt?: Date;
  remoteIdHash?: string;
  matchSource?: string;
  recipient?: string;
  subject?: string;
  errorCode?: string;
  polls: number;
};

export interface DestinationVerifier {
  validateConnection(): Promise<ConnectionCheck>;
  findReceipt(search: ReceiptSearch): Promise<Receipt>;
}

export function hashRemoteId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

const CLOCK_SKEW_MS = 2_000;
const MIN_POLL_MS = 500;
const MAX_POLL_MS = 4_000;

type PollResult = Omit<Receipt, "polls"> | null;

async function pollUntilDeadline(search: ReceiptSearch, attempt: () => Promise<PollResult>): Promise<Receipt> {
  let delay = MIN_POLL_MS;
  let polls = 0;
  let consecutiveFailures = 0;
  let lastError = "destination_unavailable";
  let everAnswered = false;

  for (;;) {
    if (search.signal?.aborted) return { status: "unavailable", errorCode: "canceled", polls };
    polls += 1;
    await search.onPoll?.(polls);
    try {
      const result = await attempt();
      everAnswered = true;
      consecutiveFailures = 0;
      if (result) return { ...result, polls };
    } catch (error) {
      consecutiveFailures += 1;
      lastError = error instanceof DestinationError ? error.code : "destination_unavailable";
      if (error instanceof DestinationError && error.terminal) {
        return { status: "unavailable", errorCode: error.code, polls };
      }
    }
    const remaining = search.deadline.getTime() - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
    delay = Math.min(delay * 1.6, MAX_POLL_MS);
  }

  if (!everAnswered || consecutiveFailures > 0) return { status: "unavailable", errorCode: lastError, polls };
  return { status: "not_found", polls };
}

export class DestinationError extends Error {
  constructor(
    readonly code: string,
    readonly terminal = false,
  ) {
    super(code);
  }
}

type MailpitSummary = {
  ID: string;
  Created: string;
  Subject: string;
  To: { Address: string }[];
};

type MailpitSearch = { messages: MailpitSummary[] };

export class MailpitVerifier implements DestinationVerifier {
  constructor(private readonly apiUrl: string) {}

  async validateConnection(): Promise<ConnectionCheck> {
    const response = await fetch(`${this.apiUrl}/api/v1/info`, { signal: AbortSignal.timeout(4_000) }).catch(() => null);
    if (!response) return { ok: false, errorCode: "unreachable", detail: "The test inbox did not respond." };
    if (!response.ok) return { ok: false, errorCode: "bad_status", detail: `The test inbox answered ${response.status}.` };
    return { ok: true, detail: "The test inbox answered." };
  }

  private async search(token: string, signal?: AbortSignal): Promise<MailpitSummary[]> {
    const url = `${this.apiUrl}/api/v1/search?query=${encodeURIComponent(`"${token}"`)}&limit=20`;
    const timeout = AbortSignal.timeout(4_000);
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }).catch(() => null);
    if (!response) throw new DestinationError("destination_unreachable");
    if (!response.ok) throw new DestinationError(`destination_status_${response.status}`);
    const body = (await response.json().catch(() => null)) as MailpitSearch | null;
    if (!body || !Array.isArray(body.messages)) throw new DestinationError("destination_malformed_response");
    return body.messages;
  }

  findReceipt(search: ReceiptSearch): Promise<Receipt> {
    const floor = search.after.getTime() - CLOCK_SKEW_MS;
    return pollUntilDeadline(search, async () => {
      const messages = await this.search(search.token, search.signal);
      const match = messages.find((message) => {
        const created = new Date(message.Created).getTime();
        if (!Number.isFinite(created) || created < floor) return false;
        if (!search.expectedRecipient) return true;
        return message.To.some((to) => to.Address.toLowerCase() === search.expectedRecipient?.toLowerCase());
      });
      if (!match) return null;
      return {
        status: "found",
        matchedAt: new Date(match.Created),
        remoteIdHash: hashRemoteId(match.ID),
        matchSource: "mailpit-search",
        recipient: match.To[0]?.Address,
        subject: match.Subject,
      };
    });
  }
}

export type ImapSettings = { host: string; port: number; secure: boolean; user: string; password: string; folder: string };

export class ImapVerifier implements DestinationVerifier {
  constructor(private readonly settings: ImapSettings) {}

  private client(): ImapFlow {
    const { host, port, secure, user, password } = this.settings;
    return new ImapFlow({ host, port, secure, auth: { user, pass: password }, logger: false, socketTimeout: 15_000 });
  }

  async validateConnection(): Promise<ConnectionCheck> {
    const client = this.client();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(this.settings.folder, { readOnly: true });
      lock.release();
      return { ok: true, detail: `Signed in and opened ${this.settings.folder} read-only.` };
    } catch (error) {
      const auth = (error as { authenticationFailed?: boolean }).authenticationFailed === true;
      return auth
        ? { ok: false, errorCode: "auth_rejected", detail: "The mail server rejected those credentials." }
        : { ok: false, errorCode: "unreachable", detail: "Could not open that mailbox." };
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  findReceipt(search: ReceiptSearch): Promise<Receipt> {
    const floor = search.after.getTime() - CLOCK_SKEW_MS;
    return pollUntilDeadline(search, async () => {
      const client = this.client();
      try {
        await client.connect();
      } catch (error) {
        const auth = (error as { authenticationFailed?: boolean }).authenticationFailed === true;
        throw new DestinationError(auth ? "auth_rejected" : "destination_unreachable", auth);
      }
      try {
        const lock = await client.getMailboxLock(this.settings.folder, { readOnly: true });
        try {
          const ids = await client.search({ body: search.token, since: new Date(floor) }, { uid: true });
          if (!ids || ids.length === 0) return null;
          for await (const message of client.fetch(ids, { uid: true, internalDate: true, envelope: true }, { uid: true })) {
            const received = message.internalDate ? new Date(message.internalDate) : null;
            if (!received || received.getTime() < floor) continue;
            return {
              status: "found",
              matchedAt: received,
              remoteIdHash: hashRemoteId(`${this.settings.folder}:${message.uid}:${message.envelope?.messageId ?? ""}`),
              matchSource: "imap-search",
              recipient: message.envelope?.to?.[0]?.address,
              subject: message.envelope?.subject,
            };
          }
          return null;
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => undefined);
      }
    });
  }
}

export type WebhookReceiptLookup = (tokenHash: string, after: Date) => Promise<{ receivedAt: Date; remoteIdHash: string } | null>;

export class InboundWebhookVerifier implements DestinationVerifier {
  constructor(
    private readonly lookup: WebhookReceiptLookup,
    private readonly hasRecentContact: () => Promise<boolean>,
  ) {}

  async validateConnection(): Promise<ConnectionCheck> {
    return (await this.hasRecentContact())
      ? { ok: true, detail: "A signed test delivery has reached this endpoint." }
      : { ok: false, errorCode: "no_signed_delivery", detail: "Send one signed test delivery to confirm the endpoint." };
  }

  findReceipt(search: ReceiptSearch): Promise<Receipt> {
    const floor = new Date(search.after.getTime() - CLOCK_SKEW_MS);
    const tokenHash = createHash("sha256").update(search.token).digest("hex");
    return pollUntilDeadline(search, async () => {
      const receipt = await this.lookup(tokenHash, floor);
      if (!receipt) return null;
      return {
        status: "found",
        matchedAt: receipt.receivedAt,
        remoteIdHash: receipt.remoteIdHash,
        matchSource: "signed-inbound-webhook",
      };
    });
  }
}
