import { i18nProvider } from "fumadocs-ui/i18n";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import "../global.css";
import { isLocale } from "@/lib/i18n";
import { translations } from "@/lib/layout.shared";

export async function generateMetadata({ params }: LayoutProps<"/[lang]">): Promise<Metadata> {
  const { lang } = await params;
  const chinese = lang === "zh";

  return {
    title: { default: "Tessera Agent docs", template: "%s · Tessera Agent" },
    description: chinese
      ? "受治理 Tessera Data Agent 的使用、配置、工具契约与生产运行文档。"
      : "Usage, configuration, tool contracts, and production guidance for the governed Tessera data agent.",
  };
}

export default async function RootLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const skipLabel = lang === "zh" ? "跳到主要内容" : "Skip to main content";

  return (
    <html
      data-scroll-behavior="smooth"
      lang={lang === "zh" ? "zh-CN" : "en"}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <a
          className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:fixed focus:left-3 focus:top-3 focus:not-sr-only focus:ring-2 focus:ring-ring"
          href="#main-content"
        >
          {skipLabel}
        </a>
        <RootProvider
          i18n={i18nProvider(translations, lang)}
          theme={{ attribute: "class", defaultTheme: "system", enableSystem: true }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
