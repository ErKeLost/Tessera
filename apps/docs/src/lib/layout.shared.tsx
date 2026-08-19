import { zhCN } from "@fumadocs/language/zh-cn";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { uiTranslations } from "fumadocs-ui/i18n";
import { ArtifactAgentLogo } from "@/components/artifact-agent-logo";
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
    nav: {
      title: (
        <span className="de-brand-lockup">
          <ArtifactAgentLogo className="de-brand-logo" />
          <span>{appName}</span>
        </span>
      ),
      url: localizedPath(locale, "/"),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      { text: chinese ? "文档" : "Docs", url: localizedPath(locale, "/docs"), active: "nested-url" },
      { text: chinese ? "组件" : "Components", url: localizedPath(locale, "/docs/components"), active: "nested-url" },
      { text: chinese ? "示例" : "Examples", url: localizedPath(locale, "/docs/examples"), active: "nested-url" },
      { text: "Playground", url: "/background" },
    ],
  };
}
