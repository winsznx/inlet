"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useRef } from "react";
import { Button, useToast } from "@inlet/ui";
import { NO_ROLE_REASON, useCan } from "@/components/app/common";
import { RunEvidence, RunLinks } from "@/components/app/run-view";
import type { RunSource } from "@/components/app/run-view";
import { api, errorMessage } from "@/lib/api";
import type { RunDetail } from "@/lib/types";

function RunActions({ run }: { run: RunDetail }) {
  const router = useRouter();
  const client = useQueryClient();
  const toast = useToast();
  const canRun = useCan("run:start");
  const idempotency = useRef(crypto.randomUUID());
  const again = useMutation({
    mutationFn: () => api<{ runId: string }>(`/sites/${run.siteId}/runs`, { body: { trigger: "manual" }, idempotencyKey: idempotency.current }),
    onSuccess: ({ runId }) => router.push(`/app/runs/${runId}`),
    onError: (error) => toast(errorMessage(error), "danger"),
  });
  const cancel = useMutation({
    mutationFn: () => api(`/runs/${run.runId}/cancel`, { body: {} }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["run", run.runId] }),
    onError: (error) => toast(errorMessage(error), "danger"),
  });
  return (
    <>
      <RunLinks run={run} />
      {run.canCancel ? <Button variant="secondary" loading={cancel.isPending} disabled={!canRun} title={canRun ? undefined : NO_ROLE_REASON} onClick={() => cancel.mutate()}>Cancel</Button> : null}
      {run.result && run.siteId ? <Button loading={again.isPending} disabled={!canRun} title={canRun ? undefined : NO_ROLE_REASON} onClick={() => again.mutate()}>Run again</Button> : null}
    </>
  );
}

export default function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const source: RunSource = useMemo(() => ({ key: runId, detailPath: `/runs/${runId}`, eventsPath: `/runs/${runId}/events`, artifactUrl: (id) => `/api/v1/artifacts/${id}/download` }), [runId]);
  return <RunEvidence key={runId} source={source} actions={(run) => <RunActions run={run} />} />;
}
