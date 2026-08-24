import { source } from "@/lib/source";
import { baseOptions } from "@/lib/layout.shared";
import { DocsLayout } from "fumadocs-ui/layouts/docs";

export default async function Layout({ children, params }: LayoutProps<"/[lang]/docs">) {
  const { lang } = await params;
  return (
    <DocsLayout
      {...baseOptions(lang)}
      containerProps={{ className: "de-docs-shell" }}
      sidebar={{ enabled: true }}
      tabs={false}
      tree={source.getPageTree(lang)}
    >
      {children}
    </DocsLayout>
  );
}
