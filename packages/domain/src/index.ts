import { randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";

export * from "./states";
export * from "./events";
export * from "./errors";
export * from "./protocol";

export const newId = (): string => uuidv7();

export const TOKEN_PREFIX = "INLET-TEST-";
const TOKEN_PATTERN = /INLET-TEST-[0-9a-f]{32}/;

export function newCorrelationToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(16).toString("hex")}`;
}

export function isCorrelationToken(value: string): boolean {
  return new RegExp(`^${TOKEN_PATTERN.source}$`).test(value);
}

export function maskToken(token: string): string {
  return `${TOKEN_PREFIX}••••${token.slice(-4)}`;
}

export type DeliveryClassification = "received" | "not_received" | "unverified" | "browser_failed";

export type ClassificationInput = {
  navigated: boolean;
  submitClicked: boolean;
  submitObserved: boolean;
  captchaDetected: boolean;
  browserFailure: string | null;
  destination: "found" | "not_found" | "unavailable" | "not_checked";
};

export function classifyRun(input: ClassificationInput): DeliveryClassification {
  if (!input.submitClicked) return "browser_failed";
  if (!input.submitObserved) {
    return input.destination === "found" ? "received" : "unverified";
  }
  switch (input.destination) {
    case "found":
      return "received";
    case "not_found":
      return "not_received";
    default:
      return "unverified";
  }
}
