"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { FormEvent } from "react";
import { Button, Checkbox, CopyButton, Field, Input, Notice, Select, Status, Textarea, useToast } from "@inlet/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { FieldMap, SiteDetail, SyntheticIdentity } from "@/lib/types";
import { NO_ROLE_REASON, useCan } from "./common";

function useRefreshSite(siteId: string): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ["site", siteId] });
}

function connectionTone(status: string): "success" | "warning" | "danger" {
  return status === "connected" ? "success" : status === "needs_setup" ? "warning" : "danger";
}

const STATUS_LABEL: Record<string, string> = { connected: "Connected", needs_setup: "Needs setup", expired: "Expired", error: "Error" };

export function ConnectionStatus({ status }: { status: string }) {
  return <Status tone={connectionTone(status)}>{STATUS_LABEL[status] ?? status}</Status>;
}

export function OwnershipStep({ site, onVerified }: { site: SiteDetail; onVerified: () => void }) {
  const refresh = useRefreshSite(site.id);
  const [method, setMethod] = useState<"dns_txt" | "html_meta">(site.verificationMethod === "html_meta" ? "html_meta" : "dns_txt");
  const [challenge, setChallenge] = useState<{ record: string; host: string; expiresAt: string; metaTag: string } | null>(null);
  const generate = useMutation({ mutationFn: () => api<{ record: string; host: string; expiresAt: string; metaTag: string }>(`/sites/${site.id}/ownership-challenge`, { body: { method } }), onSuccess: setChallenge });
  const verify = useMutation({
    mutationFn: () => api<{ verified: boolean; detail: string }>(`/sites/${site.id}/verify-ownership`, { body: {} }),
    onSuccess: async (result) => {
      await refresh();
      if (result.verified) onVerified();
    },
  });
  if (site.verificationStatus === "verified") return <Status tone="success">Ownership verified</Status>;
  return (
    <div className="grid gap-4">
      <Field label="Verification method">
        {(control) => (
          <Select {...control} value={method} onChange={(event) => { setMethod(event.target.value as typeof method); setChallenge(null); }}>
            <option value="dns_txt">DNS TXT record</option>
            <option value="html_meta">HTML meta tag</option>
          </Select>
        )}
      </Field>
      {challenge ? (
        <div className="rounded-panel border border-line p-4">
          <p className="text-sm">{method === "dns_txt" ? `Add this TXT record to ${challenge.host}:` : "Add this tag inside the <head> of your form page:"}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="t-code min-w-0 flex-1 break-all rounded-status bg-subtle p-2.5">{method === "dns_txt" ? challenge.record : challenge.metaTag}</code>
            <CopyButton value={method === "dns_txt" ? challenge.record : challenge.metaTag} />
          </div>
          <p className="mt-2 text-[13px] text-muted">This token expires {formatDateTime(challenge.expiresAt)}.</p>
        </div>
      ) : null}
      {verify.data && !verify.data.verified ? <Notice tone="warning" title="Not verified yet">{verify.data.detail}</Notice> : null}
      {verify.isError ? <Notice tone="danger">{errorMessage(verify.error)}</Notice> : null}
      {generate.isError ? <Notice tone="danger">{errorMessage(generate.error)}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant={challenge ? "secondary" : "primary"} loading={generate.isPending} onClick={() => generate.mutate()}>{challenge ? "Generate a new token" : "Generate token"}</Button>
        {challenge ? <Button loading={verify.isPending} onClick={() => verify.mutate()}>Verify ownership</Button> : null}
      </div>
    </div>
  );
}

export function DestinationEditor({ site, onConnected }: { site: SiteDetail; onConnected?: () => void }) {
  const refresh = useRefreshSite(site.id);
  const toast = useToast();
  const canEdit = useCan("site:edit");
  const [type, setType] = useState<"mailpit" | "imap" | "webhook">(site.isControlledFixture ? "mailpit" : "imap");
  const [error, setError] = useState<string | null>(null);
  const [signingSecret, setSigningSecret] = useState<string | null>(null);
  const destination = site.destination;
  const test = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; detail: string }>(`/destinations/${id}/test`, { body: {} }),
    onSuccess: async (result) => {
      await refresh();
      toast(result.detail, result.ok ? "success" : "danger");
      if (result.ok) onConnected?.();
    },
    onError: (caught) => toast(errorMessage(caught), "danger"),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ id: string; signingSecret?: string }>(`/sites/${site.id}/destinations`, { body }),
    onSuccess: async (result) => {
      setSigningSecret(result.signingSecret ?? null);
      await refresh();
      test.mutate(result.id);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/destinations/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (caught) => toast(errorMessage(caught), "danger"),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    save.mutate({ ...data, type, port: data.port ? Number(data.port) : undefined });
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted">We check the destination you control, not just the webpage.</p>
      {destination ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-line p-4">
          <div>
            <p className="text-[15px] font-medium">{destination.displayName}</p>
            <p className="text-[13px] text-muted">{destination.lastVerifiedAt ? `Last verified ${formatDateTime(destination.lastVerifiedAt)}` : "Not tested yet"}{destination.lastError ? `. Last error: ${destination.lastError}` : ""}</p>
            <div className="mt-1"><ConnectionStatus status={destination.status} /></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={test.isPending} disabled={!canEdit} title={canEdit ? undefined : NO_ROLE_REASON} onClick={() => test.mutate(destination.id)}>Test connection</Button>
            <Button variant="secondary" loading={disconnect.isPending} disabled={!canEdit} onClick={() => { if (window.confirm("Disconnect this destination? Checks will be unverified until a new one is connected.")) disconnect.mutate(destination.id); }}>Disconnect</Button>
          </div>
        </div>
      ) : null}
      {signingSecret ? (
        <Notice tone="warning" title="Save this signing secret. It won't be shown again.">
          <span className="mt-1 flex flex-wrap items-center gap-2"><code className="t-code break-all">{signingSecret}</code><CopyButton value={signingSecret} /></span>
          <span className="mt-1 block">POST to <code className="t-code">{destination?.inboundPath}</code> with headers x-inlet-timestamp and x-inlet-signature (HMAC-SHA256 of timestamp.body).</span>
        </Notice>
      ) : null}
      <form onSubmit={onSubmit} className="grid gap-4">
        <Field label="Destination type">
          {(control) => (
            <Select {...control} value={type} onChange={(event) => setType(event.target.value as typeof type)}>
              {site.isControlledFixture ? <option value="mailpit">Test inbox (local)</option> : null}
              <option value="imap">IMAP mailbox, read-only</option>
              <option value="webhook">Verified inbound test endpoint</option>
            </Select>
          )}
        </Field>
        <Field label="Display name">{(control) => <Input {...control} name="displayName" required defaultValue={type === "mailpit" ? "Test inbox" : ""} key={type} />}</Field>
        {type === "imap" ? (
          <>
            <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
              <Field label="IMAP host">{(control) => <Input {...control} name="host" required placeholder="imap.example.com" />}</Field>
              <Field label="Port">{(control) => <Input {...control} name="port" type="number" defaultValue={993} required />}</Field>
            </div>
            <Field label="Username">{(control) => <Input {...control} name="user" required autoComplete="off" />}</Field>
            <Field label="App password" help="Stored encrypted. It can't be read back, and it never enters a browser or repair environment.">{(control) => <Input {...control} name="password" type="password" required autoComplete="new-password" />}</Field>
            <Field label="Folder">{(control) => <Input {...control} name="folder" defaultValue="INBOX" required />}</Field>
          </>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div><Button type="submit" variant={destination ? "secondary" : "primary"} loading={save.isPending || test.isPending} disabled={!canEdit} title={canEdit ? undefined : NO_ROLE_REASON}>{destination ? "Replace destination" : "Connect and test"}</Button></div>
      </form>
    </div>
  );
}

