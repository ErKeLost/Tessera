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
    themeSwitch: { enabled: true, mode: "light-dark-system" },
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
      { text: chinese ? "Agent 文档" : "Agent docs", url: localizedPath(locale, "/docs/agent"), active: "none" },
      { text: chinese ? "分析视图" : "Analysis views", url: localizedPath(locale, "/docs/components"), active: "none" },
      { text: chinese ? "概念" : "Concepts", url: localizedPath(locale, "/docs/concepts"), active: "none" },
      { text: chinese ? "运行时" : "Runtime", url: localizedPath(locale, "/docs/integrations"), active: "none" },
    ],
  };
}
