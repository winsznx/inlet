"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Checkbox, Dialog, Field, Input, Panel, Select, useToast } from "@inlet/ui";
import { buttonClass } from "@inlet/ui/classes";
import { PageHeader, QueryState, useCan, useMe } from "@/components/app/common";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

type Org = { id: string; name: string; timezone: string; retentionDays: number; maintainersMayApprove: boolean; role: string };
type Members = { members: { id: string; role: string; name: string; email: string; userId: string }[]; invitations: { id: string; email: string; role: string; expiresAt: string }[] };
type Sessions = { sessions: { id: string; userAgent: string | null; lastSeenAt: string; current: boolean }[] };

function WorkspaceForm({ org }: { org: Org }) {
  const toast = useToast();
  const client = useQueryClient();
  const canManage = useCan("member:manage");
  const [name, setName] = useState(org.name);
  const [timezone, setTimezone] = useState(org.timezone);
  const [retention, setRetention] = useState(org.retentionDays);
  const [maintainers, setMaintainers] = useState(org.maintainersMayApprove);
  const save = useMutation({ mutationFn: () => api(`/organizations/${org.id}`, { method: "PATCH", body: { name, timezone, retentionDays: retention, maintainersMayApprove: maintainers } }), onSuccess: () => { toast("Workspace saved."); void client.invalidateQueries({ queryKey: ["org"] }); }, onError: (error) => toast(errorMessage(error), "danger") });
  return (
    <div className="grid gap-4 p-5">
      <Field label="Workspace name">{(control) => <Input {...control} value={name} disabled={!canManage} onChange={(event) => setName(event.target.value)} />}</Field>
      <Field label="Timezone">{(control) => <Input {...control} value={timezone} disabled={!canManage} onChange={(event) => setTimezone(event.target.value)} />}</Field>
      <Field label="Keep evidence for" help="Screenshots and logs are deleted after this period.">{(control) => <Select {...control} value={retention} disabled={!canManage} onChange={(event) => setRetention(Number(event.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></Select>}</Field>
      <Checkbox label="Maintainers can approve or reject patches" checked={maintainers} disabled={!canManage} onChange={(event) => setMaintainers(event.target.checked)} />
      <div><Button loading={save.isPending} disabled={!canManage} onClick={() => save.mutate()}>Save workspace</Button></div>
    </div>
  );
}

function MembersPanel({ org }: { org: Org }) {
  const client = useQueryClient();
  const toast = useToast();
  const canManage = useCan("member:manage");
  const query = useQuery({ queryKey: ["members", org.id], queryFn: () => api<Members>(`/organizations/${org.id}/members`) });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("maintainer");
  const refresh = () => void client.invalidateQueries({ queryKey: ["members", org.id] });
  const invite = useMutation({ mutationFn: () => api<{ emailSent: boolean }>(`/organizations/${org.id}/invitations`, { body: { email, role } }), onSuccess: ({ emailSent }) => { setEmail(""); toast(emailSent ? "Invitation sent." : "The invitation was created, but its email couldn't be sent. Check the mail settings, then revoke and invite again.", emailSent ? "success" : "danger"); refresh(); }, onError: (error) => toast(errorMessage(error), "danger") });
  const remove = useMutation({ mutationFn: (id: string) => api(`/members/${id}`, { method: "DELETE" }), onSuccess: refresh, onError: (error) => toast(errorMessage(error), "danger") });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/invitations/${id}`, { method: "DELETE" }), onSuccess: refresh, onError: (error) => toast(errorMessage(error), "danger") });
  const change = useMutation({ mutationFn: ({ id, value }: { id: string; value: string }) => api(`/members/${id}`, { method: "PATCH", body: { role: value } }), onSuccess: refresh, onError: (error) => toast(errorMessage(error), "danger") });
  return (
    <QueryState query={query}>
      {(data) => (
        <>
          <ul className="divide-y divide-line-subtle">
            {data.members.map((member) => (
              <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0"><p className="text-sm font-medium">{member.name}</p><p className="break-all text-[13px] text-muted">{member.email}</p></div>
                {member.role === "owner" ? <span className="text-sm text-muted">Owner</span> : (
                  <div className="flex items-center gap-2">
                    <label className="sr-only" htmlFor={`role-${member.id}`}>Role for {member.name}</label>
                    <Select id={`role-${member.id}`} className="w-36" value={member.role} disabled={!canManage} onChange={(event) => change.mutate({ id: member.id, value: event.target.value })}><option value="admin">Admin</option><option value="maintainer">Maintainer</option><option value="viewer">Viewer</option></Select>
                    <Button variant="secondary" disabled={!canManage} onClick={() => { if (window.confirm(`Remove ${member.name} from this workspace?`)) remove.mutate(member.id); }}>Remove</Button>
                  </div>
                )}
              </li>
            ))}
            {data.invitations.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0"><p className="break-all text-sm font-medium">{item.email}</p><p className="text-[13px] text-muted">Invited as {item.role}. Expires {formatDateTime(item.expiresAt)}</p></div>
                <Button variant="secondary" disabled={!canManage} onClick={() => revoke.mutate(item.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
          {canManage ? (
            <form className="grid gap-3 border-t border-line-subtle p-5 sm:grid-cols-[minmax(0,1fr)_160px_auto] sm:items-end" onSubmit={(event) => { event.preventDefault(); invite.mutate(); }}>
              <Field label="Invite by email">{(control) => <Input {...control} type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />}</Field>
              <Field label="Role">{(control) => <Select {...control} value={role} onChange={(event) => setRole(event.target.value)}><option value="admin">Admin</option><option value="maintainer">Maintainer</option><option value="viewer">Viewer</option></Select>}</Field>
              <Button type="submit" variant="secondary" loading={invite.isPending}>Send invitation</Button>
            </form>
          ) : null}
        </>
      )}
    </QueryState>
  );
}

function SessionsPanel() {
  const client = useQueryClient();
  const toast = useToast();
  const query = useQuery({ queryKey: ["sessions"], queryFn: () => api<Sessions>("/me/sessions") });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/me/sessions/${id}`, { method: "DELETE" }), onSuccess: () => void client.invalidateQueries({ queryKey: ["sessions"] }), onError: (error) => toast(errorMessage(error), "danger") });
  return (
    <QueryState query={query}>
      {(data) => (
        <ul className="divide-y divide-line-subtle">
          {data.sessions.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0 flex-1 basis-60"><p className="truncate text-sm">{session.userAgent ?? "Unknown device"}</p><p className="text-[13px] text-muted">{session.current ? "This device" : `Last seen ${formatDateTime(session.lastSeenAt)}`}</p></div>
              {session.current ? null : <Button variant="secondary" loading={revoke.isPending} onClick={() => revoke.mutate(session.id)}>Sign out</Button>}
            </li>
          ))}
        </ul>
      )}
    </QueryState>
  );
}

