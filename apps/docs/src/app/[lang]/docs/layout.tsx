import { source } from "@/lib/source";
import { baseOptions } from "@/lib/layout.shared";
import { DocsLayout } from "fumadocs-ui/layouts/docs";

export default async function Layout({ children, params }: LayoutProps<"/[lang]/docs">) {
  const { lang } = await params;
  return <div className="de-docs-shell"><DocsLayout tree={source.getPageTree(lang)} {...baseOptions(lang)}>{children}</DocsLayout></div>;
}
