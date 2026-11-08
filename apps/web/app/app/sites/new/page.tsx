"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Button, Checkbox, cx, Field, Input, Notice, Panel, Select } from "@inlet/ui";
import { PageHeader, QueryState } from "@/components/app/common";
import { DestinationEditor, FormMappingEditor, OwnershipStep, RepositoryEditor } from "@/components/app/site-editors";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { SiteDetail } from "@/lib/types";

const STEPS = ["Website", "Verify ownership", "Delivery destination", "Form and code"];

function StepBar({ current }: { current: number }) {
  return (
    <ol className="flex gap-1 md:block" aria-label="Setup steps">
      {STEPS.map((step, index) => (
        <li key={step} className="flex flex-1 md:pb-5" aria-current={index + 1 === current ? "step" : undefined}>
          <span className={cx("hidden h-6 w-6 shrink-0 items-center justify-center rounded-[3px] text-[12px] font-semibold md:flex", index + 1 < current ? "bg-ink text-white" : index + 1 === current ? "bg-copper text-white" : "border border-line-control text-muted")}>{index + 1}</span>
          <span className={cx("w-full border-t-2 pt-1.5 text-[12px] md:ml-3 md:w-auto md:border-t-0 md:pt-0 md:text-sm", index + 1 <= current ? "border-ink font-medium" : "border-line text-muted")}>{step}</span>
        </li>
      ))}
    </ol>
  );
}

function WebsiteStep({ onCreated }: { onCreated: (id: string, fixture: boolean) => void }) {
  const fixtures = useQuery({ queryKey: ["fixtures"], queryFn: () => api<{ fixtures: { slot: string; name: string; url: string; label: string }[] }>("/setup/fixtures") });
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ id: string; controlledFixture: boolean }>("/sites", { body }),
    onSuccess: (result) => onCreated(result.id, result.controlledFixture),
    onError: (error) => {
      const fields = error instanceof ApiError ? error.fieldErrors() : {};
      setErrors(fields);
      setFormError(Object.keys(fields).length ? null : errorMessage(error));
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});
    setFormError(null);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    create.mutate({ name, formUrl: url, formPurpose: data.formPurpose, authorized: authorized || undefined });
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      {fixtures.data && fixtures.data.fixtures.length > 0 ? (
        <div className="rounded-panel border border-line p-4">
          <p className="text-sm font-medium">Controlled sample sites</p>
          <p className="text-[13px] text-muted">Available in local development. These are owned test sites, not customer websites.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {fixtures.data.fixtures.map((fixture) => (
              <Button key={fixture.slot} variant="secondary" onClick={() => { setName(fixture.name); setUrl(fixture.url); setAuthorized(true); }}>{fixture.name}</Button>
            ))}
          </div>
        </div>
      ) : null}
      <Field label="Website name" error={errors.name} help="2 to 80 characters.">{(control) => <Input {...control} value={name} onChange={(event) => setName(event.target.value)} required />}</Field>
      <Field label="Form page URL" error={errors.formUrl} help="The exact page with the form. It must use https.">{(control) => <Input {...control} value={url} onChange={(event) => setUrl(event.target.value)} required placeholder="https://www.example.com/contact" inputMode="url" />}</Field>
      <Field label="What is this form for?">{(control) => <Select {...control} name="formPurpose" defaultValue="contact"><option value="contact">Contact</option><option value="quote">Quote</option><option value="booking">Booking</option><option value="custom">Something else</option></Select>}</Field>
      <Checkbox label="I control this website and authorize Inlet to submit clearly marked test enquiries to it." checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} />
      {errors.authorized ? <p className="text-[13px] text-danger">{errors.authorized}</p> : null}
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <div><Button type="submit" loading={create.isPending} disabled={!authorized}>Continue</Button></div>
    </form>
  );
}

function Wizard() {
  const router = useRouter();
  const params = useSearchParams();
  const client = useQueryClient();
  const siteId = params.get("site");
  const site = useQuery({ queryKey: ["site", siteId], enabled: Boolean(siteId), queryFn: () => api<SiteDetail>(`/sites/${siteId}`) });
  const [override, setOverride] = useState<number | null>(null);
  const idempotency = useRef(crypto.randomUUID());
  const [runError, setRunError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: async () => {
      await api(`/sites/${siteId}`, { method: "PATCH", body: { setupStep: 4, setupComplete: true } });
      return api<{ runId: string }>(`/sites/${siteId}/runs`, { body: { trigger: "first_check", reason: "first-check" }, idempotencyKey: idempotency.current });
    },
    onSuccess: ({ runId }) => router.push(`/app/runs/${runId}`),
    onError: (error) => setRunError(errorMessage(error)),
  });

  const step = !siteId ? 1 : (override ?? site.data?.setupStep ?? 2);
  const go = (next: number) => {
    setOverride(next);
    if (siteId) void api(`/sites/${siteId}`, { method: "PATCH", body: { setupStep: next } }).then(() => client.invalidateQueries({ queryKey: ["site", siteId] }));
  };
  const canContinue = (detail: SiteDetail) => (step === 2 ? detail.verificationStatus === "verified" : step === 3 ? Boolean(detail.destination) : true);

  return (
    <div className="grid gap-8">
      <PageHeader title="Add a website" subtitle="Choose the form to test. Inlet will only submit enquiries to websites you've confirmed you control." />
      <div className="grid gap-8 md:grid-cols-[220px_minmax(0,1fr)]">
        <StepBar current={step} />
        <div className="grid max-w-[720px] gap-5">
          {!siteId ? (
            <Panel title="Website"><div className="p-5"><WebsiteStep onCreated={(id, fixture) => { setOverride(fixture ? 3 : 2); router.replace(`/app/sites/new?site=${id}`); }} /></div></Panel>
          ) : (
            <QueryState query={site}>
              {(detail) => (
                <>
                  <Panel title={STEPS[step - 1]}>
                    <div className="p-5">
                      {step === 2 ? <OwnershipStep site={detail} onVerified={() => go(3)} /> : null}
                      {step === 3 ? <DestinationEditor site={detail} /> : null}
                      {step === 4 ? (
                        <div className="grid gap-8">
                          <FormMappingEditor key={detail.formConfig?.version ?? 0} site={detail} />
                          <div className="border-t border-line-subtle pt-6"><h3 className="t-section mb-3">Source code</h3><RepositoryEditor site={detail} /></div>
                        </div>
                      ) : null}
                    </div>
                  </Panel>
                  {runError ? <Notice tone="danger">{runError}</Notice> : null}
                  <div className="flex flex-wrap justify-between gap-3">
                    <Button variant="secondary" disabled={step <= 2 && detail.isControlledFixture ? true : step <= 2} onClick={() => go(step - 1)}>Back</Button>
                    {step < 4 ? <Button disabled={!canContinue(detail)} title={canContinue(detail) ? undefined : "Finish this step first."} onClick={() => go(step + 1)}>Continue</Button> : <Button loading={start.isPending} disabled={!detail.formConfig || !detail.destination} title={detail.formConfig ? undefined : "Save the field mapping first."} onClick={() => start.mutate()}>Save website and run check</Button>}
                  </div>
                </>
              )}
            </QueryState>
          )}
        </div>
      </div>
    </div>
  );
}

export default function NewSitePage() {
  return <Suspense><Wizard /></Suspense>;
}
