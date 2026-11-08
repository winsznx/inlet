import { cookies } from "next/headers";
import type { Me } from "./types";

export async function fetchMe(): Promise<Me | null> {
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader.includes("inlet_session")) return null;
  const response = await fetch(`${process.env.API_BASE_URL ?? "http://localhost:4000"}/api/v1/me`, { headers: { cookie: cookieHeader }, cache: "no-store" }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json()) as Me;
}
