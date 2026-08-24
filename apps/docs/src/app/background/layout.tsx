import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import "../global.css";

export const metadata: Metadata = {
  title: "Tessera Agent",
  description: "Tessera Agent workspace.",
  robots: { index: false, follow: false },
};

export default function BackgroundLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
