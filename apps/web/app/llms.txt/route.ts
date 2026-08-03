import { llms } from "fumadocs-core/source";
import { absoluteUrl, site } from "../../lib/site";
import { source } from "../../lib/source";

export const revalidate = false;

export function GET(): Response {
  const index = llms(source).index().replaceAll(/\]\((\/docs[^)]*)\)/gu, (_, url: string) => {
    return `](${absoluteUrl(url)})`;
  });
  const body = `# ${site.name}\n\n> ${site.description}\n\n${index}\n`;
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
