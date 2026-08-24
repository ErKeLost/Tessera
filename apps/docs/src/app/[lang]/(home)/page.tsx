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

function CanvasPanelBackdrop({ imageKey }: { imageKey: PanelImageKey }) {
  return (
    <div className={styles.sectionBackdrop}>
      <HeroBackdrop imageKey={imageKey} variant="panel" />
    </div>
  );
}

const copy = {
  en: {
    eyebrow: "Governed database analysis agent",
    lead: "Tessera Agent turns database questions into bounded queries, verified evidence, and analysis views your team can inspect.",
    getStarted: "Get started",
    browse: "Explore analysis views",
    interactivePreview: "Tessera Agent workspace",
    workspace: "Working interface",
    workspaceTitle: "See the interface after a model responds.",
    workspaceDetail: "A real, editable preview for structured answers, evidence, and follow-up work. It lives below the Canvas, where it can be inspected without competing with the first view.",
    heroMeta: ["Schema-first", "Application-owned", "shadcn-compatible"],
    manifesto: "One product owns the complete path from question to evidence.",
    manifestoDetail: "Tessera scopes the catalog, executes governed tools, verifies results, persists every completed step, and renders the final answer without handing database authority to the model or browser.",
    install: "Install",
    installTitle: "Start Tessera Agent with the database you already use.",
    installDetail: "The Studio executable includes the Agent runtime, database tools, session memory, and analysis-view renderer.",
    chooseEntry: "Choose a connection",
    everything: "PostgreSQL",
    oneArtifact: "MySQL",
    directRegistry: "SQLite",
    installationGuide: "Read the installation guide",
    catalog: "Analysis views",
    catalogTitle: "Seventeen focused Data Chart designs.",
    catalogDetail: "Explore the result views Tessera can choose after a verified database query.",
    trustBoundary: "Trust boundary",
    trustTitle: "Agents propose. Your runtime decides.",
    trustDetail: "The model chooses bounded tools and presentation intent. Tessera validates access, executes the database work, records evidence, and renders trusted output.",
    securityModel: "Read the security model",
    runtime: "Runtime guarantees",
    runtimeTitle: "The boundaries Tessera enforces on every analysis.",
    openSource: "Open source",
    openSourceTitle: "Inspect the complete Tessera Agent implementation.",
    github: "View on GitHub",
    architecture: "Architecture",
    protocol: [
      ["Discover", "Tessera exposes only the current, bounded catalog scope."],
      ["Execute", "A registered database tool runs within permission and resource limits."],
      ["Verify", "The Agent distinguishes evidence, partial results, and actionable failures."],
      ["Present", "The Studio renders text, tool state, and an optional generated analysis view."],
    ],
    capabilities: [
      ["Catalog-scoped planning", "Only inspected schemas and relations enter the planning context"],
      ["Bounded database execution", "Reads and mutations pass separate safety and approval gates"],
      ["Per-step session memory", "Mastra saves private context after every completed model step"],
      ["Evidence-backed answers", "Claims stay connected to verified tool output"],
      ["Generated analysis views", "Views bind only to resources Tessera already verified"],
      ["Durable approval workflow", "Suspended mutations resume from durable server state"],
    ],
  },
  zh: {
    eyebrow: "受治理的数据库分析 Agent",
    lead: "Tessera Agent 把数据库问题转换成有上限的查询、可核验的 Evidence 与团队可以检查的分析视图。",
    getStarted: "开始使用",
    browse: "浏览分析视图",
    interactivePreview: "Tessera Agent 工作台",
    workspace: "工作界面",
    workspaceTitle: "查看模型回答后的真实工作界面。",
    workspaceDetail: "这是一个可编辑的真实预览，用于呈现结构化回答、证据与后续工作。它放在 Canvas 首屏之后，不与第一视图争夺注意力。",
    heroMeta: ["Schema 优先", "应用掌控", "兼容 shadcn"],
    manifesto: "一个产品负责从问题到 Evidence 的完整链路。",
    manifestoDetail: "Tessera 负责限制 Catalog、执行受治理 Tool、核验结果、逐 Step 持久化，并渲染最终回答，不把数据库 Authority 交给模型或浏览器。",
    install: "安装",
    installTitle: "使用现有数据库直接启动 Tessera Agent。",
    installDetail: "Studio 可执行程序已经包含 Agent Runtime、数据库 Tool、Session Memory 与分析视图 Renderer。",
    chooseEntry: "选择数据库连接",
    everything: "PostgreSQL",
    oneArtifact: "MySQL",
    directRegistry: "SQLite",
    installationGuide: "查看安装指南",
    catalog: "分析视图",
    catalogTitle: "17 个专注的数据图表设计。",
    catalogDetail: "查看 Tessera 在可信数据库查询完成后可以选择的结果视图。",
    trustBoundary: "信任边界",
    trustTitle: "Agent 提议，运行时决定。",
    trustDetail: "模型只选择受限 Tool 与呈现意图；Tessera 校验访问、执行数据库工作、记录 Evidence，再渲染可信结果。",
    securityModel: "阅读安全模型",
    runtime: "Runtime 保证",
    runtimeTitle: "Tessera 对每次分析强制执行的边界。",
    openSource: "开放源代码",
    openSourceTitle: "检查完整的 Tessera Agent 实现。",
    github: "在 GitHub 上查看",
    architecture: "架构",
    protocol: [
      ["发现", "Tessera 只暴露当前有上限的 Catalog Scope。"],
      ["执行", "已注册数据库 Tool 在权限与资源限制内运行。"],
      ["核验", "Agent 明确区分 Evidence、Partial Result 与可行动失败。"],
      ["呈现", "Studio 渲染文字、Tool 状态与可选的生成式分析视图。"],
    ],
    capabilities: [
      ["限定范围的 Catalog 规划", "只有已检查的 Schema 与 Relation 进入规划上下文"],
      ["有上限的数据库执行", "Read 与 Mutation 分别经过安全与审批门槛"],
      ["逐 Step Session Memory", "Mastra 在每个已完成模型 Step 后保存私有上下文"],
      ["Evidence 支撑的回答", "结论始终连接到可信 Tool Output"],
      ["生成式分析视图", "视图只绑定 Tessera 已核验的 Resource"],
      ["Durable Approval Workflow", "暂停的 Mutation 从服务端 Durable State 恢复"],
    ],
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
                <InstallCopy
                  command="npx @open-tessera/studio@latest postgresql://user:password@127.0.0.1:5432/warehouse"
                  tone="console"
                />
              </div>
              <div className={styles.commandRow}>
                <span>{text.oneArtifact}</span>
                <InstallCopy
                  command="npx @open-tessera/studio@latest mysql://user:password@127.0.0.1:3306/warehouse"
                  tone="console"
                />
              </div>
              <div className={styles.commandRow}>
                <span>{text.directRegistry}</span>
                <InstallCopy
                  command="npx @open-tessera/studio@latest file:/absolute/path/to/warehouse.db"
                  tone="console"
                />
              </div>
              <Link className={styles.textLink} href={path("/docs/agent/getting-started")}>
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
            {text.capabilities.map(([name, detail]) => (
              <div className={styles.packageRow} key={name}>
                <code>{name}</code>
                <span>{detail}</span>
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
