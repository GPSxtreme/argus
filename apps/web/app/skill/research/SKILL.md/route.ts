import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { researchSkillRoot } from "../../../../lib/distribution";

export const revalidate = false;

export async function GET(): Promise<Response> {
  return new Response(await readFile(join(researchSkillRoot, "SKILL.md")), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "text/markdown; charset=utf-8",
    },
  });
}
