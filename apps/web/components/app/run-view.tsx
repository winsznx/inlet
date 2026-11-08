"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Circle, Download, ImageOff } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo } from "react";
import { CopyButton, cx, DefinitionRows, Panel, Skeleton, Status, Tabs } from "@inlet/ui";
import { buttonClass } from "@inlet/ui/classes";
import { formatClock, formatDuration } from "@/lib/format";
import type { RunDetail, RunEvent } from "@/lib/types";
import { PageSkeleton, QueryState, TH, TD, Table } from "./common";

export type RunSource = { key: string; detailPath: string; eventsPath: string; artifactUrl: (id: string) => string };

const STEP_ORDER = ["Preparing sandbox", "Opening form", "Filling test details", "Submitting", "Checking destination", "Result", "Cleaning up"];

type Step = { label: string; status: "done" | "current" | "pending" | "failed" };

function deriveSteps(run: RunDetail, events: RunEvent[]): Step[] {
  const seen = new Set(events.map((event) => event.type));
  const reached = [
    seen.has("sandbox.started"),
    seen.has("browser.opened"),
    seen.has("form.mapped"),
    seen.has("form.submitted"),
    seen.has("destination.polling"),
    seen.has("run.completed"),
    seen.has("sandbox.destroyed") || run.state === "cleanup_complete",
  ];
  let resultLabel = "Result";
  if (seen.has("destination.matched")) resultLabel = "Receipt found";
  else if (seen.has("destination.timed_out")) resultLabel = "No receipt observed";
  else if (seen.has("destination.unavailable") || seen.has("run.inconclusive")) resultLabel = "Inconclusive";
  else if (seen.has("run.browser_failed")) resultLabel = "Browser could not submit";

  const lastReached = reached.lastIndexOf(true);
  const finished = run.state === "cleanup_complete";
  const stopped = reached[5] && !reached[4];
  return STEP_ORDER.map((label, index) => {
    const display = index === 5 ? resultLabel : label;
    if (stopped && index < 5 && !reached[index]) return { label: display, status: "pending" as const };
    if (reached[index]) return { label: display, status: index === 5 && run.result !== "received" ? ("failed" as const) : ("done" as const) };
    if (!finished && index === lastReached + 1) return { label: display, status: "current" as const };
    return { label: display, status: "pending" as const };
  });
}

function deriveContainmentSteps(run: RunDetail, events: RunEvent[]): Step[] {
  const seen = new Set(events.map((event) => event.type));
  const finished = run.state === "cleanup_complete";
  const reached = [seen.has("sandbox.started"), seen.has("containment.probe") || seen.has("policy.denied"), seen.has("run.completed"), seen.has("sandbox.destroyed") || finished];
  const verdict = run.result === "blocked" ? "Action blocked" : run.result === "containment_failed" ? "Not contained" : run.result ? "Inconclusive" : "Verdict";
  const lastReached = reached.lastIndexOf(true);
  return ["Starting environment", "Attempting forbidden actions", verdict, "Removing environment"].map((label, index) => {
    if (reached[index]) return { label, status: index === 2 && run.result !== "blocked" ? "failed" : "done" };
    return { label, status: !finished && index === lastReached + 1 ? "current" : "pending" };
  });
}

function RouteSteps({ run, events }: { run: RunDetail; events: RunEvent[] }) {
  const steps = run.kind === "containment" ? deriveContainmentSteps(run, events) : deriveSteps(run, events);
  return (
    <ol aria-label="Progress" className="px-5 py-4">
      {steps.map((step, index) => (
        <li key={step.label} className="relative flex items-center gap-3 pb-3 last:pb-0" aria-current={step.status === "current" ? "step" : undefined}>
          {index < steps.length - 1 ? <span className={cx("absolute left-[8px] top-5 h-[calc(100%-12px)] w-0.5", step.status === "done" ? "bg-ink" : "bg-line")} aria-hidden /> : null}
          <span className="relative flex size-[18px] shrink-0 items-center justify-center">
            {step.status === "done" ? <span className="flex size-[18px] items-center justify-center rounded-[3px] bg-ink"><Check size={12} className="text-white" aria-hidden /></span> : step.status === "failed" ? <span className="size-[18px] rounded-[3px] bg-danger" aria-hidden /> : step.status === "current" ? <span className="size-[18px] animate-pulse rounded-[3px] bg-copper" aria-hidden /> : <Circle size={16} className="text-line-control" aria-hidden />}
          </span>
          <span className={cx("text-sm", step.status === "pending" ? "text-muted" : "font-medium")}>{step.label}<span className="sr-only"> ({step.status})</span></span>
        </li>
      ))}
    </ol>
  );
}

