"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Button, Checkbox, CopyButton, cx, Dialog, Field, Notice, Panel, Status, Textarea, useToast } from "@inlet/ui";
import { NO_ROLE_REASON, PageHeader, QueryState, useCan } from "@/components/app/common";
import { api, downloadPost, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { PatchDetail } from "@/lib/types";

type Line = { kind: "add" | "del" | "ctx" | "hunk"; text: string; oldNumber: number | null; newNumber: number | null };
type FileDiff = { path: string; lines: Line[] };

function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const path = raw.split(" b/").pop() ?? raw;
      current = { path, lines: [] };
      files.push(current);
    } else if (!current || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("new file") || raw.startsWith("deleted file")) {
      continue;
    } else if (raw.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
      oldLine = Number(match?.[1] ?? 0);
      newLine = Number(match?.[2] ?? 0);
      current.lines.push({ kind: "hunk", text: raw, oldNumber: null, newNumber: null });
    } else if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", text: raw.slice(1), oldNumber: null, newNumber: newLine });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", text: raw.slice(1), oldNumber: oldLine, newNumber: null });
      oldLine += 1;
    } else if (raw.startsWith(" ")) {
      current.lines.push({ kind: "ctx", text: raw.slice(1), oldNumber: oldLine, newNumber: newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return files;
}

const TOKEN = /(\/\/.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:const|let|var|function|return|if|else|async|await|import|from|export|type|new|throw|try|catch)\b)/g;

function Highlight({ text }: { text: string }) {
  const parts = text.split(TOKEN);
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0) return part;
        const cls = part.startsWith("//") ? "text-muted" : /^["'`]/.test(part) ? "text-success" : "text-copper-text";
        return <span key={index} className={cls}>{part}</span>;
      })}
    </>
  );
}

