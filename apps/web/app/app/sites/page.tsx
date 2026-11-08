"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, EmptyState, Input, Panel, Select } from "@inlet/ui";
import { buttonClass } from "@inlet/ui/classes";
import { NO_ROLE_REASON, PageHeader, QueryState, RunResultStatus, Table, TD, TH, useCan } from "@/components/app/common";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { SiteListItem } from "@/lib/types";

type SitesResponse = { sites: SiteListItem[]; summary: { connected: number; needsAttention: number; lastCompletedAt: string | null } };

export default function SitesPage() {
  const router = useRouter();
  const canEdit = useCan("site:edit");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("checked");
  const params = new URLSearchParams({ sort, ...(search ? { search } : {}), ...(status ? { status } : {}) });
  const query = useQuery({ queryKey: ["sites", params.toString()], queryFn: () => api<SitesResponse>(`/sites?${params}`), refetchInterval: 8000 });
  const filtered = Boolean(search || status);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader
        title="Websites"
        subtitle="Check the forms your team maintains and see whether enquiries are arriving."
        actions={canEdit ? <Link href="/app/sites/new" className={buttonClass("primary")}>Add website</Link> : <Button disabled title={NO_ROLE_REASON}>Add website</Button>}
      />
      <QueryState query={query}>
        {(data) => (
          <>
            <dl className="flex flex-wrap gap-x-10 gap-y-2 border-b border-line-subtle pb-4">
              <div className="flex items-baseline gap-2"><dt className="text-[13px] text-muted">Connected sites</dt><dd className="text-[15px] font-semibold">{data.summary.connected}</dd></div>
              <div className="flex items-baseline gap-2"><dt className="text-[13px] text-muted">Needs attention</dt><dd className="text-[15px] font-semibold">{data.summary.needsAttention}</dd></div>
              <div className="flex items-baseline gap-2"><dt className="text-[13px] text-muted">Last completed check</dt><dd className="text-[15px] font-semibold">{formatDateTime(data.summary.lastCompletedAt)}</dd></div>
            </dl>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px_180px]">
              <div>
                <label htmlFor="site-search" className="sr-only">Search websites</label>
                <Input id="site-search" type="search" placeholder="Search websites" value={search} onChange={(event) => setSearch(event.target.value)} />
              </div>
              <div>
                <label htmlFor="site-status" className="sr-only">Filter by latest result</label>
                <Select id="site-status" value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="">All results</option>
                  <option value="received">Received</option>
                  <option value="not_received">Not received</option>
                  <option value="unverified">Unverified</option>
                  <option value="browser_failed">Browser failed</option>
                  <option value="none">Not yet checked</option>
                </Select>
              </div>
              <div>
                <label htmlFor="site-sort" className="sr-only">Sort</label>
                <Select id="site-sort" value={sort} onChange={(event) => setSort(event.target.value)}>
                  <option value="checked">Recently checked</option>
                  <option value="status">Status</option>
                  <option value="name">Name</option>
                </Select>
              </div>
            </div>
            {data.sites.length === 0 ? (
              <Panel>
                {filtered ? (
                  <EmptyState title="No websites match" action={<Button variant="secondary" onClick={() => { setSearch(""); setStatus(""); }}>Clear filters</Button>}>Try a different search or result.</EmptyState>
                ) : (
                  <EmptyState title="No websites connected" action={canEdit ? <Link href="/app/sites/new" className={buttonClass("primary")}>Add a website</Link> : undefined}>
                    A check needs two connections: the website with your form, and the delivery destination where its messages should arrive.
                  </EmptyState>
                )}
              </Panel>
            ) : (
              <>
                <Panel className="hidden overflow-hidden md:block">
                  <Table label="Websites" minWidth={860}>
                    <thead>
                      <tr><th scope="col" className={TH}>Website</th><th scope="col" className={TH}>Form</th><th scope="col" className={TH}>Latest result</th><th scope="col" className={TH}>Last checked</th><th scope="col" className={TH}>Next check</th><th scope="col" className={TH}>Owner</th><th scope="col" className={TH}><span className="sr-only">Actions</span></th></tr>
                    </thead>
                    <tbody>
                      {data.sites.map((site) => (
                        <tr key={site.id} onClick={() => router.push(`/app/sites/${site.id}`)} className="min-h-[52px] cursor-pointer hover:bg-subtle">
                          <td className={TD}>
                            <Link href={`/app/sites/${site.id}`} onClick={(event) => event.stopPropagation()} className="font-medium">{site.name}</Link>
                            {site.fixtureLabel ? <p className="text-[12px] text-warning">{site.fixtureLabel}</p> : null}
                          </td>
                          <td className={`${TD} t-code max-w-[220px] truncate`}>{new URL(site.formUrl).pathname}</td>
                          <td className={TD}><RunResultStatus result={site.latestRun?.result} state={site.latestRun?.state} /></td>
                          <td className={`${TD} whitespace-nowrap text-muted`}>{formatDateTime(site.latestRun?.completedAt)}</td>
                          <td className={`${TD} whitespace-nowrap text-muted`}>{site.nextRunAt ? formatDateTime(site.nextRunAt) : "No schedule"}</td>
                          <td className={`${TD} text-muted`}>{site.ownerName ?? "Unassigned"}</td>
                          <td className={`${TD} text-right`}>
                            {site.openIncidentId ? <Link href={`/app/incidents/${site.openIncidentId}`} onClick={(event) => event.stopPropagation()} className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4">Open incident</Link> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Panel>
                <ul className="grid gap-2 md:hidden">
                  {data.sites.map((site) => (
                    <li key={site.id}>
                      <Link href={`/app/sites/${site.id}`} className="block rounded-panel border border-line p-4">
                        <p className="break-words font-medium">{site.name}</p>
                        <div className="mt-1"><RunResultStatus result={site.latestRun?.result} state={site.latestRun?.state} /></div>
                        <p className="mt-1 text-[13px] text-muted">{site.openIncidentId ? "An incident needs review" : site.nextRunAt ? `Next check ${formatDateTime(site.nextRunAt)}` : "No schedule set"}</p>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </QueryState>
    </div>
  );
}
