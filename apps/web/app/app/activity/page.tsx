"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, EmptyState, Panel } from "@inlet/ui";
import { PageHeader, PageSkeleton } from "@/components/app/common";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

type Event = { id: string; action: string; entityType: string; actorKind: string; actorName: string | null; createdAt: string };

function describe(action: string): string {
  return action.replace(/[._]/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

export default function ActivityPage() {
  const query = useInfiniteQuery({ queryKey: ["activity"], initialPageParam: "", queryFn: ({ pageParam }) => api<{ events: Event[]; nextCursor: string | null }>(`/activity${pageParam ? `?cursor=${pageParam}` : ""}`), getNextPageParam: (last) => last.nextCursor ?? undefined });
  const events = query.data?.pages.flatMap((page) => page.events) ?? [];
  return (
    <div className="grid max-w-[900px] grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader title="Activity" subtitle="An immutable history of who changed what in this workspace." />
      {query.isPending ? <PageSkeleton /> : events.length === 0 ? <Panel><EmptyState title="No activity yet">Actions in this workspace are recorded here.</EmptyState></Panel> : (
        <Panel className="overflow-hidden">
          <ul className="divide-y divide-line-subtle">
            {events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 px-5 py-3">
                <span className="text-sm">{describe(event.action)}<span className="text-muted"> by {event.actorName ?? "Inlet"}</span></span>
                <time dateTime={event.createdAt} className="text-[13px] text-muted">{formatDateTime(event.createdAt)}</time>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {query.hasNextPage ? <div><Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more</Button></div> : null}
    </div>
  );
}
