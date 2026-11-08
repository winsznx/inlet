"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { ToastProvider, TooltipProvider } from "@inlet/ui";
import { ApiError } from "@/lib/api";

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 3_000,
        refetchOnWindowFocus: true,
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(createClient);
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>{children}</ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
