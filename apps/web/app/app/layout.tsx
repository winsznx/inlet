import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app/shell";
import { fetchMe } from "@/lib/server-me";

export const metadata = { title: { default: "Inlet", template: "%s | Inlet" }, robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await fetchMe();
  if (!me) redirect("/login");
  return <AppShell me={me}>{children}</AppShell>;
}
