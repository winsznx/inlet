"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Field, Input, Notice } from "@inlet/ui";
import { AuthForm, PasswordField } from "@/components/auth-form";
import { api } from "@/lib/api";

function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next");
  const isLocal = process.env.NODE_ENV !== "production";
  return (
    <>
      <h1 className="t-app-title">Sign in to Inlet</h1>
      <p className="mt-2 text-[15px] text-muted">Manage the websites and enquiry checks your team is responsible for.</p>
      <div className="mt-6 grid gap-4">
        {params.get("expired") ? <Notice tone="warning">Your session ended. Sign in to continue.</Notice> : null}
        {params.get("reset") ? <Notice tone="success">Your password was changed. Sign in with the new one.</Notice> : null}
        <AuthForm
          submitLabel="Sign in"
          onSubmit={async (data) => {
            await api("/auth/login", { body: { email: data.email, password: data.password } });
            window.location.assign(next?.startsWith("/app") ? next : "/app");
          }}
        >
          {(errors) => (
            <>
              <Field label="Email address" error={errors.email}>{(control) => <Input {...control} name="email" type="email" autoComplete="email" required />}</Field>
              <PasswordField name="password" label="Password" autoComplete="current-password" error={errors.password} />
            </>
          )}
        </AuthForm>
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          <Link href="/forgot-password" className="inline-flex min-h-11 items-center underline underline-offset-4">Forgot password</Link>
          <Link href="/register" className="inline-flex min-h-11 items-center underline underline-offset-4">Create an account</Link>
        </div>
        {isLocal ? <p className="t-code text-muted">Local only: dev@inlet.test / inlet-local-dev</p> : null}
      </div>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
