"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button, Notice, Skeleton, Status } from "@inlet/ui";
import type { RunResult, RunState } from "@inlet/domain/states";
import { ApiError, errorMessage } from "@/lib/api";
import { resultLabel, resultTone } from "@/lib/format";
import type { Me, Permission } from "@/lib/types";

const MeContext = createContext<Me | null>(null);

export const MeProvider = MeContext.Provider;

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe needs an authenticated layout");
  return me;
}

export function useCan(permission: Permission): boolean {
  return useMe().permissions.includes(permission);
}

export const NO_ROLE_REASON = "Your role doesn't allow this. Ask a workspace owner or admin.";

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <h1 className="t-app-title break-words">{title}</h1>
        {subtitle ? <p className="mt-1.5 max-w-[72ch] text-[15px] text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function PageSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6" role="status" aria-label="Loading">
      <Skeleton className="h-9 w-72 max-w-full" />
      <Skeleton className="h-5 w-[28rem] max-w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function QueryState<T>({ query, children, loading }: { query: UseQueryResult<T>; children: (data: T) => ReactNode; loading?: ReactNode }) {
  if (query.isPending) return loading ?? <PageSkeleton />;
  if (query.isError) {
    const error = query.error;
    if (error instanceof ApiError && error.status === 404) return <Notice title="Not found">This item doesn't exist, or it belongs to another workspace.</Notice>;
    if (error instanceof ApiError && error.status === 403) return <Notice tone="warning" title="You don't have access">{error.message}</Notice>;
    return (
      <Notice tone="danger" title="This couldn't load" action={<Button variant="secondary" onClick={() => void query.refetch()}>Try again</Button>}>
        {errorMessage(error)}
      </Notice>
    );
  }
  return (
    <>
      {query.isRefetchError ? <div className="mb-4"><Notice tone="warning">Showing the last data received. Inlet can't be reached right now.</Notice></div> : null}
      {children(query.data)}
    </>
  );
}

export function RunResultStatus({ result, state }: { result: RunResult | null | undefined; state?: RunState }) {
  if (!result && state && state !== "cleanup_complete") return <Status tone="running">Running</Status>;
  return <Status tone={resultTone(result)}>{resultLabel(result, state)}</Status>;
}

export function Table({ children, label, minWidth = 720 }: { children: ReactNode; label: string; minWidth?: number }) {
  return (
    <div className="overflow-x-auto" role="region" aria-label={label} tabIndex={0}>
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export const TH = "sticky top-0 border-b border-line bg-canvas px-4 py-3 text-left text-[13px] font-medium text-muted whitespace-nowrap";
export const TD = "border-b border-line-subtle px-4 py-3.5 align-middle";
