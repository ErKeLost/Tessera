import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
import { createI18nMiddleware } from "fumadocs-core/i18n/middleware";
import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";
import { i18n } from "./lib/i18n";

const { rewrite: rewriteChineseDocs } = rewritePath("/zh/docs{/*path}", "/zh/llms.mdx/docs{/*path}/content.md");
const { rewrite: rewriteChineseSuffix } = rewritePath("/zh/docs{/*path}.md", "/zh/llms.mdx/docs{/*path}/content.md");
const { rewrite: rewriteEnglishDocs } = rewritePath("/en/docs{/*path}", "/en/llms.mdx/docs{/*path}/content.md");
const { rewrite: rewriteEnglishSuffix } = rewritePath("/en/docs{/*path}.md", "/en/llms.mdx/docs{/*path}/content.md");
const { rewrite: rewriteDefaultDocs } = rewritePath("/docs{/*path}", "/en/llms.mdx/docs{/*path}/content.md");
const { rewrite: rewriteDefaultSuffix } = rewritePath("/docs{/*path}.md", "/en/llms.mdx/docs{/*path}/content.md");
const routeLocale = createI18nMiddleware(i18n);
const defaultLocaleRewriteHeader = "x-tessera-default-locale-rewrite";

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  const suffix = rewriteChineseSuffix(request.nextUrl.pathname)
    ?? rewriteEnglishSuffix(request.nextUrl.pathname)
    ?? rewriteDefaultSuffix(request.nextUrl.pathname);
  if (suffix) return NextResponse.rewrite(new URL(suffix, request.nextUrl));
  if (isMarkdownPreferred(request)) {
    const docs = rewriteChineseDocs(request.nextUrl.pathname)
      ?? rewriteEnglishDocs(request.nextUrl.pathname)
      ?? rewriteDefaultDocs(request.nextUrl.pathname);
    if (docs) return NextResponse.rewrite(new URL(docs, request.nextUrl), { headers: { Vary: "Accept" } });
  }
  if (
    request.headers.get(defaultLocaleRewriteHeader) === i18n.defaultLanguage
    && request.nextUrl.pathname.startsWith(`/${i18n.defaultLanguage}/`)
  ) {
    return NextResponse.next();
  }

  const response = await routeLocale(request, event);
  if (!(response instanceof Response)) return NextResponse.next();
  const rewrite = response.headers.get("x-middleware-rewrite");
  if (rewrite === null) return response;

  const rewriteUrl = new URL(rewrite, request.nextUrl);
  if (!rewriteUrl.pathname.startsWith(`/${i18n.defaultLanguage}/`)) return response;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(defaultLocaleRewriteHeader, i18n.defaultLanguage);
  return NextResponse.rewrite(rewriteUrl, {
    request: { headers: requestHeaders },
  });
}

export const config = {
  matcher: ["/((?!api|background|r|_next/static|_next/image|icon.svg|images|diagrams).*)"],
};
