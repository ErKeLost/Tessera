import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";
import "@data-elements/react/styles.css";
import "../global.css";
import { TooltipProvider } from "@/components/ui/tooltip";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "Artifact Playground",
  description: "Artifact UI streaming demo.",
  robots: { index: false, follow: false },
};

export default function BackgroundLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html className={`${geist.variable} ${mono.variable}`} lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <TooltipProvider><RootProvider theme={{ defaultTheme: "light", enableSystem: false }}>{children}</RootProvider></TooltipProvider>
      </body>
    </html>
  );
}
