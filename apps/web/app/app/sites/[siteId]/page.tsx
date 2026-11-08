"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRef } from "react";
import { Button, DefinitionRows, EmptyState, Panel, Status, Tabs, useToast } from "@inlet/ui";
import { buttonClass } from "@inlet/ui/classes";
import { NO_ROLE_REASON, PageHeader, QueryState, RunResultStatus, Table, TD, TH, useCan } from "@/components/app/common";
import { ConnectionStatus } from "@/components/app/site-editors";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, formatDuration, INCIDENT_TONES, shortId } from "@/lib/format";
import { INCIDENT_STATE_LABELS } from "@inlet/domain/states";
import type { IncidentState } from "@inlet/domain/states";
import type { SiteDetail } from "@/lib/types";

const SCHEDULE_LABEL = { off: "Off", hourly: "Every hour", six_hours: "Every 6 hours", daily: "Daily", custom: "Custom" };

function RunsTable({ site, limit }: { site: SiteDetail; limit?: number }) {
  const rows = limit ? site.recentRuns.slice(0, limit) : site.recentRuns;
  if (rows.length === 0) return <EmptyState title="No checks yet">Run the first check to see what reaches the destination.</EmptyState>;
  return (
    <Table label="Recent checks" minWidth={560}>
      <thead><tr><th scope="col" className={TH}>Check</th><th scope="col" className={TH}>Result</th><th scope="col" className={TH}>Started</th><th scope="col" className={TH}>Duration</th></tr></thead>
      <tbody>
        {rows.map((run) => (
          <tr key={run.id} className="hover:bg-subtle">
            <td className={`${TD} t-code`}><Link href={`/app/runs/${run.id}`} className="inline-flex min-h-8 items-center underline underline-offset-4">{shortId(run.id)}</Link></td>
            <td className={TD}><RunResultStatus result={run.result} state={run.state} /></td>
            <td className={`${TD} whitespace-nowrap text-muted`}>{formatDateTime(run.startedAt)}</td>
            <td className={`${TD} whitespace-nowrap text-muted`}>{formatDuration(run.durationMs)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Overview({ site }: { site: SiteDetail }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Panel title="Recent checks" className="overflow-hidden"><RunsTable site={site} limit={5} /></Panel>
      <div className="grid content-start gap-6">
        <Panel title="Delivery destination">
          {site.destination ? <DefinitionRows rows={[{ term: "Name", value: site.destination.displayName }, { term: "Status", value: <ConnectionStatus status={site.destination.status} /> }, { term: "Last verified", value: formatDateTime(site.destination.lastVerifiedAt) }]} /> : <p className="p-5 text-sm text-muted">No destination connected. Checks can&apos;t run without one.</p>}
        </Panel>
        <Panel title="Schedule">
          <DefinitionRows rows={[{ term: "Frequency", value: SCHEDULE_LABEL[site.schedule?.mode ?? "off"] }, { term: "Next check", value: site.schedule?.paused ? "Paused" : site.schedule?.nextRunAt ? formatDateTime(site.schedule.nextRunAt) : "None scheduled" }]} />
        </Panel>
      </div>
    </div>
  );
}

function Repairs({ site }: { site: SiteDetail }) {
  if (site.incidents.length === 0) return <Panel><EmptyState title="No incidents">When a check doesn&apos;t reach the destination, its investigation and repair appear here.</EmptyState></Panel>;
  return (
    <Panel className="overflow-hidden">
      <ul className="divide-y divide-line-subtle">
        {site.incidents.map((incident) => (
          <li key={incident.id}>
            <Link href={`/app/incidents/${incident.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-subtle">
              <span><span className="block text-[15px] font-medium">{incident.title}</span><span className="text-[13px] text-muted">Opened {formatDateTime(incident.createdAt)}</span></span>
              <Status tone={INCIDENT_TONES[incident.state] ?? "neutral"}>{INCIDENT_STATE_LABELS[incident.state as IncidentState]}</Status>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export default function SitePage() {
  const { siteId } = useParams<{ siteId: string }>();
  const router = useRouter();
  const toast = useToast();
  const canRun = useCan("run:start");
  const site = useQuery({ queryKey: ["site", siteId], queryFn: () => api<SiteDetail>(`/sites/${siteId}`), refetchInterval: 8000 });
  const idempotency = useRef(crypto.randomUUID());
  const run = useMutation({
    mutationFn: () => api<{ runId: string }>(`/sites/${siteId}/runs`, { body: { trigger: "manual" }, idempotencyKey: idempotency.current }),
    onSuccess: ({ runId }) => { idempotency.current = crypto.randomUUID(); router.push(`/app/runs/${runId}`); },
    onError: (error) => toast(errorMessage(error), "danger"),
  });
  return (
    <QueryState query={site}>
      {(detail) => {
        const latest = detail.recentRuns[0];
        const blocked = !detail.destination || !detail.formConfig || detail.verificationStatus !== "verified";
        return (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
            <PageHeader
              title={detail.name}
              subtitle={<>{latest?.summary ?? "This website hasn't been checked yet."}{detail.fixtureLabel ? <span className="mt-1 block text-[13px] font-medium text-warning">{detail.fixtureLabel}</span> : null}</>}
              actions={
                <>
                  <Link href={`/app/sites/${detail.id}/configure`} className={buttonClass("secondary")}>Edit settings</Link>
                  <Button loading={run.isPending} disabled={!canRun || blocked} title={!canRun ? NO_ROLE_REASON : blocked ? "Finish setup before running a check." : undefined} onClick={() => run.mutate()}>Run check</Button>
                </>
              }
            />
            {blocked ? <div className="rounded-panel border border-warning px-4 py-3 text-sm">Setup isn&apos;t finished. <Link href={`/app/sites/new?site=${detail.id}`} className="font-medium underline underline-offset-4">Continue setup</Link></div> : null}
            <dl className="flex flex-wrap gap-x-10 gap-y-2 border-b border-line-subtle pb-4 text-sm">
              <div className="flex items-center gap-2"><dt className="text-[13px] text-muted">Latest result</dt><dd><RunResultStatus result={latest?.result} state={latest?.state} /></dd></div>
              <div className="flex items-baseline gap-2"><dt className="text-[13px] text-muted">Last check</dt><dd>{formatDateTime(latest?.completedAt)}</dd></div>
              <div className="flex items-baseline gap-2"><dt className="text-[13px] text-muted">Next check</dt><dd>{detail.schedule?.nextRunAt ? formatDateTime(detail.schedule.nextRunAt) : "None scheduled"}</dd></div>
            </dl>
            <Tabs
              label="Website sections"
              items={[
                { value: "overview", label: "Overview", content: <Overview site={detail} /> },
                { value: "checks", label: "Checks", content: <Panel className="overflow-hidden"><RunsTable site={detail} /></Panel> },
                { value: "repairs", label: "Repairs", content: <Repairs site={detail} /> },
                { value: "configuration", label: "Configuration", content: <Panel><div className="flex flex-wrap items-center justify-between gap-3 p-5"><p className="text-sm text-muted">Selectors, destination, repository, schedule and test data.</p><Link href={`/app/sites/${detail.id}/configure`} className={buttonClass("secondary")}>Open configuration</Link></div></Panel> },
              ]}
            />
          </div>
        );
      }}
    </QueryState>
  );
}
