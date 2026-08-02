import { getLLMText } from "../../../../lib/get-llm-text";
import { source } from "../../../../lib/source";

export const revalidate = false;

export async function GET(
  _request: Request,
  { params }: Readonly<{ params: Promise<{ slug?: string[] }> }>,
): Promise<Response> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (page === undefined) return new Response("Not found", { status: 404 });

  return new Response(await getLLMText(page), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      vary: "Accept",
    },
  });
}
