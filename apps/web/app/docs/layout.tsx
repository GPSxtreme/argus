import type { ReactNode } from "react";
import "fumadocs-ui/style.css";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "../../lib/source";

export default function DocumentationLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: "Argus", url: "/" }}
      sidebar={{ defaultOpenLevel: 1 }}
    >
      {children}
    </DocsLayout>
  );
}
