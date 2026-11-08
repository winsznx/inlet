"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button, EmptyState, Notice, Panel, Status, useToast } from "@inlet/ui";
import { PageHeader, QueryState, useCan } from "@/components/app/common";
import { ConnectionStatus } from "@/components/app/site-editors";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

type Connections = {
  ownership: { siteId: string; name: string; status: string; method: string | null; lastVerifiedAt: string | null; detail: string | null }[];
  destinations: { id: string; siteId: string; siteName?: string; type: string; displayName: string; status: string; lastVerifiedAt: string | null; lastError: string | null }[];
  repositories: { id: string; siteId: string; siteName?: string; provider: string; repoSlug: string; status: string; lastValidatedAt: string | null; isControlledFixture: boolean }[];
  inference: { configured: boolean; modelOverride: string | null; baseUrl: string };
  github: { configured: boolean };
  notifications: { recipient: string; configured: boolean };
};

function Row({ title, detail, status, action }: { title: ReactNode; detail: ReactNode; status: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5">
      <div className="min-w-0 flex-1 basis-56"><p className="break-words text-[15px] font-medium">{title}</p><p className="text-[13px] text-muted">{detail}</p></div>
      <div className="flex flex-wrap items-center gap-4">{status}{action}</div>
    </li>
  );
}

const configureLink = (siteId: string, label: string) => <Link href={`/app/sites/${siteId}/configure`} className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4">{label}</Link>;

export default function ConnectionsPage() {
  const toast = useToast();
  const canManage = useCan("secret:manage");
  const query = useQuery({ queryKey: ["connections"], queryFn: () => api<Connections>("/connections") });
  const test = useMutation({ mutationFn: () => api<{ ok: boolean; detail: string }>("/connections/inference/test", { body: {} }), onSuccess: (result) => toast(result.detail, result.ok ? "success" : "danger"), onError: (error) => toast(errorMessage(error), "danger") });
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader title="Connections" subtitle="Everything a check depends on. Credentials are never shown again after you enter them." />
      <QueryState query={query}>
        {(data) => (
          <>
            <Panel title="Website ownership">
              {data.ownership.length === 0 ? <EmptyState title="No websites yet" /> : <ul className="divide-y divide-line-subtle">{data.ownership.map((row) => <Row key={row.siteId} title={row.name} detail={row.lastVerifiedAt ? `Verified ${formatDateTime(row.lastVerifiedAt)}` : (row.detail ?? "Waiting for verification")} status={<ConnectionStatus status={row.status} />} action={configureLink(row.siteId, row.status === "connected" ? "Manage" : "Connect")} />)}</ul>}
            </Panel>
            <Panel title="Destinations">
              {data.destinations.length === 0 ? <p className="p-5 text-sm text-muted">No destinations. Without one, checks can&apos;t tell whether an enquiry arrived.</p> : <ul className="divide-y divide-line-subtle">{data.destinations.map((row) => <Row key={row.id} title={`${row.displayName}, ${row.siteName}`} detail={row.lastError ? `Last error: ${row.lastError}` : `Last verified ${formatDateTime(row.lastVerifiedAt)}`} status={<ConnectionStatus status={row.status} />} action={configureLink(row.siteId, row.status === "connected" ? "Test" : "Reconnect")} />)}</ul>}
            </Panel>
            <Panel title="Source repositories">
              {data.repositories.length === 0 ? <p className="p-5 text-sm text-muted">None connected. Monitoring works without a repository, but code investigations don&apos;t.</p> : <ul className="divide-y divide-line-subtle">{data.repositories.map((row) => <Row key={row.id} title={row.repoSlug} detail={`${row.siteName}. ${row.isControlledFixture ? "Controlled sample repository" : row.provider}`} status={<ConnectionStatus status={row.status} />} action={configureLink(row.siteId, "Manage")} />)}</ul>}
            </Panel>
            <Panel title="Vultr inference">
              <ul><Row title="Vultr Serverless Inference" detail={data.inference.configured ? `Server key present. ${data.inference.modelOverride ? `Model: ${data.inference.modelOverride}` : "Model chosen from the live catalog."}` : "Admin configuration: set VULTR_INFERENCE_API_KEY on the server. Browser and inbox monitoring keep working without it."} status={data.inference.configured ? <Status tone="success">Connected</Status> : <Status tone="warning">Needs setup</Status>} action={<Button variant="secondary" loading={test.isPending} disabled={!canManage} onClick={() => test.mutate()}>Test</Button>} /></ul>
            </Panel>
            <Panel title="GitHub">
              <ul><Row title="GitHub App" detail={data.github.configured ? "Inlet opens pull requests on its own branches and never merges." : "Optional. Without it you can download each tested patch as a file."} status={data.github.configured ? <Status tone="success">Connected</Status> : <Status tone="neutral">Not configured</Status>} /></ul>
            </Panel>
            <Panel title="Notifications">
              <ul><Row title={data.notifications.recipient} detail="Alerts go here on failure, recovery and required action." status={<Status tone="success">Connected</Status>} action={<Link href="/app/notifications" className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4">Manage</Link>} /></ul>
            </Panel>
            {!canManage ? <Notice>Your role can view connections. Owners and admins can change credentials.</Notice> : null}
          </>
        )}
      </QueryState>
    </div>
  );
}
