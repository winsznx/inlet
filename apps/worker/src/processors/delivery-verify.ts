import { and, checkRuns, db, deliveryObservations, destinations, eq } from "@inlet/database";
import { classifyRun, newId } from "@inlet/domain";
import type { BrowserOutcome } from "@inlet/domain";
import { appendRunEvent, enqueue, verifierFor } from "@inlet/control";
import { decryptSecret } from "@inlet/evidence";
import { VERIFIER_VERSION } from "@inlet/integrations";
import type { Receipt } from "@inlet/integrations";
import { finishRun } from "./site-check";

function timeOfDay(date: Date): string {
  return date.toISOString().slice(11, 19);
}

export async function processDeliveryVerify(runId: string): Promise<void> {
  const [run] = await db().select().from(checkRuns).where(eq(checkRuns.id, runId));
  if (!run || run.state !== "observing_destination" || !run.submittedAt) return;

  const [destination] = run.destinationId ? await db().select().from(destinations).where(eq(destinations.id, run.destinationId)) : [];
  const outcome = run.browserOutcome as BrowserOutcome | null;
  if (!destination) {
    await finishRun(runId, "unverified", "The connected destination was removed before it could be checked.");
    return;
  }

  const observationId = newId();
  const searchStartedAt = new Date();
  await db()
    .insert(deliveryObservations)
    .values({
      id: observationId,
      runId,
      destinationId: destination.id,
      searchStartedAt,
      verifierVersion: VERIFIER_VERSION,
    })
    .onConflictDoUpdate({ target: deliveryObservations.runId, set: { searchStartedAt } });

  await appendRunEvent(runId, {
    type: "destination.polling",
    stage: "observing_destination",
    summary: `Checking ${destination.displayName} for a matching message.`,
    payload: { windowSeconds: run.observationWindowSeconds },
  });

  const token = decryptSecret(run.testTokenEncrypted);
  const deadline = run.observationDeadlineAt ?? new Date(Date.now() + run.observationWindowSeconds * 1000);
  const expectedRecipient = typeof destination.settings.expectedRecipient === "string" ? destination.settings.expectedRecipient : undefined;

  let receipt: Receipt;
  try {
    const verifier = await verifierFor(destination);
    receipt = await verifier.findReceipt({
      token,
      after: run.submissionIntentAt ?? run.submittedAt,
      deadline,
      expectedRecipient,
      onPoll: async (count) => {
        await db().update(deliveryObservations).set({ pollCount: count }).where(eq(deliveryObservations.runId, runId));
      },
    });
  } catch {
    receipt = { status: "unavailable", errorCode: "verifier_error", polls: 0 };
  }

  await db()
    .update(deliveryObservations)
    .set({
      searchEndedAt: new Date(),
      status: receipt.status,
      pollCount: receipt.polls,
      matchFound: receipt.status === "found",
      matchSource: receipt.matchSource,
      remoteMessageIdHash: receipt.remoteIdHash,
      matchedAt: receipt.matchedAt,
      matchedRecipient: receipt.recipient,
      matchedSubject: receipt.subject?.replace(/INLET-TEST-[0-9a-f]{28}/g, "INLET-TEST-••••"),
      errorCode: receipt.errorCode,
    })
    .where(eq(deliveryObservations.runId, runId));

  const classification = classifyRun({
    navigated: outcome?.navigated ?? false,
    submitClicked: outcome?.submitClicked ?? false,
    submitObserved: outcome?.submitObserved ?? false,
    captchaDetected: outcome?.captchaDetected ?? false,
    browserFailure: outcome?.failure ?? null,
    destination: receipt.status,
  });

  if (receipt.status === "found" && receipt.matchedAt) {
    await appendRunEvent(runId, {
      type: "destination.matched",
      stage: "receipt_found",
      summary: `Matching message found at ${timeOfDay(receipt.matchedAt)} UTC.`,
      payload: { source: receipt.matchSource ?? "", polls: receipt.polls },
    });
  } else if (receipt.status === "not_found") {
    await appendRunEvent(runId, {
      type: "destination.timed_out",
      stage: "no_receipt",
      summary: "No matching message was found before the observation window ended.",
      payload: { windowSeconds: run.observationWindowSeconds, polls: receipt.polls },
    });
  } else {
    await appendRunEvent(runId, {
      type: "destination.unavailable",
      stage: "inconclusive",
      summary: `Inlet could not check ${destination.displayName}.`,
      payload: { errorCode: receipt.errorCode ?? "unavailable" },
    });
    await db()
      .update(destinations)
      .set({ status: "error", lastError: receipt.errorCode ?? "unavailable", updatedAt: new Date() })
      .where(and(eq(destinations.id, destination.id)));
    if (run.siteId) {
      await enqueue("notifications", destination.id, { kind: "connection_expired", siteId: run.siteId, organizationId: run.organizationId });
    }
  }

  const summaries = {
    received: `The test message arrived in ${destination.displayName}.`,
    not_received: `No matching message arrived in ${destination.displayName} during the ${run.observationWindowSeconds}-second observation window.`,
    unverified:
      receipt.status === "unavailable"
        ? `${destination.displayName} could not be checked, so delivery is unverified.`
        : "Inlet could not confirm that the form was submitted, so delivery is unverified.",
    browser_failed: "The browser could not submit the form.",
  } as const;

  await finishRun(runId, classification, summaries[classification]);
}
