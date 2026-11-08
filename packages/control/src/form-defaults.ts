import type { FieldMap, SyntheticIdentity } from "@inlet/domain";

export const DEFAULT_SYNTHETIC_IDENTITY: SyntheticIdentity = {
  name: "Inlet Test Enquiry",
  email: "inlet-test@example.test",
  subject: "[Inlet test]",
  messagePrefix: "This is an automated test enquiry from Inlet. It is not from a customer and needs no reply.",
};

export const FIXTURE_FIELD_MAP: FieldMap = {
  name: "#name",
  email: "#email",
  subject: "#subject",
  message: "#message",
  submit: 'button[type="submit"]',
  successIndicator: "#form-success",
};
