"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { Button, Panel, useToast } from "@inlet/ui";
import { NO_ROLE_REASON, PageHeader, QueryState, useCan } from "@/components/app/common";
import { DestinationEditor, FormMappingEditor, OwnershipStep, RepositoryEditor, ScheduleEditor } from "@/components/app/site-editors";
import { api, errorMessage } from "@/lib/api";
import type { SiteDetail } from "@/lib/types";

export default function ConfigurePage() {
  const { siteId } = useParams<{ siteId: string }>();
  const router = useRouter();
  const toast = useToast();
  const canEdit = useCan("site:edit");
  const site = useQuery({ queryKey: ["site", siteId], queryFn: () => api<SiteDetail>(`/sites/${siteId}`) });
  const archive = useMutation({ mutationFn: () => api(`/sites/${siteId}`, { method: "DELETE" }), onSuccess: () => router.push("/app/sites"), onError: (error) => toast(errorMessage(error), "danger") });
  const reset = useMutation({ mutationFn: () => api("/fixture/reset", { body: {} }), onSuccess: () => toast("The sample site is back to its original broken state."), onError: (error) => toast(errorMessage(error), "danger") });
  return (
    <QueryState query={site}>
      {(detail) => (
        <div className="grid max-w-[820px] grid-cols-[minmax(0,1fr)] gap-6">
          <PageHeader title={`Configure ${detail.name}`} subtitle={detail.formUrl} />
          <Panel title="Ownership"><div className="p-5"><OwnershipStep site={detail} onVerified={() => undefined} /></div></Panel>
          <Panel title="Delivery destination"><div className="p-5"><DestinationEditor site={detail} /></div></Panel>
          <Panel title="Form fields and test details"><div className="p-5"><FormMappingEditor key={detail.formConfig?.version ?? 0} site={detail} /></div></Panel>
          <Panel title="Source repository"><div className="p-5"><RepositoryEditor site={detail} /></div></Panel>
          <Panel title="Schedule"><div className="p-5"><ScheduleEditor key={detail.schedule?.mode} site={detail} /></div></Panel>
          {detail.repository?.isControlledFixture ? (
            <Panel title="Sample site">
              <div className="flex flex-wrap items-center justify-between gap-3 p-5">
                <p className="max-w-[52ch] text-sm text-muted">Restore the controlled fault so the repair can be run again. Past incidents stay in your history.</p>
                <Button variant="secondary" loading={reset.isPending} disabled={!canEdit} title={canEdit ? undefined : NO_ROLE_REASON} onClick={() => reset.mutate()}>Reset sample site</Button>
              </div>
            </Panel>
          ) : null}
          <Panel title="Archive website">
            <div className="flex flex-wrap items-center justify-between gap-3 p-5">
              <p className="max-w-[52ch] text-sm text-muted">Stops all checks and hides this website. Past incidents stay in your history until retention removes them.</p>
              <Button variant="danger" loading={archive.isPending} disabled={!canEdit} title={canEdit ? undefined : NO_ROLE_REASON} onClick={() => { if (window.confirm(`Archive ${detail.name}? Scheduled checks will stop.`)) archive.mutate(); }}>Archive website</Button>
            </div>
          </Panel>
        </div>
      )}
    </QueryState>
  );
}
