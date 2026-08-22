import { zhCN } from "@fumadocs/language/zh-cn";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { uiTranslations } from "fumadocs-ui/i18n";
import { TesseraAgentLogo } from "@/components/tessera-agent-logo";
import { i18n, localizedPath } from "./i18n";
import { appName, gitConfig } from "./shared";

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .preset("zh", zhCN())
  .add({
    en: { displayName: "English" },
  });

export function baseOptions(locale: string): BaseLayoutProps {
  const chinese = locale === "zh";

  return {
    themeSwitch: { enabled: false },
    nav: {
      title: (
        <span className="tessera-brand-lockup">
          <TesseraAgentLogo className="tessera-brand-logo" />
          <span>{appName}</span>
        </span>
      ),
      url: localizedPath(locale, "/"),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      { text: chinese ? "文档" : "Docs", url: localizedPath(locale, "/docs"), active: "none" },
      { text: "Agent", url: localizedPath(locale, "/docs/agent"), active: "none" },
      { text: chinese ? "组件" : "Components", url: localizedPath(locale, "/docs/components"), active: "none" },
      { text: "Playground", url: "/background", active: "none" },
    ],
  };
}
