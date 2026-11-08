"use client";

import { Field, Input } from "@inlet/ui";
import { AuthForm } from "@/components/auth-form";
import { api } from "@/lib/api";

export default function WelcomePage() {
  return (
    <div className="mx-auto mt-10 max-w-[440px]">
      <h1 className="t-app-title">Start with a workspace</h1>
      <div className="mt-6">
        <AuthForm
          submitLabel="Create workspace"
          onSubmit={async (data) => {
            await api("/organizations", { body: { name: data.name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
            window.location.assign("/app/sites");
          }}
        >
          {(errors) => <Field label="Workspace name" error={errors.name} help="You can invite teammates later.">{(control) => <Input {...control} name="name" required autoFocus />}</Field>}
        </AuthForm>
      </div>
    </div>
  );
}
