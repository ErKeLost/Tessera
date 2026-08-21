import githubIcon from "@iconify-icons/simple-icons/github";
import { Icon } from "@iconify/react/offline";
import {
  ArrowRightIcon,
  BlocksIcon,
  BracesIcon,
  CheckIcon,
  DatabaseIcon,
  FileJson2Icon,
  GitBranchIcon,
  PackageIcon,
  ShieldCheckIcon,
} from "lucide-react";
import Link from "next/link";
import { ComponentCanvas } from "@/app/(home)/component-canvas";
import { HeroBackdrop, type PanelImageKey } from "@/app/(home)/hero-backdrop";
import { InstallCopy } from "@/app/(home)/install-copy";
import styles from "@/app/(home)/home.module.css";
import { localizedPath } from "@/lib/i18n";

const protocolIcons = [GitBranchIcon, FileJson2Icon, BlocksIcon, DatabaseIcon] as const;

const packageNames = [
  "@data-elements/schema",
  "@data-elements/core",
  "@data-elements/react",
  "@data-elements/ai-sdk",
  "@data-elements/mastra",
] as const;

function CanvasPanelBackdrop({ imageKey }: { imageKey: PanelImageKey }) {
  return (
    <div className={styles.sectionBackdrop}>
      <HeroBackdrop imageKey={imageKey} variant="panel" />
    </div>
  );
}

const copy = {
  en: {
    eyebrow: "Open-source platform for building agents",
    lead: "A local-first agent platform for data analysis, management, and operations, with multi-database support and extensible tools.",
    getStarted: "Get started",
    browse: "Browse components",
    interactivePreview: "Interactive workspace",
    workspace: "Working interface",
    workspaceTitle: "See the interface after a model responds.",
    workspaceDetail: "A real, editable preview for structured answers, evidence, and follow-up work. It lives below the Canvas, where it can be inspected without competing with the first view.",
    heroMeta: ["Schema-first", "Application-owned", "shadcn-compatible"],
    manifesto: "Every agent run should leave an inspectable work surface.",
    manifestoDetail: "Every artifact is selected from a known catalog, validated at the boundary, and rendered by code you control.",
    install: "Install",
    installTitle: "Install an agent interface your application controls.",
    installDetail: "The dedicated CLI installs editable components through shadcn. Runtime packages keep the protocol centralized.",
    chooseEntry: "Choose an entry point",
    everything: "Everything",
    oneArtifact: "One artifact",
    directRegistry: "Direct registry",
    installationGuide: "Installation guide",
    catalog: "Component catalog",
    catalogTitle: "A working surface for every data-agent step.",
    catalogDetail: "Explore the same components your agent can select at runtime.",
    trustBoundary: "Trust boundary",
    trustTitle: "Agents propose. Your runtime decides.",
    trustDetail: "Models emit declarative data. Registered code decides what can render, calculate, and return an action.",
    securityModel: "Read the security model",
    runtime: "Composable runtime",
    runtimeTitle: "Build an agent UI without surrendering the control plane.",
    openSource: "Open source",
    openSourceTitle: "Own the interface between an agent and business data.",
    github: "View on GitHub",
    architecture: "Architecture",
    protocol: [
      ["Select", "Tool guidance chooses a registered artifact."],
      ["Validate", "Zod parses a versioned, declarative payload."],
      ["Render", "Your catalog resolves trusted React components."],
      ["Respond", "Interactions return structured intent to the agent."],
    ],
    packages: ["Artifact protocol", "Catalog and trusted runtime", "Renderers and interactions", "AI SDK adapter", "Mastra adapter"],
  },
  zh: {
    eyebrow: "面向 Agent 构建的开源平台",
    lead: "完全运行在本地的数据分析、管理与操作 Agent，支持多种数据库和可扩展插件。",
    getStarted: "开始使用",
    browse: "浏览组件",
    interactivePreview: "交互式工作台",
    workspace: "工作界面",
    workspaceTitle: "查看模型回答后的真实工作界面。",
    workspaceDetail: "这是一个可编辑的真实预览，用于呈现结构化回答、证据与后续工作。它放在 Canvas 首屏之后，不与第一视图争夺注意力。",
    heroMeta: ["Schema 优先", "应用掌控", "兼容 shadcn"],
    manifesto: "每次 Agent 运行，都应留下可检查的工作界面。",
    manifestoDetail: "每个 Artifact 都从已知目录中选择，在边界处完成验证，并由你控制的代码进行渲染。",
    install: "安装",
    installTitle: "安装由你的应用掌控的 Agent 界面。",
    installDetail: "专用 CLI 通过 shadcn 安装可编辑组件，运行时包则集中维护协议。",
    chooseEntry: "选择接入方式",
    everything: "全部组件",
    oneArtifact: "单个 Artifact",
    directRegistry: "直接使用 Registry",
    installationGuide: "安装指南",
    catalog: "组件目录",
    catalogTitle: "覆盖每一步数据智能体工作流的工作界面。",
    catalogDetail: "浏览智能体在运行时可以选择的同一组组件。",
    trustBoundary: "信任边界",
    trustTitle: "Agent 提议，运行时决定。",
    trustDetail: "模型只输出声明式数据；注册代码决定允许渲染、计算和返回哪些操作。",
    securityModel: "阅读安全模型",
    runtime: "可组合运行时",
    runtimeTitle: "构建 Agent UI，不交出控制平面。",
    openSource: "开放源代码",
    openSourceTitle: "掌控 Agent 与业务数据之间的界面。",
    github: "在 GitHub 上查看",
    architecture: "架构",
    protocol: [
      ["选择", "工具说明从注册目录中选择 Artifact。"],
      ["验证", "Zod 解析带版本的声明式载荷。"],
      ["渲染", "组件目录解析为可信的 React 组件。"],
      ["响应", "交互将结构化意图返回给智能体。"],
    ],
    packages: ["Artifact 协议", "目录与可信运行时", "渲染器与交互", "AI SDK 适配器", "Mastra 适配器"],
  },
} as const;

