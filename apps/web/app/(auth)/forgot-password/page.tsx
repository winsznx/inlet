"use client";

import Link from "next/link";
import { useState } from "react";
import { Field, Input, Notice } from "@inlet/ui";
import { AuthForm } from "@/components/auth-form";
import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  return (
    <>
      <h1 className="t-app-title">Reset your password</h1>
      <p className="mt-2 text-[15px] text-muted">We'll email a link that works for one hour.</p>
      <div className="mt-6 grid gap-4">
        {sent ? (
          <Notice tone="success">If that address has an account, a reset link is on its way.</Notice>
        ) : (
          <AuthForm submitLabel="Email reset link" onSubmit={async (data) => { await api("/auth/forgot-password", { body: { email: data.email } }); setSent(true); }}>
            {(errors) => <Field label="Email address" error={errors.email}>{(control) => <Input {...control} name="email" type="email" autoComplete="email" required />}</Field>}
          </AuthForm>
        )}
        <Link href="/login" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">Back to sign in</Link>
      </div>
    </>
  );
}
