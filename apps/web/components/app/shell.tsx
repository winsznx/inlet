"use client";

import { Activity, AlertTriangle, Bell, BookOpen, FlaskConical, Globe, ListChecks, Menu, PlugZap, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { cx, Drawer, Tooltip } from "@inlet/ui";
import { InletLockup, InletSymbol } from "@/components/brand";
import { api } from "@/lib/api";
import type { Me } from "@/lib/types";
import { MeProvider } from "./common";

const PRIMARY = [
  { href: "/app/sites", label: "Sites", icon: Globe },
  { href: "/app/runs", label: "Runs", icon: ListChecks },
  { href: "/app/incidents", label: "Incidents", icon: AlertTriangle },
  { href: "/app/connections", label: "Connections", icon: PlugZap },
];
const SECONDARY = [
  { href: "/app/activity", label: "Activity", icon: Activity },
  { href: "/app/settings", label: "Settings", icon: Settings },
];

function NavLink({ item, compact, pathname, onNavigate }: { item: (typeof PRIMARY)[number]; compact: boolean; pathname: string; onNavigate?: () => void }) {
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const link = (
    <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} aria-label={compact ? item.label : undefined} className={cx("flex min-h-11 items-center gap-3 rounded-button text-sm font-medium", compact ? "justify-center" : "px-3", active ? "bg-subtle text-ink" : "text-ink-2 hover:bg-subtle")}>
      <item.icon size={18} aria-hidden className={active ? "text-copper" : undefined} />
      {compact ? null : item.label}
    </Link>
  );
  return compact ? <Tooltip label={item.label}>{link}</Tooltip> : link;
}