export default async function HomePage({ params }: PageProps<"/[lang]">) {
  const { lang } = await params;
  const text = lang === "zh" ? copy.zh : copy.en;
  const path = (value: string) => localizedPath(lang, value);

  return (
    <div className={styles.page}>
      <main id="main-content">
        <section className={styles.heroShell}>
          <div className={styles.heroCanvas}>
            <div className={styles.heroBackdrop}>
              <HeroBackdrop />
            </div>
            <div className={styles.heroInner}>
              <div className={styles.heroCopy}>
                <p className={styles.eyebrow}>
                  <BracesIcon aria-hidden="true" />
                  {text.eyebrow}
                </p>
                <h1>Data Elements</h1>
                <p className={styles.heroLead}>{text.lead}</p>
                <div className={styles.heroActions}>
                  <Link className={styles.primaryButton} href={path("/docs")}>
                    {text.getStarted}
                    <ArrowRightIcon aria-hidden="true" />
                  </Link>
                  <Link className={styles.secondaryButton} href={path("/docs/components")}>
                    {text.browse}
                  </Link>
                </div>
              </div>
              <div className={styles.heroProductFrame}>
                <div className={styles.heroProductChrome} aria-hidden="true">
                  <div className={styles.heroProductLights}>
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className={styles.heroProductTitle}>Data Elements Studio</span>
                </div>
                <div className={styles.heroProductPreview}>
                  <img
                    alt="Data Elements Studio in dark theme"
                    className={styles.heroProductDark}
                    height={916}
                    src="/images/data-elements-studio-dark.png"
                    width={1718}
                  />
                  <img
                    alt="Data Elements Studio in light theme"
                    className={styles.heroProductLight}
                    height={2304}
                    src="/images/data-elements-studio-light-hd.png"
                    width={4096}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className={`${styles.manifesto} ${styles.canvasPanel}`}>
          <CanvasPanelBackdrop imageKey="indigo" />
          <p>{text.manifesto}</p>
          <span>{text.manifestoDetail}</span>
        </section>

        <section className={`${styles.installSection} ${styles.canvasPanel}`} id="install">
          <CanvasPanelBackdrop imageKey="cyan" />
          <header className={styles.sectionHeading}>
            <p>{text.install}</p>
            <h2>{text.installTitle}</h2>
            <span>{text.installDetail}</span>
          </header>

          <div className={styles.installVisual}>
            <div className={styles.installConsole}>
              <div className={styles.consoleHeader}>
                <PackageIcon aria-hidden="true" />
                <span>{text.chooseEntry}</span>
              </div>
              <div className={styles.commandRow}>
                <span>{text.everything}</span>
                <InstallCopy command="npx data-elements@latest" tone="console" />
              </div>
              <div className={styles.commandRow}>
                <span>{text.oneArtifact}</span>
                <InstallCopy command="npx data-elements@latest add query-artifact" tone="console" />
              </div>
              <div className={styles.commandRow}>
                <span>{text.directRegistry}</span>
                <InstallCopy
                  command="npx shadcn@latest add https://data-elements.dev/r/query-artifact.json"
                  tone="console"
                />
              </div>
              <Link className={styles.textLink} href={path("/docs/integrations/shadcn-registry")}>
                {text.installationGuide}
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>

        <section className={`${styles.catalogSection} ${styles.canvasPanel}`} id="components">
          <CanvasPanelBackdrop imageKey="blue" />
          <header className={styles.centeredHeading}>
            <p>{text.catalog}</p>
            <h2>{text.catalogTitle}</h2>
            <span>{text.catalogDetail}</span>
          </header>
          <ComponentCanvas />
        </section>

        <section className={`${styles.protocolSection} ${styles.canvasPanel}`}>
          <CanvasPanelBackdrop imageKey="plum" />
          <div className={styles.protocolStatement}>
            <ShieldCheckIcon aria-hidden="true" />
            <p>{text.trustBoundary}</p>
            <h2>{text.trustTitle}</h2>
            <span>{text.trustDetail}</span>
            <Link className={styles.textLink} href={path("/docs/concepts/security")}>
              {text.securityModel}
              <ArrowRightIcon aria-hidden="true" />
            </Link>
          </div>

          <ol className={styles.protocolList}>
            {text.protocol.map(([label, detail], index) => {
              const StepIcon = protocolIcons[index] ?? GitBranchIcon;
              return (
              <li key={label}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <StepIcon aria-hidden="true" />
                <div>
                  <strong>{label}</strong>
                  <p>{detail}</p>
                </div>
              </li>
              );
            })}
          </ol>
        </section>

        <section className={`${styles.packageSection} ${styles.canvasPanel}`}>
          <CanvasPanelBackdrop imageKey="sage" />
          <header className={styles.sectionHeading}>
            <p>{text.runtime}</p>
            <h2>{text.runtimeTitle}</h2>
          </header>
          <div className={styles.packageList}>
            {packageNames.map((name, index) => (
              <div className={styles.packageRow} key={name}>
                <code>{name}</code>
                <span>{text.packages[index]}</span>
                <CheckIcon aria-hidden="true" />
              </div>
            ))}
          </div>
        </section>

        <section className={`${styles.openSourceSection} ${styles.canvasPanel}`}>
          <CanvasPanelBackdrop imageKey="gold" />
          <div className={styles.openSourceMark}>
            <Icon aria-hidden="true" icon={githubIcon} />
          </div>
          <div>
            <p>{text.openSource}</p>
            <h2>{text.openSourceTitle}</h2>
          </div>
          <div className={styles.openSourceActions}>
            <a
              className={styles.primaryButton}
              href="https://github.com/ErKeLost/Tessera"
              rel="noreferrer"
              target="_blank"
            >
              {text.github}
              <ArrowRightIcon aria-hidden="true" />
            </a>
            <Link className={styles.secondaryButton} href={path("/docs/agent/architecture")}>
              {text.architecture}
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
