import Link from "next/link";
import { InletLockup } from "@/components/brand";

const LINKS = [
  { href: "/#product", label: "Product" },
  { href: "/#how", label: "How it works" },
  { href: "/demo", label: "Live example" },
  { href: "/docs", label: "Docs" },
  { href: "/status", label: "Status" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="shell flex flex-col gap-6 py-10 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <InletLockup />
          <p className="mt-3 max-w-[46ch] text-sm text-muted">Inlet tests enquiry forms, checks delivery at the destination, and prepares tested code fixes for developer approval.</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-1">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="inline-flex min-h-11 items-center text-sm text-ink-2 hover:text-ink">
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
