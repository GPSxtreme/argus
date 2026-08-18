import { notFound } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import { source } from "../../../lib/source";

export const dynamicParams = false;

export function generateStaticParams() {
  return source.generateParams();
}

export default async function DocumentationPage({
  params,
}: Readonly<{ params: Promise<{ slug?: string[] }> }>) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (page === undefined) notFound();

  const Content = page.data.body;
  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <Content components={defaultMdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}
