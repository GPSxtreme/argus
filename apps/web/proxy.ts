import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isMarkdownPreferred } from "fumadocs-core/negotiation";

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/docs/") && isMarkdownPreferred(request)) {
    const target = request.nextUrl.clone();
    target.pathname = `/llms.mdx${pathname}`;
    return NextResponse.rewrite(target, { headers: { Vary: "Accept" } });
  }
  return NextResponse.next({ headers: { Vary: "Accept" } });
}

export const config = { matcher: "/docs/:path*" };
