"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Notice } from "@inlet/ui";
import { AuthForm, PasswordField } from "@/components/auth-form";
import { api } from "@/lib/api";

function ResetForm() {
  const token = useSearchParams().get("token");
  if (!token) return <Notice tone="danger">This link is incomplete. Request a new one from the sign-in page.</Notice>;
  return (
    <AuthForm submitLabel="Change password" onSubmit={async (data) => { await api("/auth/reset-password", { body: { token, password: data.password } }); window.location.assign("/login?reset=1"); }}>
      {(errors) => <PasswordField name="password" label="New password" autoComplete="new-password" error={errors.password} help="Use at least 10 characters." />}
    </AuthForm>
  );
}

export default function ResetPasswordPage() {
  return (
    <>
      <h1 className="t-app-title">Choose a new password</h1>
      <div className="mt-6">
        <Suspense>
          <ResetForm />
        </Suspense>
      </div>
    </>
  );
}
