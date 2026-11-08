import { redirect } from "next/navigation";
import { fetchMe } from "@/lib/server-me";

export default async function AppIndex() {
  const me = await fetchMe();
  redirect(me?.activeOrganizationId ? "/app/sites" : "/app/welcome");
}