function ProbeList({ events, running }: { events: RunEvent[]; running: boolean }) {
  const probes = events.filter((event) => event.type === "containment.probe");
  if (probes.length === 0) return <p className="text-sm text-muted">{running ? "Waiting for the first attempt." : "No attempts were recorded."}</p>;
  return (
    <ul className="grid gap-3">
      {probes.map((probe) => (
        <li key={probe.sequence} className="grid gap-0.5">
          {probe.safeMetadata?.outcome === "denied" ? <Status tone="success" icon="blocked">Denied</Status> : probe.safeMetadata?.outcome === "allowed" ? <Status tone="neutral">Allowed</Status> : <Status tone="neutral">Recorded</Status>}
          <span className="min-w-0 break-words text-[13px] text-ink-2">{probe.summary}</span>
        </li>
      ))}
    </ul>
  );
}

function headline(run: RunDetail): string {
  if (run.kind === "containment") return run.result === "blocked" ? "Unauthorized action blocked" : run.result === "containment_failed" ? "Containment test failed" : "Running containment test";
  if (!run.result) return `Checking ${run.siteName ?? "website"}`;
  return { received: "Enquiry received", not_received: "Enquiry not received", unverified: "Delivery unverified", browser_failed: "Check could not submit the form", canceled: "Check canceled", expired: "Check interrupted", blocked: "Blocked", containment_failed: "Containment failed" }[run.result];
}

export function useRunStream(source: RunSource): ReturnType<typeof useQuery<RunDetail>> {
  const client = useQueryClient();
  const query = useQuery<RunDetail>({ queryKey: ["run", source.key], queryFn: () => import("@/lib/api").then(({ api }) => api<RunDetail>(source.detailPath)) });
  const finished = query.data?.state === "cleanup_complete";
  const ready = Boolean(query.data);

  useEffect(() => {
    if (!ready || finished) return;
    const stream = new EventSource(`/api/v1${source.eventsPath}`);
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as RunEvent;
      client.setQueryData<RunDetail>(["run", source.key], (current) => {
        if (!current || current.events.some((item) => item.sequence === event.sequence)) return current;
        return { ...current, events: [...current.events, event].sort((a, b) => a.sequence - b.sequence) };
      });
      void client.invalidateQueries({ queryKey: ["run", source.key] });
    };
    stream.addEventListener("end", () => {
      stream.close();
      void client.invalidateQueries({ queryKey: ["run", source.key] });
    });
    return () => stream.close();
  }, [client, finished, ready, source.eventsPath, source.key]);

  return query;
}

