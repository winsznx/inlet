import { describe, expect, it } from "vitest";
import { classifyRun, isCorrelationToken, maskToken, newCorrelationToken, TOKEN_PREFIX } from "@inlet/domain";
import type { ClassificationInput, DeliveryClassification } from "@inlet/domain";

describe("correlation tokens", () => {
  it("generates the documented format", () => {
    expect(newCorrelationToken()).toMatch(/^INLET-TEST-[0-9a-f]{32}$/);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 500 }, newCorrelationToken));
    expect(tokens.size).toBe(500);
  });

  it("recognises its own tokens", () => {
    expect(isCorrelationToken(newCorrelationToken())).toBe(true);
  });

  it.each([
    "",
    "INLET-TEST-",
    "INLET-TEST-abc",
    `INLET-TEST-${"g".repeat(32)}`,
    `INLET-TEST-${"A".repeat(32)}`,
    `inlet-test-${"a".repeat(32)}`,
    `INLET-TEST-${"a".repeat(33)}`,
    `x INLET-TEST-${"a".repeat(32)}`,
    `INLET-TEST-${"a".repeat(32)} x`,
    `INLET-TEST-${"a".repeat(32)}\n`,
  ])("rejects malformed token %j", (value) => {
    expect(isCorrelationToken(value)).toBe(false);
  });

  it("masks everything except the last four characters", () => {
    const token = `${TOKEN_PREFIX}${"a".repeat(28)}1234`;
    const masked = maskToken(token);
    expect(masked).toBe(`${TOKEN_PREFIX}••••1234`);
    expect(masked).not.toContain("a".repeat(5));
  });
});

const submitted: ClassificationInput = {
  navigated: true,
  submitClicked: true,
  submitObserved: true,
  captchaDetected: false,
  browserFailure: null,
  destination: "not_checked",
};

describe("classifyRun", () => {
  it.each([
    ["found", "received"],
    ["not_found", "not_received"],
    ["unavailable", "unverified"],
    ["not_checked", "unverified"],
  ] satisfies [ClassificationInput["destination"], DeliveryClassification][])("after an observed submit, destination %s is %s", (destination, expected) => {
    expect(classifyRun({ ...submitted, destination })).toBe(expected);
  });

  it("never reports not_received for an unavailable destination", () => {
    expect(classifyRun({ ...submitted, destination: "unavailable" })).not.toBe("not_received");
  });

  it("treats a run that never clicked submit as a browser failure, whatever the destination says", () => {
    for (const destination of ["found", "not_found", "unavailable", "not_checked"] as const) {
      expect(classifyRun({ ...submitted, submitClicked: false, submitObserved: false, browserFailure: "field_not_found", destination })).toBe("browser_failed");
    }
  });

  it("does not claim not_received when the submit could not be observed", () => {
    expect(classifyRun({ ...submitted, submitObserved: false, destination: "not_found" })).toBe("unverified");
  });

  it("still credits a real receipt when the submit could not be observed", () => {
    expect(classifyRun({ ...submitted, submitObserved: false, destination: "found" })).toBe("received");
  });
});
