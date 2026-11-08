"use client";

import { Button } from "@inlet/ui";

export default function ErrorBoundary({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="main" className="flex min-h-[60dvh] flex-col items-start justify-center gap-4 px-6 sm:items-center sm:text-center">
      <h1 className="t-app-title">This page couldn't load.</h1>
      <p className="text-[15px] text-muted">Nothing was changed. Try loading it again.</p>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