type Discovery = { status: string; errorDetail: string | null; proposal: { mapping: Partial<FieldMap>; missing: string[]; captchaDetected: boolean; consentCandidates: { selector: string; label: string }[] } | null };

export function FormMappingEditor({ site, onSaved, saveLabel = "Save mapping" }: { site: SiteDetail; onSaved?: () => void; saveLabel?: string }) {
  const refresh = useRefreshSite(site.id);
  const toast = useToast();
  const canEdit = useCan("site:edit");
  const defaults = useQuery({ queryKey: ["form-config", site.id], queryFn: () => api<{ defaults: { syntheticIdentity: SyntheticIdentity; fieldMap: FieldMap | null } }>(`/sites/${site.id}/form-config`) });
  const [overrides, setOverrides] = useState<Partial<FieldMap>>({});
  const [identityOverrides, setIdentityOverrides] = useState<Partial<SyntheticIdentity>>({});
  const [consentOk, setConsentOk] = useState(site.formConfig?.consentMode === "controlled_test_account");
  const [frequency, setFrequency] = useState(site.formConfig?.maxSubmissionFrequencyMinutes ?? 15);
  const [discoveryId, setDiscoveryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = site.formConfig?.fieldMap ?? defaults.data?.defaults.fieldMap ?? null;
  const identityBase = site.formConfig?.syntheticIdentity ?? defaults.data?.defaults.syntheticIdentity;
  const map: Partial<FieldMap> = { ...base, ...overrides };
  const identity: Partial<SyntheticIdentity> = { ...identityBase, ...identityOverrides };

  const discovery = useQuery({
    queryKey: ["discovery", discoveryId],
    enabled: Boolean(discoveryId),
    queryFn: () => api<Discovery>(`/sites/${site.id}/discoveries/${discoveryId}`),
    refetchInterval: (state) => (state.state.data?.status === "pending" || !state.state.data ? 800 : false),
  });
  const discover = useMutation({
    mutationFn: () => api<{ discoveryId: string }>(`/sites/${site.id}/discover-fields`, { body: {} }),
    onSuccess: (result) => setDiscoveryId(result.discoveryId),
    onError: (caught) => toast(errorMessage(caught), "danger"),
  });
  const proposal = discovery.data?.status === "complete" ? discovery.data.proposal : null;

  const save = useMutation({
    mutationFn: () => api(`/sites/${site.id}/form-config`, { method: "PATCH", body: { fieldMap: { ...map, subject: map.subject || undefined, successIndicator: map.successIndicator || undefined, consent: map.consent || undefined }, syntheticIdentity: identity, consentMode: map.consent && consentOk ? "controlled_test_account" : "none", maxSubmissionFrequencyMinutes: frequency } }),
    onSuccess: async () => {
      await refresh();
      toast("Field mapping saved.");
      onSaved?.();
    },
    onError: (caught) => setError(caught instanceof ApiError && Object.keys(caught.fieldErrors()).length ? "Fill in every required selector." : errorMessage(caught)),
  });

  const FIELDS: { key: keyof FieldMap; label: string; required: boolean }[] = [
    { key: "name", label: "Name field", required: true },
    { key: "email", label: "Email field", required: true },
    { key: "subject", label: "Subject field (optional)", required: false },
    { key: "message", label: "Message field", required: true },
    { key: "submit", label: "Submit button", required: true },
    { key: "successIndicator", label: "Success message (optional)", required: false },
  ];
  const discovering = discover.isPending || discovery.data?.status === "pending" || (Boolean(discoveryId) && discovery.isPending);

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[56ch] text-sm text-muted">Inlet opens your page in an isolated browser and proposes a mapping. Confirm each selector before saving.</p>
        <Button variant="secondary" loading={discovering} disabled={!canEdit} onClick={() => { setDiscoveryId(null); discover.mutate(); }}>Detect fields</Button>
      </div>
      {discovery.data?.status === "failed" ? <Notice tone="danger" title="Detection failed">{discovery.data.errorDetail}</Notice> : null}
      {proposal?.captchaDetected ? <Notice tone="warning" title="Needs a different test route">A CAPTCHA protects this form. Inlet does not try to bypass it.</Notice> : null}
      {proposal ? (
        <Notice
          title={proposal.missing.length > 0 ? `Inlet needs your help with: ${proposal.missing.join(", ")}` : "A mapping is ready to review"}
          action={<Button variant="secondary" onClick={() => setOverrides((current) => ({ ...current, ...proposal.mapping }))}>Use proposed mapping</Button>}
        >
          <span className="t-code break-all">{Object.entries(proposal.mapping).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(", ")}</span>
        </Notice>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <Field key={field.key} label={field.label}>
            {(control) => <Input {...control} className="font-mono text-[13px]" value={map[field.key] ?? ""} onChange={(event) => setOverrides((current) => ({ ...current, [field.key]: event.target.value }))} placeholder="#selector" />}
          </Field>
        ))}
      </div>
      {proposal && proposal.consentCandidates.length > 0 ? <Notice tone="warning" title="This form has a checkbox">Inlet leaves consent boxes unticked unless you confirm below that this is your own controlled test account: {proposal.consentCandidates.map((item) => item.label || item.selector).join(", ")}.</Notice> : null}
      <Field label="Consent checkbox (optional)">{(control) => <Input {...control} className="font-mono text-[13px]" value={map.consent ?? ""} onChange={(event) => setOverrides((current) => ({ ...current, consent: event.target.value }))} />}</Field>
      {map.consent ? <Checkbox label="This is my own controlled test account, and ticking this box is safe." checked={consentOk} onChange={(event) => setConsentOk(event.target.checked)} /> : null}
      <fieldset className="grid gap-4 border-t border-line-subtle pt-4">
        <legend className="pr-3 text-sm font-semibold">Test enquiry details</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">{(control) => <Input {...control} value={identity.name ?? ""} onChange={(event) => setIdentityOverrides((current) => ({ ...current, name: event.target.value }))} />}</Field>
          <Field label="Email">{(control) => <Input {...control} type="email" value={identity.email ?? ""} onChange={(event) => setIdentityOverrides((current) => ({ ...current, email: event.target.value }))} />}</Field>
        </div>
        <Field label="Subject marker">{(control) => <Input {...control} value={identity.subject ?? ""} onChange={(event) => setIdentityOverrides((current) => ({ ...current, subject: event.target.value }))} />}</Field>
        <Field label="Message text" help="The unique test ID is added automatically. Keep the wording clearly marked as a test.">{(control) => <Textarea {...control} rows={3} value={identity.messagePrefix ?? ""} onChange={(event) => setIdentityOverrides((current) => ({ ...current, messagePrefix: event.target.value }))} />}</Field>
        <Field label="Minimum minutes between submissions">{(control) => <Input {...control} type="number" min={15} value={frequency} onChange={(event) => setFrequency(Number(event.target.value))} />}</Field>
      </fieldset>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div><Button loading={save.isPending} disabled={!canEdit || !map.name || !map.email || !map.message || !map.submit} title={canEdit ? undefined : NO_ROLE_REASON} onClick={() => { setError(null); save.mutate(); }}>{saveLabel}</Button></div>
    </div>
  );
}

