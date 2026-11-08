"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, EmptyState, Input, Panel, Select } from "@inlet/ui";
import { buttonClass } from "@inlet/ui/classes";
import { PageHeader, PageSkeleton, RunResultStatus, Table, TD, TH } from "@/components/app/common";
import { api } from "@/lib/api";
import { formatDateTime, formatDuration, shortId } from "@/lib/format";
import type { RunResult, RunState } from "@inlet/domain/states";
import type { SiteListItem } from "@/lib/types";

type RunRow = { runId: string; siteId: string | null; siteName: string | null; formPath: string | null; state: RunState; result: RunResult | null; trigger: string; startedAt: string | null; durationMs: number | null; hasEvidence: boolean };

const TRIGGER_LABEL: Record<string, string> = { manual: "Manual", schedule: "Schedule", first_check: "First check", recheck: "Post-deployment" };

export default function RunsPage() {
  const router = useRouter();
  const [siteId, setSiteId] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const filters = new URLSearchParams({ ...(siteId ? { siteId } : {}), ...(status ? { status } : {}), ...(search ? { search } : {}), ...(from ? { from: new Date(from).toISOString() } : {}) });
  const sites = useQuery({ queryKey: ["sites", "all"], queryFn: () => api<{ sites: SiteListItem[] }>("/sites") });
  const query = useInfiniteQuery({
    queryKey: ["runs", filters.toString()],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api<{ runs: RunRow[]; nextCursor: string | null }>(`/runs?${filters}${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 6000,
  });
  const rows = query.data?.pages.flatMap((page) => page.runs) ?? [];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader
        title="Checks"
        subtitle="Every test submission and what reached the connected destination."
        actions={<a href={`/api/v1/runs.csv?${filters}`} className={buttonClass("secondary")}><Download size={16} aria-hidden /> Download CSV</a>}
      />
      <div className="grid gap-3 md:grid-cols-4">
        <div><label htmlFor="r-site" className="sr-only">Website</label><Select id="r-site" value={siteId} onChange={(event) => setSiteId(event.target.value)}><option value="">All websites</option>{sites.data?.sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</Select></div>
        <div><label htmlFor="r-status" className="sr-only">Result</label><Select id="r-status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All results</option><option value="received">Received</option><option value="not_received">Not received</option><option value="unverified">Unverified</option><option value="browser_failed">Browser failed</option><option value="canceled">Canceled</option><option value="expired">Expired</option><option value="active">Running</option></Select></div>
        <div><label htmlFor="r-from" className="sr-only">From date</label><Input id="r-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></div>
        <div><label htmlFor="r-search" className="sr-only">Search by run ID</label><Input id="r-search" placeholder="Search by run ID" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      </div>
      {query.isPending ? <PageSkeleton /> : query.isError ? <p role="alert" className="text-danger">The checks couldn&apos;t load.</p> : rows.length === 0 ? (
        <Panel><EmptyState title={filters.size > 0 ? "No checks match these filters" : "No checks yet"}>{filters.size > 0 ? "Try removing a filter." : "Checks appear here after you run the first one on a website."}</EmptyState></Panel>
      ) : (
        <>
          <Panel className="overflow-hidden">
            <Table label="Checks" minWidth={820}>
              <thead><tr><th scope="col" className={TH}>Form</th><th scope="col" className={TH}>Site</th><th scope="col" className={TH}>Result</th><th scope="col" className={TH}>Started</th><th scope="col" className={TH}>Duration</th><th scope="col" className={TH}>Trigger</th><th scope="col" className={TH}>Evidence</th></tr></thead>
              <tbody>
                {rows.map((run) => (
                  <tr key={run.runId} onClick={() => router.push(`/app/runs/${run.runId}`)} className="cursor-pointer hover:bg-subtle">
                    <td className={`${TD} t-code`}><Link href={`/app/runs/${run.runId}`} onClick={(event) => event.stopPropagation()}>{run.formPath ?? "form"}</Link> <span className="text-muted">{shortId(run.runId)}</span></td>
                    <td className={TD}>{run.siteName}</td>
                    <td className={TD}><RunResultStatus result={run.result} state={run.state} /></td>
                    <td className={`${TD} whitespace-nowrap text-muted`}>{formatDateTime(run.startedAt)}</td>
                    <td className={`${TD} whitespace-nowrap text-muted`}>{formatDuration(run.durationMs)}</td>
                    <td className={`${TD} text-muted`}>{TRIGGER_LABEL[run.trigger] ?? run.trigger}</td>
                    <td className={`${TD} text-muted`}>{run.hasEvidence ? "Available" : "None"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
          {query.hasNextPage ? <div><Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more</Button></div> : null}
        </>
      )}
    </div>
  );
}
