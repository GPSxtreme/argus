import { renderInstaller } from "@argus/release";
import { installerOptions } from "../../lib/distribution";

export const revalidate = false;

export function GET(): Response {
  return new Response(renderInstaller(installerOptions), {
    headers: {
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      "content-type": "text/x-shellscript; charset=utf-8",
    },
  });
}
