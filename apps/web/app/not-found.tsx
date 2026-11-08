import Link from "next/link";
import { buttonClass } from "@inlet/ui/classes";
import { InletLockup } from "@/components/brand";

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-start justify-center gap-5 px-6 sm:items-center sm:text-center">
      <InletLockup />
      <h1 className="t-app-title">That page doesn't exist.</h1>
      <p className="text-[15px] text-muted">Check the address, or go back to the start.</p>
      <Link href="/" className={buttonClass("primary")}>Go to the home page</Link>
    </main>
  );
}
