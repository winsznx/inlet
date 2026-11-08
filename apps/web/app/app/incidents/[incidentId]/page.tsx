"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Checkbox, DefinitionRows, Dialog, Field, Notice, Panel, Skeleton, Status, Textarea, useToast } from "@inlet/ui";
import { buttonClass } from "@inlet/ui/classes";
import { NO_ROLE_REASON, PageHeader, QueryState, RunResultStatus, useCan } from "@/components/app/common";
import { api, errorMessage } from "@/lib/api";
import { formatClock, formatDateTime, INCIDENT_TONES, shortId } from "@/lib/format";
import type { IncidentDetail, InvestigationDetail, InvestigationEvent, InvestigationSummary } from "@/lib/types";

const ACTIVE_STATES = new Set(["investigating", "patch_proposed", "patch_testing", "rechecking"]);

function useInvestigationStream(id: string | undefined, active: boolean, onEnd: () => void) {
  const client = useQueryClient();
  useEffect(() => {
    if (!id || !active) return;
    const stream = new EventSource(`/api/v1/investigations/${id}/events`);
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as InvestigationEvent;
      client.setQueryData<InvestigationDetail>(["investigation", id], (current) => {
        if (!current || current.events.some((item) => item.sequence === event.sequence)) return current;
        return { ...current, events: [...current.events, event] };
      });
    };
    stream.addEventListener("end", () => { stream.close(); onEnd(); });
    return () => stream.close();
  }, [active, client, id, onEnd]);
}

