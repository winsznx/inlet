"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Field, Input } from "@inlet/ui";
import { AuthForm, PasswordField } from "@/components/auth-form";
import { api } from "@/lib/api";

function RegisterForm() {
  const params = useSearchParams();
  const invite = params.get("invite") ?? undefined;
  return (
    <>
      <h1 className="t-app-title">Create your account</h1>
      <p className="mt-2 text-[15px] text-muted">{invite ? "You've been invited to a workspace. Create an account to join it." : "Check the forms your team maintains and see whether enquiries are arriving."}</p>
      <div className="mt-6 grid gap-4">
        <AuthForm
          submitLabel="Create account"
          onSubmit={async (data) => {
            await api("/auth/register", { body: { name: data.name, email: data.email, password: data.password, inviteToken: invite } });
            window.location.assign("/app");
          }}
        >
          {(errors) => (
            <>
              <Field label="Your name" error={errors.name}>{(control) => <Input {...control} name="name" autoComplete="name" required />}</Field>
              <Field label="Email address" error={errors.email}>{(control) => <Input {...control} name="email" type="email" autoComplete="email" defaultValue={params.get("email") ?? ""} required />}</Field>
              <PasswordField name="password" label="Password" autoComplete="new-password" error={errors.password} help="Use at least 10 characters." />
            </>
          )}
        </AuthForm>
        <p className="text-sm">
          Already have an account? <Link href="/login" className="underline underline-offset-4">Sign in</Link>
        </p>
      </div>
    </>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
