import { i18nProvider } from "fumadocs-ui/i18n";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { notFound } from "next/navigation";
import "../global.css";
import { isLocale } from "@/lib/i18n";
import { translations } from "@/lib/layout.shared";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export async function generateMetadata({ params }: LayoutProps<"/[lang]">): Promise<Metadata> {
  const { lang } = await params;
  const chinese = lang === "zh";

  return {
    title: { default: "Tessera Agent", template: "%s · Tessera Agent" },
    description: chinese
      ? "通过受治理 Data Agent 工作流证明的终局 Generative UI 架构与组件体系。"
      : "A final Generative UI architecture and component system proven through governed data-agent workflows.",
  };
}

export default async function RootLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const skipLabel = lang === "zh" ? "跳到主要内容" : "Skip to main content";

  return (
    <html className={`${geist.variable} ${mono.variable}`} lang={lang === "zh" ? "zh-CN" : "en"}>
      <body className="flex min-h-screen flex-col">
        <a
          className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:fixed focus:left-3 focus:top-3 focus:not-sr-only focus:ring-2 focus:ring-ring"
          href="#main-content"
        >
          {skipLabel}
        </a>
        <RootProvider theme={{ enabled: false }} i18n={i18nProvider(translations, lang)}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