function InvestigationPanel({ incident, investigation, active, refresh }: { incident: IncidentDetail; investigation: InvestigationSummary; active: boolean; refresh: () => void }) {
  const detail = useQuery({ queryKey: ["investigation", investigation.id], queryFn: () => api<InvestigationDetail>(`/investigations/${investigation.id}`), refetchInterval: active ? 3000 : false });
  useInvestigationStream(investigation.id, active, refresh);
  const harness = investigation.origin === "non_ai_harness";
  return (
    <div>
      {harness ? <div className="border-b border-line-subtle px-5 py-3"><Notice tone="warning" title="Non-AI test harness">This investigation used a deterministic harness on the controlled sample. No model was involved.</Notice></div> : null}
      {investigation.hypothesis && !harness ? (
        <div className="border-b border-line-subtle px-5 py-4">
          <p className="text-[13px] text-muted">Hypothesis</p>
          <p className="mt-1 text-[15px]">{investigation.hypothesis.hypothesis}</p>
          {investigation.hypothesis.suspectedFiles.length > 0 ? <p className="t-code mt-2 break-all text-muted">{investigation.hypothesis.suspectedFiles.join(", ")}</p> : null}
        </div>
      ) : null}
      <ol aria-label="Investigation activity" className="divide-y divide-line-subtle">
        {detail.data?.events.filter((event) => event.type !== "model.call").map((event) => (
          <li key={event.sequence} className={`grid gap-1 px-5 py-2.5 sm:grid-cols-[92px_minmax(0,1fr)] ${event.type === "tool.denied" || event.type === "patch.candidate_rejected" ? "bg-copper-tint" : ""}`}>
            <time dateTime={event.timestamp} className="t-code text-muted">{formatClock(event.timestamp).replace(" UTC", "")}</time>
            <span className="min-w-0 break-words text-sm">{event.summary}</span>
          </li>
        ))}
        {active ? <li className="px-5 py-3"><Skeleton className="h-4 w-56" /></li> : null}
      </ol>
      {detail.data && detail.data.modelCalls.length > 0 ? (
        <details className="border-t border-line-subtle px-5 py-3">
          <summary className="min-h-8 text-sm font-medium">Model requests ({detail.data.modelCalls.length}), {incident.investigations[0]?.modelId}</summary>
          <ul className="mt-2 grid gap-1">
            {detail.data.modelCalls.map((call) => <li key={call.id} className="t-code break-all text-muted">{call.responseId ?? call.requestId ?? call.errorCode} {call.durationMs} ms, {call.promptTokens}+{call.completionTokens} tokens{call.tools?.length ? `, ${call.tools.join(" ")}` : ""}</li>)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ActionDialogs({ incident, refresh }: { incident: IncidentDetail; refresh: () => void }) {
  const toast = useToast();
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");
  const close = useMutation({ mutationFn: () => api(`/incidents/${incident.id}/${incident.state === "closed" ? "reopen" : "close"}`, { body: { reason } }), onSuccess: () => { setClosing(false); setReason(""); refresh(); }, onError: (error) => toast(errorMessage(error), "danger") });
  const reopen = incident.state === "closed";
  return (
    <>
      <Button variant="secondary" onClick={() => setClosing(true)}>{reopen ? "Reopen incident" : "Close incident"}</Button>
      <Dialog open={closing} onOpenChange={setClosing} title={reopen ? "Reopen this incident" : "Close without repair"} description="Your reason is kept in the incident history." footer={<><Button variant="secondary" onClick={() => setClosing(false)}>Cancel</Button><Button loading={close.isPending} disabled={reason.trim().length < 3} onClick={() => close.mutate()}>{reopen ? "Reopen" : "Close incident"}</Button></>}>
        <Field label="Reason">{(control) => <Textarea {...control} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />}</Field>
      </Dialog>
    </>
  );
}

function MainAction({ incident, refresh }: { incident: IncidentDetail; refresh: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const canInvestigate = useCan("investigation:start");
  const canDecide = useCan("patch:decide");
  const canRun = useCan("run:start");
  const [confirmApply, setConfirmApply] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const start = useMutation({ mutationFn: (mode: "agent" | "non_ai_harness") => api(`/incidents/${incident.id}/investigations`, { body: { mode } }), onSuccess: refresh, onError: (error) => toast(errorMessage(error), "danger") });
  const confirmDeployed = useMutation({ mutationFn: () => api<{ runId: string }>(`/incidents/${incident.id}/deployment/confirm`, { body: {} }), onSuccess: ({ runId }) => router.push(`/app/runs/${runId}`), onError: (error) => toast(errorMessage(error), "danger") });
  const recheck = useMutation({ mutationFn: () => api<{ runId: string }>(`/incidents/${incident.id}/recheck`, { body: {} }), onSuccess: ({ runId }) => router.push(`/app/runs/${runId}`), onError: (error) => toast(errorMessage(error), "danger") });
  const apply = useMutation({ mutationFn: () => api(`/incidents/${incident.id}/fixture/apply`, { body: { confirm: true } }), onSuccess: () => { setConfirmApply(false); toast("Applying the approved change to the sample site. This takes about a minute."); refresh(); }, onError: (error) => toast(errorMessage(error), "danger") });
  const deployed = incident.deployments.length > 0;

  if (["open", "needs_configuration", "repair_unavailable", "investigation_failed", "patch_failed", "rejected", "still_failing"].includes(incident.state)) {
    const retry = incident.investigations.length > 0;
    const title = incident.state === "still_failing" ? "Investigate again" : retry ? "Retry investigation" : "Investigate code";
    return (
      <>
        {!incident.repositoryConnected ? (
          <Link href={`/app/sites/${incident.siteId}/configure`} className={buttonClass("primary")}>Connect repository</Link>
        ) : incident.inferenceConfigured ? (
          <Button loading={start.isPending} disabled={!canInvestigate} title={canInvestigate ? undefined : NO_ROLE_REASON} onClick={() => start.mutate("agent")}>{title}</Button>
        ) : (
          <Button disabled title="Set VULTR_INFERENCE_API_KEY on the server.">Connect inference to investigate code</Button>
        )}
        {incident.harnessAvailable && !incident.inferenceConfigured ? <Button variant="secondary" loading={start.isPending} disabled={!canInvestigate} onClick={() => start.mutate("non_ai_harness")}>Run non-AI test harness</Button> : null}
        {incident.state === "still_failing" && deployed ? <Button variant="secondary" loading={recheck.isPending} disabled={!canRun} onClick={() => recheck.mutate()}>Recheck after deployment</Button> : null}
      </>
    );
  }
  if (incident.state === "awaiting_approval" && incident.currentPatch) return <Link href={`/app/patches/${incident.currentPatch.id}`} className={buttonClass("primary")}>Review tested patch</Link>;
  if (incident.state === "awaiting_deployment") {
    return (
      <>
        {incident.fixtureRepairable && !deployed ? <Button disabled={!canDecide} title={canDecide ? undefined : NO_ROLE_REASON} onClick={() => setConfirmApply(true)}>Apply approved fixture change</Button> : null}
        {deployed ? <Button loading={recheck.isPending} disabled={!canRun} onClick={() => recheck.mutate()}>Recheck after deployment</Button> : !incident.fixtureRepairable ? <Button loading={confirmDeployed.isPending} disabled={!canRun} onClick={() => confirmDeployed.mutate()}>I&apos;ve deployed the change</Button> : null}
        <Dialog open={confirmApply} onOpenChange={setConfirmApply} title="Apply to the sample site" description="This changes only the controlled fault-injection site. It rebuilds and restarts that site with the approved patch." footer={<><Button variant="secondary" onClick={() => setConfirmApply(false)}>Cancel</Button><Button loading={apply.isPending} disabled={!understood} onClick={() => apply.mutate()}>Apply change</Button></>}>
          <Checkbox label="I understand this deploys the approved patch to the test site." checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
        </Dialog>
      </>
    );
  }
  return null;
}

function Body({ incident, refresh }: { incident: IncidentDetail; refresh: () => void }) {
  const active = ACTIVE_STATES.has(incident.state);
  const canManage = useCan("member:manage");
  const toast = useToast();
  const latest = incident.investigations[0];
  const checks = incident.currentPatch?.checks ?? [];
  const opened = incident.openedByRun;
  const publish = useMutation({ mutationFn: (published: boolean) => api(`/incidents/${incident.id}/publish-trace`, { body: { published } }), onSuccess: refresh, onError: (error) => toast(errorMessage(error), "danger") });
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader
        title="Form submitted. Enquiry not received."
        subtitle={`The browser confirmed submission, but the test message did not appear in ${incident.destinationName ?? "the destination"} during the observation window.`}
        actions={
          <>
            {incident.state !== "verified_recovered" ? <ActionDialogs incident={incident} refresh={refresh} /> : null}
            <MainAction incident={incident} refresh={refresh} />
          </>
        }
      />
      <dl className="flex flex-wrap gap-x-10 gap-y-2 border-b border-line-subtle pb-4 text-sm">
        <div className="flex items-center gap-2"><dt className="text-[13px] text-muted">Status</dt><dd><Status tone={INCIDENT_TONES[incident.state] ?? "neutral"}>{incident.stateLabel}</Status></dd></div>
        <div className="flex items-baseline gap-2"><dt className="text-[13px] text-muted">Website</dt><dd><Link href={`/app/sites/${incident.siteId}`} className="underline underline-offset-4">{incident.siteName}</Link></dd></div>
        <div className="flex items-baseline gap-2"><dt className="text-[13px] text-muted">Opened</dt><dd>{formatDateTime(incident.createdAt)}</dd></div>
        {incident.isControlledFixture ? <div><dt className="sr-only">Environment</dt><dd className="text-[13px] font-medium text-warning">Controlled fault-injection example</dd></div> : null}
      </dl>
      {incident.state === "verified_recovered" ? (
        <Notice tone="success" title="Verified recovered" action={incident.isControlledFixture ? <Button variant="secondary" disabled={!canManage} loading={publish.isPending} onClick={() => publish.mutate(!incident.publicTrace)}>{incident.publicTrace ? "Remove from public demo" : "Show on public demo"}</Button> : undefined}>
          A new test enquiry was found in the destination after deployment. The original failed check stays in this record.
        </Notice>
      ) : null}
      {incident.state === "patch_failed" ? <Notice tone="danger" title="We couldn't verify a code repair">No candidate passed every required check. Your website and repository were not changed.</Notice> : null}
      {incident.state === "investigation_failed" ? <Notice tone="warning" title="Investigation interrupted">The test environment couldn&apos;t start or stopped early. Your website and repository were not changed. Retry creates a fresh environment and keeps this evidence.</Notice> : null}
      {incident.state === "needs_configuration" ? <Notice tone="warning" title="Setup needed">{incident.inferenceConfigured ? "Connect the source repository to investigate this code." : "Connect inference to investigate code. Browser and inbox monitoring keep working."}</Notice> : null}
      {incident.humanDiagnosis ? (
        <Notice tone="warning" title="No code repair available">
          <p>{incident.humanDiagnosis.cause}</p>
          {incident.humanDiagnosis.whatToCheck.length > 0 ? <><p className="mt-2 font-medium">What to check next</p><ul className="ml-4 list-disc">{incident.humanDiagnosis.whatToCheck.map((item) => <li key={item}>{item}</li>)}</ul></> : null}
        </Notice>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-2">
        <Panel title="What happened">
          <DefinitionRows
            rows={[
              { term: "Original check", value: opened ? <Link className="t-code underline underline-offset-4" href={`/app/runs/${opened.id}`}>{shortId(opened.id)}</Link> : "Unknown" },
              { term: "Result", value: <RunResultStatus result={opened?.result} /> },
              { term: "Observed", value: opened?.summary ?? "Not recorded" },
              ...(incident.recoveryRun ? [{ term: "Recovery check", value: <Link className="t-code underline underline-offset-4" href={`/app/runs/${incident.recoveryRun.id}`}>{shortId(incident.recoveryRun.id)}</Link> }, { term: "Recovery result", value: <RunResultStatus result={incident.recoveryRun.result} /> }] : []),
            ]}
          />
        </Panel>
        <Panel title="Proposed change">
          {incident.currentPatch ? (
            <div>
              <DefinitionRows rows={[{ term: "Changed files", value: <span className="t-code break-all">{incident.currentPatch.changedFiles.join(", ")}</span> }, { term: "Status", value: incident.currentPatch.status }]} />
              <ul className="grid gap-1.5 border-t border-line-subtle px-5 py-3.5">
                {checks.filter((check) => check.variant === "patched").map((check) => <li key={check.id}><Status tone={check.pass ? "success" : "danger"}>{check.name}</Status></li>)}
              </ul>
              <div className="border-t border-line-subtle px-5 py-3"><Link href={`/app/patches/${incident.currentPatch.id}`} className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4">View full diff and checks</Link></div>
            </div>
          ) : <p className="p-5 text-sm text-muted">{active ? "A candidate will appear here once it passes the guard." : "No patch has been proposed."}</p>}
        </Panel>
      </div>
      <Panel title="Investigation">
        {latest ? <InvestigationPanel key={latest.id} incident={incident} investigation={latest} active={active} refresh={refresh} /> : <p className="p-5 text-sm text-muted">No investigation has run yet.</p>}
      </Panel>
    </div>
  );
}

export default function IncidentPage() {
  const { incidentId } = useParams<{ incidentId: string }>();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["incident", incidentId], queryFn: () => api<IncidentDetail>(`/incidents/${incidentId}`), refetchInterval: 3000 });
  const refresh = () => void client.invalidateQueries({ queryKey: ["incident", incidentId] });
  return <QueryState query={query}>{(incident) => <Body incident={incident} refresh={refresh} />}</QueryState>;
}