function DangerZone({ org }: { org: Org }) {
  const toast = useToast();
  const canDelete = useCan("workspace:delete");
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const remove = useMutation({ mutationFn: () => api(`/organizations/${org.id}`, { method: "DELETE", body: { confirmName, confirmPhrase } }), onSuccess: () => window.location.assign("/app"), onError: (error) => toast(errorMessage(error), "danger") });
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-5">
      <p className="max-w-[56ch] text-sm text-muted">Permanently removes this workspace, its evidence and its stored credentials.</p>
      <Button variant="danger" disabled={!canDelete} title={canDelete ? undefined : "Only the workspace owner can do this."} onClick={() => setOpen(true)}>Delete workspace</Button>
      <Dialog open={open} onOpenChange={setOpen} title="Delete this workspace" description="This can't be undone." footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" loading={remove.isPending} disabled={confirmName !== org.name || confirmPhrase !== "delete this workspace"} onClick={() => remove.mutate()}>Delete workspace</Button></>}>
        <Field label={`Type the workspace name: ${org.name}`}>{(control) => <Input {...control} value={confirmName} onChange={(event) => setConfirmName(event.target.value)} />}</Field>
        <Field label="Type: delete this workspace">{(control) => <Input {...control} value={confirmPhrase} onChange={(event) => setConfirmPhrase(event.target.value)} />}</Field>
      </Dialog>
    </div>
  );
}

export default function SettingsPage() {
  const me = useMe();
  const org = useQuery({ queryKey: ["org", me.activeOrganizationId], enabled: Boolean(me.activeOrganizationId), queryFn: () => api<Org>(`/organizations/${me.activeOrganizationId}`) });
  return (
    <div className="grid max-w-[900px] grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader title="Settings" subtitle="Workspace, members, security and retention." />
      <QueryState query={org}>
        {(data) => (
          <>
            <Panel title="Workspace"><WorkspaceForm key={data.id} org={data} /></Panel>
            <Panel title="Members"><MembersPanel org={data} /></Panel>
            <Panel title="Active sessions"><SessionsPanel /></Panel>
            <Panel title="Data export"><div className="flex flex-wrap items-center justify-between gap-3 p-5"><p className="text-sm text-muted">Download sites, checks, incidents, patches and audit history as JSON.</p><a href={`/api/v1/organizations/${data.id}/export`} className={buttonClass("secondary")}>Export data</a></div></Panel>
            <Panel title="Delete workspace"><DangerZone org={data} /></Panel>
          </>
        )}
      </QueryState>
    </div>
  );
}
