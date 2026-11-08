export type Enquiry = {
  name: string;
  email: string;
  subject: string;
  message: string;
};

export type ParsedEnquiry = { ok: true; enquiry: Enquiry } | { ok: false; field: keyof Enquiry };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseEnquiry(input: unknown): ParsedEnquiry {
  const source = (input ?? {}) as Record<string, unknown>;
  const read = (key: string) => (typeof source[key] === "string" ? source[key].trim() : "");
  const enquiry: Enquiry = {
    name: read("name"),
    email: read("email"),
    subject: read("subject"),
    message: read("message"),
  };
  if (!enquiry.name) return { ok: false, field: "name" };
  if (!EMAIL.test(enquiry.email)) return { ok: false, field: "email" };
  if (!enquiry.message) return { ok: false, field: "message" };
  return { ok: true, enquiry };
}