function UnifiedView({ file, wrap }: { file: FileDiff; wrap: boolean }) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`Changes in ${file.path}`}>
      <table className="w-full border-collapse font-mono text-[12.5px] leading-[1.6]">
        <tbody>
          {file.lines.map((line, index) => (
            <tr key={index} className={line.kind === "add" ? "diff-add" : line.kind === "del" ? "diff-del" : line.kind === "hunk" ? "bg-subtle text-muted" : undefined}>
              <td className="w-10 select-none px-2 text-right align-top text-muted">{line.oldNumber ?? ""}</td>
              <td className="w-10 select-none px-2 text-right align-top text-muted">{line.newNumber ?? ""}</td>
              <td className={cx("w-4 select-none align-top", line.kind === "add" && "diff-add-mark", line.kind === "del" && "diff-del-mark")}>{line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}<span className="sr-only">{line.kind === "add" ? "added" : line.kind === "del" ? "removed" : ""}</span></td>
              <td className={cx("pr-3", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>{line.kind === "hunk" ? line.text : <Highlight text={line.text} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SplitView({ file }: { file: FileDiff }) {
  const rows: { left: Line | null; right: Line | null }[] = [];
  let pendingDel: Line[] = [];
  const flush = () => { pendingDel.forEach((line) => rows.push({ left: line, right: null })); pendingDel = []; };
  for (const line of file.lines) {
    if (line.kind === "del") pendingDel.push(line);
    else if (line.kind === "add") { const left = pendingDel.shift() ?? null; rows.push({ left, right: line }); }
    else { flush(); rows.push({ left: line, right: line }); }
  }
  flush();
  const cell = (line: Line | null, side: "old" | "new") => (
    <>
      <td className="w-10 select-none border-l border-line-subtle px-2 text-right align-top text-muted first:border-l-0">{side === "old" ? line?.oldNumber : line?.newNumber}</td>
      <td className={cx("w-1/2 whitespace-pre-wrap break-all pr-2 align-top", line?.kind === "del" && "diff-del", line?.kind === "add" && "diff-add", line?.kind === "hunk" && "bg-subtle text-muted")}>{line ? (line.kind === "hunk" ? line.text : <Highlight text={line.text} />) : ""}</td>
    </>
  );
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`Changes in ${file.path}`}>
      <table className="w-full min-w-[720px] table-fixed border-collapse font-mono text-[12.5px] leading-[1.6]">
        <tbody>
          {rows.map((row, index) => <tr key={index}>{cell(row.left, "old")}{cell(row.right, "new")}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

function DecisionDialog({ patch, decision, onClose, refresh }: { patch: PatchDetail; decision: "approve" | "reject" | null; onClose: () => void; refresh: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const mutate = useMutation({
    mutationFn: () => api(`/patches/${patch.id}/${decision}`, { body: { reason, riskAcknowledged: ack } }),
    onSuccess: () => { toast(decision === "approve" ? "Patch approved. It still has to be deployed." : "Patch rejected."); onClose(); refresh(); },
    onError: (error) => toast(errorMessage(error), "danger"),
  });
  const approving = decision === "approve";
  return (
    <Dialog open={decision !== null} onOpenChange={(open) => { if (!open) onClose(); }} title={approving ? "Approve this patch" : "Reject this patch"} description={approving ? "Approval is recorded with your name. Inlet doesn't merge or deploy anything." : "Your reason is kept in the audit history."} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={mutate.isPending} disabled={reason.trim().length < 3 || (approving && !ack)} onClick={() => mutate.mutate()}>{approving ? "Approve" : "Reject"}</Button></>}>
      <Field label="Reason">{(control) => <Textarea {...control} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />}</Field>
      {approving ? <Checkbox label="I reviewed the diff, the checks and the risk notes." checked={ack} onChange={(event) => setAck(event.target.checked)} /> : null}
    </Dialog>
  );
}

function PatchBody({ patch, refresh }: { patch: PatchDetail; refresh: () => void }) {
  const toast = useToast();
  const canDecide = useCan("patch:decide");
  const canManage = useCan("secret:manage");
  const canComment = useCan("site:edit");
  const files = useMemo(() => parseDiff(patch.diff), [patch.diff]);
  const [view, setView] = useState<"unified" | "split">("unified");
  const [wrap, setWrap] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [comment, setComment] = useState("");
  const visible = selected ? files.filter((file) => file.path === selected) : files;
  const harness = patch.origin === "non_ai_harness";
  const guardFailed = patch.status === "guard_rejected";

  const pr = useMutation({ mutationFn: () => api<{ url: string }>(`/patches/${patch.id}/pull-request`, { body: {} }), onSuccess: () => { toast("Pull request created."); refresh(); }, onError: (error) => toast(errorMessage(error), "danger") });
  const addComment = useMutation({ mutationFn: () => api(`/patches/${patch.id}/comments`, { body: { body: comment } }), onSuccess: () => { setComment(""); refresh(); }, onError: (error) => toast(errorMessage(error), "danger") });

  const patched = patch.checks.filter((check) => check.variant === "patched");
  const baseline = patch.checks.filter((check) => check.variant === "baseline");
  const title = patch.status === "ready" ? "Tested patch ready" : patch.status === "approved" ? "Approved patch" : patch.status === "rejected" ? "Rejected patch" : guardFailed ? "Patch rejected by the guard" : patch.status === "failed" ? "Patch did not pass checks" : "Patch under test";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader
        title={title}
        subtitle={<Link href={`/app/incidents/${patch.incidentId}`} className="underline underline-offset-4">Back to the incident</Link>}
        actions={
          <>
            <CopyButton value={patch.diff} label="Copy patch" className="border border-line-control" />
            <Button variant="secondary" onClick={() => void downloadPost(`/patches/${patch.id}/download`, `inlet-${patch.id}.patch`).catch((error: unknown) => toast(errorMessage(error), "danger"))}>Download patch</Button>
            {patch.canCreatePullRequest && patch.status === "approved" ? <Button variant="secondary" loading={pr.isPending} disabled={!canManage} title={canManage ? undefined : NO_ROLE_REASON} onClick={() => pr.mutate()}>Create pull request</Button> : null}
            {patch.decisionAllowed ? (
              <>
                <Button variant="secondary" disabled={!canDecide} title={canDecide ? undefined : NO_ROLE_REASON} onClick={() => setDecision("reject")}>Reject</Button>
                <Button disabled={!canDecide} title={canDecide ? undefined : NO_ROLE_REASON} onClick={() => setDecision("approve")}>Approve</Button>
              </>
            ) : null}
          </>
        }
      />
      {harness ? <Notice tone="warning" title="Non-AI test harness">This patch came from a deterministic harness for the controlled sample. No model wrote it. The checks and preview below ran for real.</Notice> : null}
      {guardFailed ? <Notice tone="danger" title="This patch can't be approved">{patch.guardFailures?.join(" ")}</Notice> : null}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_320px]">
        <nav aria-label="Changed files">
          <p className="text-[13px] text-muted">{patch.changedFileCount} {patch.changedFileCount === 1 ? "file" : "files"}, {patch.changedLineCount} lines</p>
          <ul className="mt-2 grid gap-0.5">
            <li><button type="button" onClick={() => setSelected(null)} aria-pressed={selected === null} className={cx("min-h-11 w-full rounded-status px-2 text-left text-sm", selected === null ? "bg-subtle font-medium" : "hover:bg-subtle")}>All files</button></li>
            {files.map((file) => <li key={file.path}><button type="button" onClick={() => setSelected(file.path)} aria-pressed={selected === file.path} className={cx("t-code min-h-11 w-full break-all rounded-status px-2 text-left", selected === file.path ? "bg-subtle" : "hover:bg-subtle")}>{file.path}</button></li>)}
          </ul>
        </nav>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="hidden md:flex" role="group" aria-label="Diff layout">
              <Button variant={view === "unified" ? "primary" : "secondary"} className="rounded-r-none" aria-pressed={view === "unified"} onClick={() => setView("unified")}>Unified</Button>
              <Button variant={view === "split" ? "primary" : "secondary"} className="rounded-l-none" aria-pressed={view === "split"} onClick={() => setView("split")}>Split</Button>
            </div>
            <Button variant="secondary" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>{wrap ? "Don't wrap lines" : "Wrap lines"}</Button>
          </div>
          {visible.length === 0 ? <Notice>This candidate has no diff because the guard rejected it first.</Notice> : null}
          {visible.map((file) => (
            <Panel key={file.path} title={<span className="t-code break-all">{file.path}</span>} className="overflow-hidden">
              {view === "split" ? <div className="hidden md:block"><SplitView file={file} /></div> : null}
              <div className={view === "split" ? "md:hidden" : undefined}><UnifiedView file={file} wrap={wrap} /></div>
            </Panel>
          ))}
          <Panel title="Review comments">
            <ul className="divide-y divide-line-subtle">
              {patch.comments.map((item) => <li key={item.id} className="px-5 py-3"><p className="text-sm">{item.body}</p><p className="mt-0.5 text-[13px] text-muted">{item.authorName}, {formatDateTime(item.at)}</p></li>)}
            </ul>
            <div className="grid gap-2 p-5">
              <Field label="Add a comment">{(control) => <Textarea {...control} rows={2} value={comment} onChange={(event) => setComment(event.target.value)} disabled={!canComment} />}</Field>
              <div><Button variant="secondary" loading={addComment.isPending} disabled={!canComment || !comment.trim()} onClick={() => addComment.mutate()}>Add comment</Button></div>
            </div>
          </Panel>
        </div>
        <aside className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6 lg:col-span-2 xl:col-span-1">
          <Panel title="Why this change"><p className="p-5 text-sm">{patch.rationale ?? "No rationale was recorded."}</p></Panel>
          <Panel title="Checks run">
            <ul className="grid gap-2 p-5">{patched.map((check) => <li key={check.id}><Status tone={check.pass ? "success" : "danger"}>{check.name}</Status>{!check.pass && check.detail ? <p className="t-code mt-1 break-words text-muted">{check.detail}</p> : null}</li>)}{patched.length === 0 ? <li className="text-sm text-muted">No checks ran.</li> : null}</ul>
            {baseline.length > 0 ? <div className="border-t border-line-subtle px-5 py-3 text-[13px] text-muted">Unpatched code: {baseline[0]?.detail}</div> : null}
            {patch.previewEvidence?.patched ? <div className="border-t border-line-subtle px-5 py-3 text-[13px] text-muted">Patched code: {patch.previewEvidence.patched.detail}</div> : null}
          </Panel>
          <Panel title="Risk notes"><div className="p-5"><p className="text-sm">Risk level: {patch.riskLevel}</p><ul className="mt-2 grid list-disc gap-1 pl-4 text-sm text-muted">{patch.riskNotes.map((note) => <li key={note}>{note}</li>)}</ul></div></Panel>
          <Panel title="Integrity"><div className="grid gap-2 p-5 text-[13px] text-muted"><p>Base commit <code className="t-code break-all">{patch.baseCommitSha}</code></p><p>SHA-256 <code className="t-code break-all">{patch.sha256}</code></p><p>Check first: <code className="t-code break-all">git apply --check inlet-{patch.id}.patch</code></p></div></Panel>
          {patch.approvals.length > 0 ? <Panel title="Decisions"><ul className="divide-y divide-line-subtle">{patch.approvals.map((item) => <li key={item.id} className="px-5 py-3 text-sm"><p className="font-medium capitalize">{item.decision} by {item.actorName}</p><p className="text-muted">{item.reason}</p></li>)}</ul></Panel> : null}
          {patch.pullRequests.length > 0 ? <Panel title="Pull request"><ul className="p-5">{patch.pullRequests.map((pull) => <li key={pull.url}><a href={pull.url} className="text-sm underline underline-offset-4" rel="noreferrer" target="_blank">#{pull.number} on {pull.branch}</a></li>)}</ul></Panel> : null}
        </aside>
      </div>
      <DecisionDialog key={decision ?? "closed"} patch={patch} decision={decision} onClose={() => setDecision(null)} refresh={refresh} />
    </div>
  );
}

export default function PatchPage() {
  const { patchId } = useParams<{ patchId: string }>();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["patch", patchId], queryFn: () => api<PatchDetail>(`/patches/${patchId}`) });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["patch", patchId] });
    void client.invalidateQueries({ queryKey: ["incident"] });
  };
  return <QueryState query={query}>{(patch) => <PatchBody patch={patch} refresh={refresh} />}</QueryState>;
}
