"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { buttonClass, Drawer } from "@inlet/ui";
import { InletLockup } from "@/components/brand";

const NAV = [
  { href: "/#product", label: "Product" },
  { href: "/#how", label: "How it works" },
  { href: "/#agencies", label: "For agencies" },
  { href: "/#faq", label: "FAQ" },
];

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const pathname = usePathname();
  const open = drawerPath === pathname;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`sticky top-0 z-40 border-b transition-colors duration-[180ms] ${scrolled ? "border-line bg-white/92 backdrop-blur" : "border-transparent bg-canvas"}`}>
      <div className="shell flex h-16 items-center justify-between gap-6 lg:h-[72px]">
        <Link href="/" aria-label="Inlet home" className="inline-flex min-h-11 items-center">
          <InletLockup />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-7 lg:flex">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="inline-flex min-h-11 items-center text-sm font-medium text-ink-2 hover:text-ink">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-5 lg:flex">
          <Link href="/login" className="inline-flex min-h-11 items-center text-sm font-medium text-ink-2 hover:text-ink">
            Sign in
          </Link>
          <Link href="/demo" className={buttonClass("primary")}>
            Open the demo
          </Link>
        </div>
        <button type="button" aria-label="Menu" aria-expanded={open} onClick={() => setDrawerPath(pathname)} className="inline-flex size-11 items-center justify-center rounded-button hover:bg-subtle lg:hidden">
          <Menu size={20} aria-hidden />
        </button>
      </div>
      <Drawer open={open} onOpenChange={(next) => setDrawerPath(next ? pathname : null)} title="Site menu">
        <div className="p-5 pt-4">
          <InletLockup />
        </div>
        <nav aria-label="Mobile" className="grid px-3">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} onClick={() => setDrawerPath(null)} className="flex min-h-12 items-center rounded-button px-2 text-[15px] font-medium hover:bg-subtle">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto grid gap-2 p-5">
          <Link href="/login" onClick={() => setDrawerPath(null)} className={buttonClass("secondary")}>
            Sign in
          </Link>
          <Link href="/demo" onClick={() => setDrawerPath(null)} className={buttonClass("primary")}>
            Open the demo
          </Link>
        </div>
      </Drawer>
    </header>
  );
}
