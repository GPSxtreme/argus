import { buildSkillArchive } from "@argus/release";
import { researchSkillRoot } from "../../../lib/distribution";

export const revalidate = false;

export async function GET(): Promise<Response> {
  const archive = await buildSkillArchive(researchSkillRoot);
  const body = Uint8Array.from(archive.bytes).buffer;
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=300",
      "content-disposition": 'attachment; filename="argus-research.zip"',
      "content-type": "application/zip",
    },
  });
}