function NavContent({ me, compact, pathname, onNavigate }: { me: Me; compact: boolean; pathname: string; onNavigate?: () => void }) {
  const router = useRouter();
  const showLab = me.permissions.includes("policy:view");
  return (
    <div className="flex min-h-full flex-1 flex-col p-3">
      <Link href="/app/sites" onClick={onNavigate} aria-label="Inlet sites" className={cx("flex h-12 items-center", compact ? "justify-center" : "px-2")}>
        {compact ? <InletSymbol size={26} /> : <InletLockup />}
      </Link>
      {!compact && me.organizations.length > 0 ? (
        <div className="mt-2 px-1">
          <label htmlFor="workspace" className="sr-only">Workspace</label>
          <select
            id="workspace"
            value={me.activeOrganizationId ?? ""}
            onChange={async (event) => {
              if (event.target.value === "__new") {
                onNavigate?.();
                router.push("/app/welcome?new=1");
                return;
              }
              await api("/me/active-organization", { body: { organizationId: event.target.value } });
              window.location.assign("/app/sites");
            }}
            className="min-h-11 w-full rounded-input border border-line bg-canvas px-2.5 text-sm font-medium"
          >
            {me.organizations.map((org) => (
              <option key={org.id} value={org.id}>{org.name}</option>
            ))}
            <option value="__new">Create workspace</option>
          </select>
        </div>
      ) : null}
      <nav aria-label="Workspace" className="mt-4 grid gap-0.5">
        {PRIMARY.map((item) => <NavLink key={item.href} item={item} compact={compact} pathname={pathname} onNavigate={onNavigate} />)}
        <hr className="my-2 border-line-subtle" />
        {SECONDARY.map((item) => <NavLink key={item.href} item={item} compact={compact} pathname={pathname} onNavigate={onNavigate} />)}
        {showLab ? <NavLink item={{ href: "/app/sandbox-lab", label: "Sandbox lab", icon: FlaskConical }} compact={compact} pathname={pathname} onNavigate={onNavigate} /> : null}
      </nav>
      <div className="mt-auto pt-4">
        <NavLink item={{ href: "/docs", label: "Documentation", icon: BookOpen }} compact={compact} pathname={pathname} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

const BREADCRUMB_NAMES: Record<string, string> = { app: "", sites: "Sites", new: "Add a website", configure: "Configuration", runs: "Runs", incidents: "Incidents", patches: "Patch", connections: "Connections", notifications: "Notifications", settings: "Settings", activity: "Activity", "sandbox-lab": "Sandbox lab", welcome: "Workspace" };

function Breadcrumb({ pathname }: { pathname: string }) {
  const segments = pathname.split("/").filter(Boolean).slice(1);
  let href = "/app";
  const crumbs = segments.map((segment) => {
    href += `/${segment}`;
    return { href, label: BREADCRUMB_NAMES[segment] ?? `…${segment.slice(-6)}` };
  });
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 truncate text-sm text-muted">
        {crumbs.map((crumb, index) => (
          <li key={crumb.href} className="flex items-center gap-1.5">
            {index > 0 ? <span aria-hidden>/</span> : null}
            {index === crumbs.length - 1 ? <span aria-current="page" className="font-medium text-ink">{crumb.label}</span> : <Link href={crumb.href} className="inline-flex min-h-11 items-center hover:text-ink">{crumb.label}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function AccountMenu({ me }: { me: Me }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label="Account menu" className="inline-flex size-11 items-center justify-center rounded-full">
        <span className="flex size-8 items-center justify-center rounded-full bg-ink text-[13px] font-semibold text-white">{me.user.name.slice(0, 1).toUpperCase()}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-56 rounded-panel border border-line bg-raised p-1 shadow-elevated">
          <div className="px-3 py-2">
            <p className="text-sm font-medium">{me.user.name}</p>
            <p className="text-[13px] text-muted">{me.user.email}</p>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-line-subtle" />
          <DropdownMenu.Item asChild><Link href="/app/settings" className="flex min-h-11 items-center rounded-status px-3 text-sm outline-none data-[highlighted]:bg-subtle">Settings</Link></DropdownMenu.Item>
          <DropdownMenu.Item
            className="flex min-h-11 cursor-pointer items-center rounded-status px-3 text-sm outline-none data-[highlighted]:bg-subtle"
            onSelect={async () => {
              await api("/auth/logout", { body: {} });
              window.location.assign("/login");
            }}
          >
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const pathname = usePathname();
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const open = drawerPath === pathname;
  return (
    <MeProvider value={me}>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col overflow-y-auto border-r border-line xl:flex">
          <NavContent me={me} compact={false} pathname={pathname} />
        </aside>
        <aside className="sticky top-0 hidden h-dvh w-[72px] shrink-0 flex-col border-r border-line lg:flex xl:hidden">
          <NavContent me={me} compact pathname={pathname} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-line bg-canvas px-2 lg:h-16 lg:px-8">
            <div className="flex min-w-0 items-center gap-1">
              <button type="button" aria-label="Open navigation" aria-expanded={open} onClick={() => setDrawerPath(pathname)} className="inline-flex size-11 shrink-0 items-center justify-center rounded-button hover:bg-subtle lg:hidden">
                <Menu size={20} aria-hidden />
              </button>
              <Breadcrumb pathname={pathname} />
            </div>
            <div className="flex shrink-0 items-center">
              <Tooltip label="Notifications" side="bottom">
                <Link href="/app/notifications" aria-label="Notifications" className="inline-flex size-11 items-center justify-center rounded-button text-ink-2 hover:bg-subtle">
                  <Bell size={18} aria-hidden />
                </Link>
              </Tooltip>
              <AccountMenu me={me} />
            </div>
          </header>
          <main id="main" className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 md:px-6 lg:px-8 lg:py-8">
            {children}
          </main>
        </div>
      </div>
      <Drawer open={open} onOpenChange={(next) => setDrawerPath(next ? pathname : null)} title="Navigation">
        <NavContent me={me} compact={false} pathname={pathname} onNavigate={() => setDrawerPath(null)} />
      </Drawer>
    </MeProvider>
  );
}
