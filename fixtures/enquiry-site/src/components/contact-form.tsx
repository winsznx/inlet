"use client";

import { type FormEvent, useState } from "react";

type Status = "idle" | "sending" | "sent" | "error";

export function ContactForm() {
  const [status, setStatus] = useState<Status>("idle");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");
    const body = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch("/api/enquiry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setStatus(response?.ok ? "sent" : "error");
  }

  if (status === "sent") {
    return (
      <p role="status" id="form-success" className="notice">
        Thanks. Your enquiry has been sent.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} aria-label="Contact Acme Demo">
      <label htmlFor="name">Your name</label>
      <input id="name" name="name" autoComplete="name" required />
      <label htmlFor="email">Email address</label>
      <input id="email" name="email" type="email" autoComplete="email" required />
      <label htmlFor="subject">Subject</label>
      <input id="subject" name="subject" />
      <label htmlFor="message">How can we help?</label>
      <textarea id="message" name="message" rows={5} required />
      {status === "error" ? (
        <p role="alert" className="notice error">
          We could not send your enquiry. Please try again.
        </p>
      ) : null}
      <button type="submit" disabled={status === "sending"}>
        {status === "sending" ? "Sending" : "Send enquiry"}
      </button>
    </form>
  );
}
