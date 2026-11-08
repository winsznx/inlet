"use client";

import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Button, Notice } from "@inlet/ui";
import { ApiError, errorMessage } from "@/lib/api";

export function AuthForm({ submitLabel, onSubmit, children }: { submitLabel: string; onSubmit: (data: Record<string, string>) => Promise<void>; children: (errors: Record<string, string>) => ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await onSubmit(Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>);
    } catch (caught) {
      const mapped = caught instanceof ApiError ? caught.fieldErrors() : {};
      setFields(mapped);
      if (Object.keys(mapped).length === 0) setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void handle(event)} className="grid gap-4" noValidate>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {children(fields)}
      <Button type="submit" loading={busy} className="w-full">
        {submitLabel}
      </Button>
    </form>
  );
}

export function PasswordField({ name, label, autoComplete, error, help }: { name: string; label: string; autoComplete: string; error?: string; help?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="grid gap-1.5">
      <label htmlFor={name} className="text-sm font-medium">{label}</label>
      <div className="relative">
        <input id={name} name={name} type={visible ? "text" : "password"} autoComplete={autoComplete} required aria-invalid={error ? true : undefined} aria-describedby={error ? `${name}-error` : undefined} className="min-h-11 w-full rounded-input border border-line-control px-3 pr-16 text-[15px] aria-invalid:border-danger" />
        <button type="button" onClick={() => setVisible((value) => !value)} aria-pressed={visible} className="absolute right-1 top-0 min-h-11 px-2 text-[13px] font-medium text-ink-2">
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {error ? <p id={`${name}-error`} className="text-[13px] text-danger">{error}</p> : null}
      {help ? <p className="text-[13px] text-muted">{help}</p> : null}
    </div>
  );
}
