"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Checkbox, EmptyState, Field, Input, Panel, Status, useToast } from "@inlet/ui";
import { PageHeader, QueryState, useCan } from "@/components/app/common";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

type Preferences = { email: string | null; notifyFailure: boolean; notifyRecovery: boolean; notifyActionRequired: boolean; notifyConnectionExpired: boolean; dailyDigest: boolean; dedupWindowMinutes: number; quietHoursStart: number | null; quietHoursEnd: number | null };
type History = { id: string; kind: string; recipient: string; subject: string; deliveryStatus: string; groupedCount: number; createdAt: string; errorCode: string | null };

const DEFAULTS: Preferences = { email: null, notifyFailure: true, notifyRecovery: true, notifyActionRequired: true, notifyConnectionExpired: true, dailyDigest: false, dedupWindowMinutes: 360, quietHoursStart: null, quietHoursEnd: null };
const TONE: Record<string, "success" | "danger" | "neutral"> = { sent: "success", failed: "danger", suppressed: "neutral", pending: "neutral" };

function PreferencesForm({ initial, defaultEmail }: { initial: Preferences; defaultEmail: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const canEdit = useCan("site:edit");
  const [state, setState] = useState(initial);
  const set = (patch: Partial<Preferences>) => setState((current) => ({ ...current, ...patch }));
  const save = useMutation({ mutationFn: () => api("/notifications/preferences", { method: "PATCH", body: { ...state, email: state.email || null } }), onSuccess: () => { toast("Notification settings saved."); void client.invalidateQueries({ queryKey: ["notification-preferences"] }); }, onError: (error) => toast(errorMessage(error), "danger") });
  const test = useMutation({ mutationFn: () => api("/notifications/test", { body: {} }), onSuccess: () => { toast("Test notification queued."); setTimeout(() => void client.invalidateQueries({ queryKey: ["notifications"] }), 1500); }, onError: (error) => toast(errorMessage(error), "danger") });
  const hour = (value: string) => (value === "" ? null : Number(value));
  return (
    <div className="grid gap-4 p-5">
      <Field label="Send alerts to" help={`Leave blank to use ${defaultEmail}.`}>{(control) => <Input {...control} type="email" value={state.email ?? ""} onChange={(event) => set({ email: event.target.value })} placeholder={defaultEmail} />}</Field>
      <div className="grid sm:grid-cols-2">
        <Checkbox label="First confirmed failure" checked={state.notifyFailure} onChange={(event) => set({ notifyFailure: event.target.checked })} />
        <Checkbox label="Recovery" checked={state.notifyRecovery} onChange={(event) => set({ notifyRecovery: event.target.checked })} />
        <Checkbox label="Action required" checked={state.notifyActionRequired} onChange={(event) => set({ notifyActionRequired: event.target.checked })} />
        <Checkbox label="Connection expired" checked={state.notifyConnectionExpired} onChange={(event) => set({ notifyConnectionExpired: event.target.checked })} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Group repeats for (minutes)">{(control) => <Input {...control} type="number" min={15} value={state.dedupWindowMinutes} onChange={(event) => set({ dedupWindowMinutes: Number(event.target.value) })} />}</Field>
        <Field label="Quiet hours start (UTC hour)">{(control) => <Input {...control} type="number" min={0} max={23} value={state.quietHoursStart ?? ""} onChange={(event) => set({ quietHoursStart: hour(event.target.value) })} />}</Field>
        <Field label="Quiet hours end (UTC hour)">{(control) => <Input {...control} type="number" min={0} max={23} value={state.quietHoursEnd ?? ""} onChange={(event) => set({ quietHoursEnd: hour(event.target.value) })} />}</Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button loading={save.isPending} disabled={!canEdit} onClick={() => save.mutate()}>Save settings</Button>
        <Button variant="secondary" loading={test.isPending} disabled={!canEdit} onClick={() => test.mutate()}>Send test notification</Button>
      </div>
    </div>
  );
}

export default function NotificationsPage() {
  const preferences = useQuery({ queryKey: ["notification-preferences"], queryFn: () => api<{ defaultEmail: string; preferences: Preferences | null }>("/notifications/preferences") });
  const history = useQuery({ queryKey: ["notifications"], queryFn: () => api<{ notifications: History[] }>("/notifications") });
  return (
    <div className="grid max-w-[900px] grid-cols-[minmax(0,1fr)] gap-6">
      <PageHeader title="Notifications" subtitle="Inlet emails you when delivery changes, not after every successful check." />
      <Panel title="Alert settings"><QueryState query={preferences}>{(data) => <PreferencesForm initial={data.preferences ?? DEFAULTS} defaultEmail={data.defaultEmail} />}</QueryState></Panel>
      <Panel title="History">
        <QueryState query={history}>
          {(data) => data.notifications.length === 0 ? <EmptyState title="No notifications sent">Alerts will be listed here.</EmptyState> : (
            <ul className="divide-y divide-line-subtle">
              {data.notifications.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <div className="min-w-0"><p className="text-sm font-medium">{item.subject}</p><p className="text-[13px] text-muted">{item.recipient}, {formatDateTime(item.createdAt)}{item.groupedCount > 1 ? `, ${item.groupedCount} grouped` : ""}{item.errorCode ? `, ${item.errorCode}` : ""}</p></div>
                  <Status tone={TONE[item.deliveryStatus] ?? "neutral"}>{item.deliveryStatus[0]?.toUpperCase()}{item.deliveryStatus.slice(1)}</Status>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}
