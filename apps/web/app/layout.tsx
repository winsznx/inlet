import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import "@/styles/globals.css";

const instrument = Instrument_Sans({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-instrument", display: "swap" });
const plex = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  title: { default: "Inlet: know your enquiries arrived", template: "%s | Inlet" },
  description: "Inlet tests your website's enquiry forms, checks whether each test reaches the right inbox, and helps your developer fix failures in the code.",
  icons: { icon: [{ url: "/favicon.svg", type: "image/svg+xml" }, { url: "/favicon-32.png", sizes: "32x32" }], apple: "/icon-512.png" },
  openGraph: { title: "Inlet", description: "Know your enquiries arrived.", images: ["/og-cover.png"] },
};

export const viewport: Viewport = { themeColor: "#FFFFFF", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${instrument.variable} ${plex.variable} ${plexMono.variable}`}>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[70] focus:rounded-button focus:bg-ink focus:px-4 focus:py-2 focus:text-white">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