function Screenshot({ run, kind, label, source }: { run: RunDetail; kind: string; label: string; source: RunSource }) {
  const artifact = run.evidence.find((item) => item.kind === kind);
  if (!artifact) {
    return (
      <div className="flex aspect-[16/10] flex-col items-center justify-center gap-2 rounded-input border border-dashed border-line text-sm text-muted">
        <ImageOff size={18} aria-hidden />
        {run.result ? "No screenshot was captured." : "Waiting for the browser."}
      </div>
    );
  }
  return (
    <a href={source.artifactUrl(artifact.id)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-input border border-line" title="Open full size">
      {/* Authenticated evidence must not go through the image optimizer. */}
      <img src={source.artifactUrl(artifact.id)} alt={label} className="block h-auto w-full" />
    </a>
  );
}

export function RunEvidence({ source, actions, inProductHeader = true }: { source: RunSource; actions?: (run: RunDetail) => React.ReactNode; inProductHeader?: boolean }) {
  const query = useRunStream(source);
  return (
    <QueryState query={query} loading={<PageSkeleton />}>
      {(run) => <RunBody run={run} source={source} actions={actions} inProductHeader={inProductHeader} />}
    </QueryState>
  );
}

function RunBody({ run, source, actions, inProductHeader }: { run: RunDetail; source: RunSource; actions?: (run: RunDetail) => React.ReactNode; inProductHeader: boolean }) {
  const events = run.events;
  const isDelivery = run.kind === "delivery";
  const sandbox = run.sandboxes[0];

  const subtitle = useMemo(() => {
    if (!isDelivery) return run.summary ?? "A real attempt is running against the isolation boundary.";
    if (!run.result) return `Inlet is testing ${run.siteName ?? "this website"} and will check ${run.delivery.destinationName ?? "the connected destination"}.`;
    return `${run.summary ?? ""}${run.durationMs ? ` Finished in ${formatDuration(run.durationMs)}.` : ""}`;
  }, [isDelivery, run]);

  const Title = inProductHeader ? "h1" : "h2";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <Title className="t-app-title">{headline(run)}</Title>
          <p className="mt-1.5 max-w-[72ch] text-[15px] text-muted" aria-live="polite">{subtitle}</p>
          {run.isControlledFixture || !isDelivery ? <p className="mt-2 text-[13px] font-medium text-warning">Controlled test environment</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {actions?.(run)}
        </div>
      </header>

      {isDelivery ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-panel border border-line px-4 py-1.5">
          <span className="text-[13px] text-muted">Test ID</span>
          <code className="t-code min-w-0 break-all">{run.testToken}</code>
          <CopyButton value={run.testToken} label="Copy ID" className="ml-auto" />
          {run.siteOrigin ? <span className="w-full pb-1 text-[13px] text-muted">Source <span className="t-code break-all">{run.siteOrigin}</span></span> : null}
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-12 lg:grid-cols-2">
        <Panel title={isDelivery ? "Browser journey" : "What was attempted"} className="xl:col-span-7">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-0 md:grid-cols-[minmax(0,1fr)_230px]">
            <div className="min-w-0 p-5">
              {isDelivery || run.evidence.some((item) => item.mime === "image/png") ? <Screenshot run={run} kind="screenshot-after" label="Page after submission" source={source} /> : <ProbeList events={events} running={!run.result} />}
            </div>
            <div className="border-t border-line-subtle md:border-l md:border-t-0">
              <RouteSteps run={run} events={events} />
            </div>
          </div>
          {isDelivery ? (
            <div className="border-t border-line-subtle px-5 py-3.5 text-sm">
              <p>{run.browser?.successUiObserved ? "The form displayed a success message." : run.browser ? "The form did not display a success message." : "The browser hasn't reported yet."}</p>
              {run.browser?.successUiText ? <p className="mt-1 text-[13px] text-muted">&ldquo;{run.browser.successUiText}&rdquo;</p> : null}
              {run.browser?.failureDetail ? <p className="mt-1 text-[13px] text-danger">{run.browser.failureDetail}</p> : null}
            </div>
          ) : null}
        </Panel>

        {isDelivery ? (
          <Panel title="Delivery result" className="xl:col-span-5">
            <div className="px-5 py-4">
              {run.delivery.status === "found" ? <Status tone="success">Matching message found</Status> : run.delivery.status === "not_found" ? <Status tone="danger">No matching message</Status> : run.delivery.status === "unavailable" ? <Status tone="warning">Destination could not be checked</Status> : run.result ? <Status tone="neutral">Destination not checked</Status> : <Status tone="running">Waiting</Status>}
              {run.delivery.status === "not_found" ? <p className="mt-2 text-sm">No matching message arrived in the connected test inbox during the {run.delivery.observationSeconds}-second observation window.</p> : null}
            </div>
            <DefinitionRows
              rows={[
                { term: "Destination", value: run.delivery.destinationName ?? "Not recorded" },
                { term: "Observation window", value: `${run.delivery.observationSeconds} seconds` },
                { term: "Times checked", value: run.delivery.pollCount },
                { term: "Matched at", value: run.delivery.matchedAt ? formatClock(run.delivery.matchedAt) : "No match" },
                { term: "Recipient", value: run.delivery.recipient ?? "No match" },
                { term: "Subject", value: run.delivery.subject ?? "No match" },
                { term: "Message ID hash", value: run.delivery.remoteMessageIdHash ? <code className="t-code break-all">{run.delivery.remoteMessageIdHash.slice(0, 24)}…</code> : "No match" },
              ]}
            />
          </Panel>
        ) : (
          <Panel title="Environment" className="xl:col-span-5">
            <DefinitionRows
              rows={[
                { term: "Container", value: <code className="t-code break-all">{sandbox?.containerName ?? "Starting"}</code> },
                { term: "Runtime", value: sandbox ? `${sandbox.provider} (${sandbox.ociRuntime})` : "Starting" },
                { term: "Limits", value: sandbox ? `${sandbox.cpuLimit} CPU, ${sandbox.memoryLimitMb} MB, ${sandbox.pidsLimit} processes, ${sandbox.wallLimitSeconds} s` : "Starting" },
                { term: "Exit reason", value: sandbox?.exitReason ?? "Running" },
                { term: "Requests denied at network boundary", value: sandbox?.denialCount ?? 0 },
                { term: "Cleanup", value: sandbox?.cleanupVerified ? <Status tone="success">Removal verified</Status> : run.result ? <Status tone="warning">Not verified</Status> : "Pending" },
              ]}
            />
          </Panel>
        )}
      </div>

      <Panel title="Execution details">
        <ol className="divide-y divide-line-subtle">
          {events.map((event) => (
            <li key={event.sequence} className={cx("grid gap-1 px-5 py-2.5 sm:grid-cols-[110px_minmax(0,1fr)]", event.type === "policy.denied" && "bg-copper-tint")}>
              <time dateTime={event.timestamp} className="t-code text-muted">{formatClock(event.timestamp).replace(" UTC", "")}</time>
              <span className="min-w-0 break-words text-sm">{event.summary}</span>
            </li>
          ))}
          {!run.result ? <li className="px-5 py-3"><Skeleton className="h-4 w-48" /></li> : null}
        </ol>
      </Panel>

      <div>
        <Tabs
          label="Evidence"
          items={[
            ...(isDelivery || run.evidence.some((item) => item.mime === "image/png") ? [{ value: "screens", label: "Screenshots", content: <ScreenshotsTab run={run} source={source} /> }] : []),
            ...(isDelivery ? [{ value: "http", label: "HTTP", content: <NetworkTab run={run} /> }, { value: "mail", label: "Mailbox evidence", content: <MailboxTab run={run} /> }] : []),
            { value: "trace", label: "Execution trace", content: <TraceTab run={run} /> },
            { value: "meta", label: "Run metadata", content: <MetaTab run={run} /> },
          ]}
        />
      </div>
    </div>
  );
}

function ScreenshotsTab({ run, source }: { run: RunDetail; source: RunSource }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <figure><Screenshot run={run} kind="screenshot-before" label="Filled form before submission" source={source} /><figcaption className="mt-2 text-[13px] text-muted">Before submitting</figcaption></figure>
      <figure><Screenshot run={run} kind="screenshot-after" label="Page after submission" source={source} /><figcaption className="mt-2 text-[13px] text-muted">After submitting</figcaption></figure>
    </div>
  );
}

function NetworkTab({ run }: { run: RunDetail }) {
  const network = run.browser?.network ?? [];
  if (network.length === 0) return <p className="text-sm text-muted">No requests were recorded for this run.</p>;
  return (
    <Panel className="overflow-hidden">
      <Table label="Sanitized network summary" minWidth={560}>
        <thead><tr><th scope="col" className={TH}>Method</th><th scope="col" className={TH}>URL (query removed)</th><th scope="col" className={TH}>Status</th></tr></thead>
        <tbody>
          {network.map((entry, index) => (
            <tr key={`${entry.url}-${index}`}>
              <td className={`${TD} t-code`}>{entry.method}</td>
              <td className={`${TD} t-code break-all`}>{entry.url}</td>
              <td className={`${TD} t-code`}>{entry.failed ? "failed" : (entry.status ?? "unknown")}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

function MailboxTab({ run }: { run: RunDetail }) {
  return (
    <Panel>
      <DefinitionRows
        rows={[
          { term: "Destination type", value: run.delivery.destinationType ?? "Not recorded" },
          { term: "Accessible", value: run.delivery.accessible === null ? "Not checked" : run.delivery.accessible ? "Yes" : "No" },
          { term: "Correlated receipt", value: run.delivery.correlatedReceiptFound ? "Found" : "Not found" },
          { term: "Search started", value: formatClock(run.delivery.searchStartedAt) || "Not started" },
          { term: "Search ended", value: formatClock(run.delivery.searchEndedAt) || "Not finished" },
          { term: "Match source", value: run.delivery.matchSource ?? "No match" },
          { term: "Verifier version", value: run.delivery.verifierVersion ?? "Not recorded" },
          { term: "Error", value: run.delivery.errorCode ?? "None" },
        ]}
      />
      <p className="border-t border-line-subtle px-5 py-3 text-[13px] text-muted">Inlet stores the subject line with the test ID masked and a hash of the message ID. It doesn't keep the message body.</p>
    </Panel>
  );
}

function TraceTab({ run }: { run: RunDetail }) {
  return (
    <div className="grid gap-4">
      {run.sandboxes.map((sandbox) => (
        <Panel key={sandbox.id} title={`Sandbox: ${sandbox.role}`}>
          <DefinitionRows
            rows={[
              { term: "Container", value: <code className="t-code break-all">{sandbox.containerName}</code> },
              { term: "Image digest", value: <code className="t-code break-all">{sandbox.imageDigest ?? "Unknown"}</code> },
              { term: "Hardening", value: sandbox.hardening.join(", ") },
              { term: "Network policy hash", value: <code className="t-code break-all">{sandbox.networkPolicyHash}</code> },
              { term: "Exit", value: `${sandbox.exitReason ?? "running"}, code ${sandbox.exitCode ?? "none"}` },
              { term: "Cleanup verified", value: sandbox.cleanupVerified ? `Yes, at ${formatClock(sandbox.cleanupVerifiedAt)}` : "No" },
            ]}
          />
        </Panel>
      ))}
      {run.policyDecisions.length > 0 ? (
        <Panel title="Policy decisions" className="overflow-hidden">
          <Table label="Policy decisions" minWidth={620}>
            <thead><tr><th scope="col" className={TH}>Time</th><th scope="col" className={TH}>Layer</th><th scope="col" className={TH}>Target</th><th scope="col" className={TH}>Decision</th></tr></thead>
            <tbody>
              {run.policyDecisions.slice(0, 120).map((decision) => (
                <tr key={decision.id}>
                  <td className={`${TD} t-code`}>{formatClock(decision.timestamp).replace(" UTC", "")}</td>
                  <td className={TD}>{decision.layer}</td>
                  <td className={`${TD} t-code break-all`}>{decision.target}</td>
                  <td className={TD}>{decision.allowed ? "Allowed" : <span className="font-medium text-danger">Denied: {decision.reasonCode}</span>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      ) : null}
    </div>
  );
}

function MetaTab({ run }: { run: RunDetail }) {
  return (
    <Panel>
      <DefinitionRows
        rows={[
          { term: "Run ID", value: <code className="t-code break-all">{run.runId}</code> },
          { term: "Trigger", value: run.trigger },
          { term: "State", value: run.state },
          { term: "Started", value: formatClock(run.startedAt) || "Not started" },
          { term: "Submitted", value: formatClock(run.submittedAt) || "Not submitted" },
          { term: "Completed", value: formatClock(run.completedAt) || "Not finished" },
          { term: "Duration", value: formatDuration(run.durationMs) },
          { term: "Evidence files", value: run.evidence.map((item) => `${item.kind} (${item.sha256.slice(0, 12)})`).join(", ") || "None" },
        ]}
      />
    </Panel>
  );
}

export function RunLinks({ run }: { run: RunDetail }) {
  return (
    <>
      <a href={`/api/v1/runs/${run.runId}/evidence.zip`} className={buttonClass("secondary")}><Download size={16} aria-hidden /> Download evidence</a>
      {run.incidentId ? <Link href={`/app/incidents/${run.incidentId}`} className={buttonClass("secondary")}>View incident</Link> : null}
    </>
  );
}
