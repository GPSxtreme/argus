import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./global.css";
import { site } from "../lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: "Argus", template: "%s · Argus" },
  description: site.description,
  alternates: { canonical: "/" },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
