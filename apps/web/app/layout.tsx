import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./global.css";
import { site } from "../lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: "Argus", template: "%s · Argus" },
  description: site.description,
  alternates: { canonical: "/" },
  openGraph: {
    title: "Argus",
    description: site.description,
    url: site.url,
    siteName: site.name,
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Argus",
    description: site.description,
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies stored/system theme before paint; shares the `theme` key with fumadocs next-themes. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script, no user input
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}document.documentElement.classList.add(t);}catch(e){document.documentElement.classList.add("dark");}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