export function RepositoryEditor({ site }: { site: SiteDetail }) {
  const refresh = useRefreshSite(site.id);
  const toast = useToast();
  const canManage = useCan("secret:manage");
  const fixtures = useQuery({ queryKey: ["fixtures"], queryFn: () => api<{ fixtures: { slot: string; repairable: boolean; url: string }[]; githubConfigured?: boolean }>("/setup/fixtures") });
  const repairableFixture = site.isControlledFixture && fixtures.data?.fixtures.some((item) => item.repairable && item.url === site.formUrl);
  const [mode, setMode] = useState<"upload" | "github">("upload");
  const [validation, setValidation] = useState<{ ok: boolean; checks: { name: string; pass: boolean; detail: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const repository = site.repository;

  const connectFixture = useMutation({ mutationFn: () => api(`/sites/${site.id}/repository/connect`, { body: { provider: "controlled_fixture" } }), onSuccess: refresh, onError: (caught) => setError(errorMessage(caught)) });
  const connectGithub = useMutation({ mutationFn: (body: Record<string, unknown>) => api(`/sites/${site.id}/repository/connect`, { body: { ...body, provider: "github" } }), onSuccess: refresh, onError: (caught) => setError(errorMessage(caught)) });
  const upload = useMutation({
    mutationFn: async ({ file, approvedPaths, buildProfile }: { file: File; approvedPaths: string; buildProfile: string }) => api(`/sites/${site.id}/repository/upload?${new URLSearchParams({ approvedPaths, buildProfile, repoName: file.name.replace(/\.tar\.gz$|\.tgz$/, "") })}`, { rawBody: file, contentType: "application/gzip" }),
    onSuccess: refresh,
    onError: (caught) => setError(errorMessage(caught)),
  });
  const validate = useMutation({ mutationFn: () => api<NonNullable<typeof validation>>(`/sites/${site.id}/repository/validate`, { body: {} }), onSuccess: async (result) => { setValidation(result); await refresh(); }, onError: (caught) => toast(errorMessage(caught), "danger") });
  const disconnect = useMutation({ mutationFn: () => api(`/sites/${site.id}/repository`, { method: "DELETE" }), onSuccess: () => { setValidation(null); return refresh(); }, onError: (caught) => toast(errorMessage(caught), "danger") });

  if (repository) {
    return (
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-line p-4">
          <div className="min-w-0">
            <p className="break-all text-[15px] font-medium">{repository.repoSlug}</p>
            <p className="text-[13px] text-muted">{repository.isControlledFixture ? "Controlled sample repository" : repository.provider === "github" ? `GitHub, ${repository.baseBranch}` : "Uploaded source"}. Approved paths: {repository.approvedPaths.join(", ")}</p>
            <div className="mt-1"><ConnectionStatus status={repository.status} /></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={validate.isPending} onClick={() => validate.mutate()}>Validate</Button>
            <Button variant="secondary" loading={disconnect.isPending} disabled={!canManage} title={canManage ? undefined : NO_ROLE_REASON} onClick={() => { if (window.confirm("Disconnect this repository? Monitoring continues, but code investigations stop.")) disconnect.mutate(); }}>Disconnect</Button>
          </div>
        </div>
        {validation ? (
          <ul className="grid gap-2">
            {validation.checks.map((check) => (
              <li key={check.name} className="flex flex-wrap items-baseline gap-x-3"><Status tone={check.pass ? "success" : "danger"}>{check.name}</Status><span className="text-[13px] text-muted">{check.detail}</span></li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  function onUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const data = new FormData(event.currentTarget);
    const file = data.get("archive");
    if (!(file instanceof File) || file.size === 0) { setError("Choose a .tar.gz archive."); return; }
    upload.mutate({ file, approvedPaths: String(data.get("approvedPaths")), buildProfile: String(data.get("buildProfile")) });
  }

  function onGithub(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    connectGithub.mutate({ repoSlug: data.repoSlug, baseBranch: data.baseBranch, installationId: data.installationId, approvedPaths: String(data.approvedPaths).split(",").map((item) => item.trim()), buildProfile: data.buildProfile });
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted">Optional for monitoring. Needed before Inlet can investigate the code.</p>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {repairableFixture ? <Notice title="Controlled sample repository" action={<Button loading={connectFixture.isPending} disabled={!canManage} onClick={() => connectFixture.mutate()}>Connect sample repository</Button>}>Use the version-controlled source of this fault-injection site.</Notice> : null}
      <Field label="Source">
        {(control) => (
          <Select {...control} value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
            <option value="upload">Upload a source archive</option>
            <option value="github" disabled={!fixtures.data?.githubConfigured}>GitHub{fixtures.data?.githubConfigured ? "" : " (not configured on this server)"}</option>
          </Select>
        )}
      </Field>
      {mode === "upload" ? (
        <form onSubmit={onUpload} className="grid gap-4">
          <Field label="Source archive (.tar.gz)" help="Environment files, keys and node_modules are removed before anything is read. Limit: 48 MB.">{(control) => <Input {...control} name="archive" type="file" accept=".gz,.tgz,application/gzip" className="py-2" required />}</Field>
          <RepoCommonFields />
          <div><Button type="submit" variant="secondary" loading={upload.isPending} disabled={!canManage} title={canManage ? undefined : NO_ROLE_REASON}>Upload source</Button></div>
        </form>
      ) : (
        <form onSubmit={onGithub} className="grid gap-4">
          <Field label="Repository (owner/name)">{(control) => <Input {...control} name="repoSlug" required />}</Field>
          <Field label="Base branch">{(control) => <Input {...control} name="baseBranch" defaultValue="main" required />}</Field>
          <Field label="GitHub App installation ID">{(control) => <Input {...control} name="installationId" required inputMode="numeric" />}</Field>
          <RepoCommonFields />
          <div><Button type="submit" variant="secondary" loading={connectGithub.isPending} disabled={!canManage}>Connect repository</Button></div>
        </form>
      )}
    </div>
  );
}

function RepoCommonFields() {
  return (
    <>
      <Field label="Allowed code directories" help="Comma separated. Inlet can only read and change files here.">{(control) => <Input {...control} name="approvedPaths" defaultValue="src" required />}</Field>
      <Field label="Build and test preset">{(control) => <Select {...control} name="buildProfile" defaultValue="next-pnpm"><option value="next-pnpm">Next.js with pnpm</option><option value="next-npm">Next.js with npm</option></Select>}</Field>
    </>
  );
}

export function ScheduleEditor({ site }: { site: SiteDetail }) {
  const refresh = useRefreshSite(site.id);
  const toast = useToast();
  const canEdit = useCan("site:edit");
  const schedule = site.schedule;
  const [mode, setMode] = useState(schedule?.mode ?? "off");
  const [minutes, setMinutes] = useState(schedule?.intervalMinutes ?? 60);
  const save = useMutation({
    mutationFn: () => api(`/sites/${site.id}/schedule`, { method: "PATCH", body: { mode, intervalMinutes: mode === "custom" ? minutes : undefined, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } }),
    onSuccess: async () => { await refresh(); toast("Schedule saved."); },
    onError: (caught) => toast(errorMessage(caught), "danger"),
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => api(`/sites/${site.id}/pause`, { body: { paused } }),
    onSuccess: refresh,
    onError: (caught) => toast(errorMessage(caught), "danger"),
  });
  const perDay = mode === "off" ? 0 : mode === "custom" ? Math.floor(1440 / Math.max(minutes, 15)) : { hourly: 24, six_hours: 4, daily: 1 }[mode];
  return (
    <div className="grid gap-4">
      <Field label="How often to check">
        {(control) => (
          <Select {...control} value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
            <option value="off">Off</option>
            <option value="hourly">Every hour</option>
            <option value="six_hours">Every 6 hours</option>
            <option value="daily">Daily</option>
            <option value="custom">Custom interval</option>
          </Select>
        )}
      </Field>
      {mode === "custom" ? <Field label="Minutes between checks" help="The minimum is 15 minutes.">{(control) => <Input {...control} type="number" min={15} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} />}</Field> : null}
      <p className="text-sm text-muted">{perDay ? `About ${perDay} test ${perDay === 1 ? "enquiry" : "enquiries"} a day.` : "No scheduled test enquiries."} {schedule?.nextRunAt ? `Next check ${formatDateTime(schedule.nextRunAt)} (${schedule.timezone}).` : ""}{schedule?.paused ? " Monitoring is paused." : ""}</p>
      <div className="flex flex-wrap gap-2">
        <Button loading={save.isPending} disabled={!canEdit} title={canEdit ? undefined : NO_ROLE_REASON} onClick={() => save.mutate()}>Save schedule</Button>
        {schedule?.enabled ? <Button variant="secondary" loading={pause.isPending} disabled={!canEdit} onClick={() => pause.mutate(!schedule.paused)}>{schedule.paused ? "Resume monitoring" : "Pause monitoring"}</Button> : null}
      </div>
    </div>
  );
}
