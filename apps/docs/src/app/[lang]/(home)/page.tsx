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
  "@open-generative/protocol",
  "@open-generative/catalog",
  "@open-generative/react",
  "@open-generative/ai-sdk",
  "@open-generative/mastra",
  "@open-generative/ag-ui",
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
    eyebrow: "Generative UI for governed data agents",
    lead: "Tessera Agent is proving a final, host-governed Generative UI architecture through real data-analysis workflows.",
    getStarted: "Read the proof",
    browse: "Browse the catalog",
    interactivePreview: "Tessera Agent workspace",
    workspace: "Working interface",
    workspaceTitle: "See the interface after a model responds.",
    workspaceDetail: "A real, editable preview for structured answers, evidence, and follow-up work. It lives below the Canvas, where it can be inspected without competing with the first view.",
    heroMeta: ["Schema-first", "Application-owned", "shadcn-compatible"],
    manifesto: "The Data Agent proof comes before the standalone framework.",
    manifestoDetail: "The complete architecture, component contracts, official renderers, fixtures, and proof gates stay in Tessera Agent until the data-agent experience succeeds end to end.",
    install: "Repository proof",
    installTitle: "Run the architecture and component gates from source.",
    installDetail: "The packages and remote registry are not presented as published products. Today, this repository is the executable source of truth.",
    chooseEntry: "Current verification path",
    everything: "Install workspace",
    oneArtifact: "Check contracts",
    directRegistry: "Run all gates",
    installationGuide: "Read the proof workflow",
    catalog: "Component catalog",
    catalogTitle: "A focused component system for the Tessera Data Agent.",
    catalogDetail: "Explore the contracts, renderers, and analytical recipes used by the current proof.",
    trustBoundary: "Trust boundary",
    trustTitle: "Agents propose. Your runtime decides.",
    trustDetail: "Models propose declarative nodes. The host validates, commits, resolves data and authority, then registered code renders them.",
    securityModel: "Read the security model",
    runtime: "Composable runtime",
    runtimeTitle: "One protocol and one renderer chain, proven in Tessera Agent.",
    openSource: "Open source",
    openSourceTitle: "Inspect the complete Tessera Agent Generative UI proof.",
    github: "View on GitHub",
    architecture: "Architecture",
    protocol: [
      ["Propose", "The model uses only the frozen, task-scoped Component Contract slice."],
      ["Commit", "The server normalizes, validates, authorizes, and commits the declaration."],
      ["Control", "SurfaceController consumes trusted events and resolves node-scoped values."],
      ["Render", "GenerativeSurface resolves an exact renderer from RendererRegistry."],
    ],
    packages: ["Canonical protocol", "Contracts and trusted runtime", "React surface and UI renderers", "AI SDK transport boundary", "Mastra integration boundary", "AG-UI event boundary"],
  },
  zh: {
    eyebrow: "面向受治理 Data Agent 的 Generative UI",
    lead: "Tessera Agent 正通过真实数据分析工作流，验证一套终局的、由宿主治理的 Generative UI 架构。",
    getStarted: "查看成功证明",
    browse: "浏览组件目录",
    interactivePreview: "Tessera Agent 工作台",
    workspace: "工作界面",
    workspaceTitle: "查看模型回答后的真实工作界面。",
    workspaceDetail: "这是一个可编辑的真实预览，用于呈现结构化回答、证据与后续工作。它放在 Canvas 首屏之后，不与第一视图争夺注意力。",
    heroMeta: ["Schema 优先", "应用掌控", "兼容 shadcn"],
    manifesto: "先证明 Data Agent，再拆分通用框架。",
    manifestoDetail: "在 Data Agent 体验端到端成功之前，完整架构、组件 Contract、官方 Renderer、Fixture 与证明门槛都继续留在 Tessera Agent。",
    install: "仓库验证",
    installTitle: "直接从源码运行架构与组件门槛。",
    installDetail: "当前不会把 Package 与远程 Registry 写成已经发布的产品；这个仓库才是唯一可执行的 source of truth。",
    chooseEntry: "当前验证路径",
    everything: "安装 Workspace",
    oneArtifact: "检查 Contract",
    directRegistry: "运行全部门槛",
    installationGuide: "查看证明流程",
    catalog: "组件目录",
    catalogTitle: "专门为 Tessera Data Agent 收敛的组件体系。",
    catalogDetail: "浏览当前 proof 使用的 Contract、Renderer 与分析 Recipe。",
    trustBoundary: "信任边界",
    trustTitle: "Agent 提议，运行时决定。",
    trustDetail: "模型只提议声明式节点；宿主完成校验、提交、数据与权限解析，再由注册代码渲染。",
    securityModel: "阅读安全模型",
    runtime: "可组合运行时",
    runtimeTitle: "一套协议、一条渲染链，先在 Tessera Agent 中完成证明。",
    openSource: "开放源代码",
    openSourceTitle: "检查完整的 Tessera Agent Generative UI 成功证明。",
    github: "在 GitHub 上查看",
    architecture: "架构",
    protocol: [
      ["提议", "模型只能使用本轮冻结、按任务裁剪的 Component Contract Slice。"],
      ["提交", "服务端负责 Normalize、Validate、Authorize 与 Commit。"],
      ["控制", "SurfaceController 消费可信事件并解析 Node-scoped Value。"],
      ["渲染", "GenerativeSurface 从 RendererRegistry 精确解析 Renderer。"],
    ],
    packages: ["Canonical Protocol", "Contract 与可信 Runtime", "React Surface 与 UI Renderer", "AI SDK 传输边界", "Mastra 集成边界", "AG-UI Event 边界"],
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
                <h1>Tessera Agent</h1>
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
                  <span className={styles.heroProductTitle}>Tessera Agent Studio</span>
                </div>
                <div className={styles.heroProductPreview}>
                  <img
                    alt="Tessera Agent Studio in dark theme"
                    className={styles.heroProductDark}
                    height={916}
                    src="/images/tessera-agent-studio-dark.png"
                    width={1718}
                  />
                  <img
                    alt="Tessera Agent Studio in light theme"
                    className={styles.heroProductLight}
                    height={2304}
                    src="/images/tessera-agent-studio-light-hd.png"
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
                <InstallCopy command="bun install" tone="console" />
              </div>
              <div className={styles.commandRow}>
                <span>{text.oneArtifact}</span>
                <InstallCopy command="bun run check:naming && bun run check:boundaries" tone="console" />
              </div>
              <div className={styles.commandRow}>
                <span>{text.directRegistry}</span>
                <InstallCopy
                  command="bun run typecheck && bun run test && bun run build"
                  tone="console"
                />
              </div>
              <Link className={styles.textLink} href={path("/docs/agent/architecture/generative-ui-proof")}>
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
