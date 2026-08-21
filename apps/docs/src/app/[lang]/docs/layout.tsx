import { source } from "@/lib/source";
import { baseOptions } from "@/lib/layout.shared";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { HomeLayout } from "fumadocs-ui/layouts/home";

export default async function Layout({ children, params }: LayoutProps<"/[lang]/docs">) {
  const { lang } = await params;
  const options = baseOptions(lang);
  return (
    <HomeLayout {...options}>
      <div className="de-docs-shell">
        <DocsLayout {...options} links={[]} nav={{ enabled: false }} tree={source.getPageTree(lang)}>
          {children}
        </DocsLayout>
      </div>
    </HomeLayout>
  );
}
