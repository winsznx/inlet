"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, cx, Notice, Panel, Status } from "@inlet/ui";
import { buttonClass } from "@inlet/ui/classes";
import { RunEvidence } from "@/components/app/run-view";
import type { RunSource } from "@/components/app/run-view";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

type Scenario = { id: string; title: string; description: string };
type Recorded = { label: string; origin: string; modelId: string | null; diff: string; changedFiles: string[]; events: { sequence: number; summary: string }[]; checks: { name: string; variant: string; pass: boolean }[]; before: { id: string; result: string; completedAt: string } | null; after: { id: string; result: string; completedAt: string } | null } | null;

function RecordedRepair() {
  const query = useQuery({ queryKey: ["recorded"], queryFn: () => api<{ recorded: Recorded }>("/demo/recorded-repair") });
  const recorded = query.data?.recorded;
  if (!recorded) return <p className="text-sm text-muted">No verified repair has been published to this demo yet. Create a workspace to run the full repair on the sample site.</p>;
  return (
    <Panel title="Recorded real run">
      <div className="grid gap-4 p-5">
        <Status tone="success">Verified recovered</Status>
        <p className="text-sm text-muted">{recorded.origin === "non_ai_harness" ? "This repair used the non-AI test harness. No model wrote this patch." : `Investigated by ${recorded.modelId} on Vultr Serverless Inference.`} Failed check finished {formatDateTime(recorded.before?.completedAt)}. Recovered check finished {formatDateTime(recorded.after?.completedAt)}.</p>
        <pre className="t-code overflow-x-auto rounded-input bg-subtle p-3" tabIndex={0}>{recorded.diff}</pre>
        <ul className="flex flex-wrap gap-x-5 gap-y-1">{recorded.checks.filter((check) => check.variant === "patched").map((check) => <li key={check.name}><Status tone={check.pass ? "success" : "danger"}>{check.name}</Status></li>)}</ul>
      </div>
    </Panel>
  );
}

export default function DemoPage() {
  const scenarios = useQuery({ queryKey: ["scenarios"], queryFn: () => api<{ scenarios: Scenario[] }>("/demo/scenarios") });
  const [choice, setChoice] = useState("working");
  const [runId, setRunId] = useState<string | null>(null);
  const run = useMutation({ mutationFn: () => api<{ runId: string }>(`/demo/scenarios/${choice}/runs`, { body: {} }), onSuccess: (result) => setRunId(result.runId) });
  const source: RunSource | null = useMemo(() => (runId ? { key: `demo-${runId}`, detailPath: `/demo/runs/${runId}`, eventsPath: `/demo/runs/${runId}/events`, artifactUrl: (id) => `/api/v1/demo/runs/${runId}/artifacts/${id}` } : null), [runId]);
  return (
    <div className="shell py-10 lg:py-16">
      <div className="max-w-[760px]">
        <p className="t-overline">Controlled test environment</p>
        <h1 className="t-h2 mt-3">Watch a real check.</h1>
        <p className="t-body-lg mt-4 text-ink-2">A real browser opens a test site we own, submits one marked enquiry, and Inlet looks for it in a test mailbox. No customer information is involved.</p>
      </div>
      <div className="mt-8 grid max-w-[760px] gap-5">
        <div role="radiogroup" aria-label="Scenario" className="divide-y divide-line rounded-panel border border-line">
          {scenarios.data?.scenarios.map((scenario) => (
            <label key={scenario.id} className={cx("flex min-h-14 cursor-pointer items-start gap-3 px-4 py-3.5", choice === scenario.id && "bg-subtle")}>
              <input type="radio" name="scenario" value={scenario.id} checked={choice === scenario.id} onChange={() => setChoice(scenario.id)} className="mt-1 size-4 accent-[var(--graphite-950)]" />
              <span><span className="block text-[15px] font-medium">{scenario.title}</span><span className="block text-[13px] text-muted">{scenario.description}</span></span>
            </label>
          ))}
        </div>
        {run.isError ? <Notice tone="danger">{errorMessage(run.error)}</Notice> : null}
        <div className="flex flex-wrap gap-3">
          <Button loading={run.isPending} disabled={!scenarios.data} onClick={() => run.mutate()}>Run test</Button>
          <Link href="/register" className={buttonClass("secondary")}>Create workspace</Link>
        </div>
      </div>
      {source ? <div className="mt-12"><RunEvidence key={source.key} source={source} inProductHeader={false} /></div> : null}
      <div className="mt-14 max-w-[900px]">
        <h2 className="t-h3">The repair path</h2>
        <p className="mt-2 max-w-[62ch] text-[15px] text-muted">Public visitors can&apos;t change a repository. This is a recording of a real run on the sample site, labelled as recorded.</p>
        <div className="mt-5"><RecordedRepair /></div>
      </div>
    </div>
  );
}
