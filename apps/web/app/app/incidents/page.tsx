"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { EmptyState, Panel, Status } from "@inlet/ui";
import { PageHeader, QueryState } from "@/components/app/common";
import { api } from "@/lib/api";
import { formatDateTime, INCIDENT_TONES } from "@/lib/format";

type Row = { id: string; title: string; siteName: string; state: string; stateLabel: string; createdAt: string; updatedAt: string };

export default function IncidentsPage() {
  const query = useQuery({ queryKey: ["incidents"], queryFn: () => api<{ incidents: Row[] }>("/incidents"), refetchInterval: 6000 });
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader title="Incidents" subtitle="Failed deliveries, their investigation, and whether a fix was verified." />
      <QueryState query={query}>
        {({ incidents }) =>
          incidents.length === 0 ? (
            <Panel><EmptyState title="No incidents">An incident opens when a form submits but the enquiry doesn&apos;t reach the destination.</EmptyState></Panel>
          ) : (
            <Panel className="overflow-hidden">
              <ul className="divide-y divide-line-subtle">
                {incidents.map((incident) => (
                  <li key={incident.id}>
                    <Link href={`/app/incidents/${incident.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-subtle">
                      <span className="min-w-0">
                        <span className="block text-[15px] font-medium">{incident.title}</span>
                        <span className="text-[13px] text-muted">{incident.siteName}. Updated {formatDateTime(incident.updatedAt)}</span>
                      </span>
                      <Status tone={INCIDENT_TONES[incident.state] ?? "neutral"}>{incident.stateLabel}</Status>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )
        }
      </QueryState>
    </div>
  );
}
