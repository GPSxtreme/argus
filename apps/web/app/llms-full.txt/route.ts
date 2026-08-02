import { getLLMText } from "../../lib/get-llm-text";
import { site } from "../../lib/site";
import { source } from "../../lib/source";

export const revalidate = false;

export async function GET(): Promise<Response> {
  const pages = (await Promise.all(source.getPages().map(getLLMText))).join("\n\n");
  return new Response(`# ${site.name}\n\n${pages}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
