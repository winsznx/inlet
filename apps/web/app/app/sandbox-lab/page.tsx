"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button, Notice, Panel, Status, useToast } from "@inlet/ui";
import { NO_ROLE_REASON, PageHeader, QueryState, RunResultStatus, useCan } from "@/components/app/common";
import { RunEvidence } from "@/components/app/run-view";
import type { RunSource } from "@/components/app/run-view";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, shortId } from "@/lib/format";
import type { RunResult, RunState } from "@inlet/domain/states";

type Lab = { tests: { id: string; title: string; description: string }[]; runs: { runId: string; scenario: string; state: RunState; result: RunResult | null; summary: string | null; createdAt: string }[] };

export default function SandboxLabPage() {
  const client = useQueryClient();
  const toast = useToast();
  const canRun = useCan("secret:manage");
  const query = useQuery({ queryKey: ["lab"], queryFn: () => api<Lab>("/internal/sandbox-lab"), refetchInterval: 4000 });
  const [selected, setSelected] = useState<string | null>(null);
  const start = useMutation({ mutationFn: (id: string) => api<{ runId: string }>(`/internal/sandbox-lab/${id}`, { body: {} }), onSuccess: ({ runId }) => { setSelected(runId); void client.invalidateQueries({ queryKey: ["lab"] }); }, onError: (error) => toast(errorMessage(error), "danger") });
  const source: RunSource | null = useMemo(() => (selected ? { key: selected, detailPath: `/internal/sandbox-lab/runs/${selected}`, eventsPath: `/runs/${selected}/events`, artifactUrl: (id) => `/api/v1/artifacts/${id}/download` } : null), [selected]);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader title="Sandbox lab" subtitle="Controlled containment tests against the real isolation boundary. Every result comes from an attempt that actually ran." />
      <Notice tone="warning" title="Controlled test environment">These tests use owned test pages and generated data. There is no way to run your own commands here.</Notice>
      <QueryState query={query}>
        {(data) => (
          <>
            <Panel>
              <ul className="divide-y divide-line-subtle">
                {data.tests.map((test) => (
                  <li key={test.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4">
                    <div className="min-w-0 flex-1 basis-72"><p className="text-[15px] font-medium">{test.title}</p><p className="max-w-[72ch] text-[13px] text-muted">{test.description}</p></div>
                    <Button variant="secondary" loading={start.isPending && start.variables === test.id} disabled={!canRun} title={canRun ? undefined : NO_ROLE_REASON} onClick={() => start.mutate(test.id)}>Run test</Button>
                  </li>
                ))}
              </ul>
            </Panel>
            {source ? <RunEvidence key={source.key} source={source} inProductHeader={false} /> : null}
            <Panel title="Past tests">
              {data.runs.length === 0 ? <p className="p-5 text-sm text-muted">No containment tests have run in this workspace.</p> : (
                <ul className="divide-y divide-line-subtle">
                  {data.runs.map((run) => (
                    <li key={run.runId}>
                      <button type="button" onClick={() => setSelected(run.runId)} className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 px-5 py-3 text-left hover:bg-subtle">
                        <span className="min-w-0"><span className="block text-sm font-medium">{run.scenario} <span className="t-code text-muted">{shortId(run.runId)}</span></span><span className="block text-[13px] text-muted">{formatDateTime(run.createdAt)}. {run.summary}</span></span>
                        {run.result === "blocked" ? <Status tone="success" icon="blocked">Blocked</Status> : <RunResultStatus result={run.result} state={run.state} />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </>
        )}
      </QueryState>
    </div>
  );
}
