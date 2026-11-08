import type { ReactNode } from "react";
import "./site.css";

export const metadata = { title: "Acme Demo", description: "A controlled test website used by Inlet." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
