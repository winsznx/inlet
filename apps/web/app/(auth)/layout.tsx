import Link from "next/link";
import type { ReactNode } from "react";
import { InletLockup } from "@/components/brand";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center px-4 py-12 sm:justify-center">
      <div className="w-full max-w-[440px]">
        <Link href="/" aria-label="Inlet home" className="inline-flex min-h-11 items-center">
          <InletLockup />
        </Link>
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
