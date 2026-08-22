"use client";

import {
  ArrowUpIcon,
  BarChart3Icon,
  BracesIcon,
  CheckCircle2Icon,
  CircleCheckIcon,
  DatabaseIcon,
  LineChartIcon,
  ListFilterIcon,
  PlusIcon,
  SearchIcon,
  ScanSearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { useId, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { TesseraAgentLogo } from "@/components/tessera-agent-logo";
import { ChartRecipeDemo } from "@/components/generative-gallery";
import type { ChartRecipeName } from "@/components/generative-gallery-model";

type HeroRecipe = Extract<
  ChartRecipeName,
  "revenue-smooth-area" | "sessions-conversion-combo" | "activity-rings"
>;

const suggestions = [
  "Show revenue by day for the last 30 days",
  "Compare activation across plans",
  "Find the largest week-over-week change",
] as const;

const views = [
  { id: "revenue-smooth-area", label: "Revenue", icon: LineChartIcon },
  { id: "sessions-conversion-combo", label: "Conversion", icon: BarChart3Icon },
  { id: "activity-rings", label: "Activity", icon: CircleCheckIcon },
] as const;

const runSteps = [
  { label: "Discover", detail: "4 sources", icon: ScanSearchIcon },
  { label: "Query", detail: "30 rows", icon: DatabaseIcon },
  { label: "Validate", detail: "8 checks", icon: ShieldCheckIcon },
  { label: "Answer", detail: "grounded", icon: CircleCheckIcon },
] as const;

const chineseSuggestions = [
  "显示最近 30 天的每日收入",
  "比较不同套餐的激活率",
  "找出最大的周环比变化",
] as const;

const chineseViews = {
  "revenue-smooth-area": "收入趋势",
  "sessions-conversion-combo": "转化表现",
  "activity-rings": "活跃进度",
} as const;

const chineseRunSteps = [
  { label: "发现", detail: "4 个来源" },
  { label: "查询", detail: "30 行" },
  { label: "验证", detail: "8 项检查" },
  { label: "回答", detail: "证据充分" },
] as const;

export function HeroChat() {
  const { locale } = useI18n();
  const chinese = locale === "zh";
  const localizedSuggestions = chinese ? chineseSuggestions : suggestions;
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState<string>(localizedSuggestions[0]);
  const [activeView, setActiveView] = useState<HeroRecipe>("revenue-smooth-area");
  const [showSql, setShowSql] = useState(false);
  const tabsId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = input.trim();
    if (!next) return;
    setQuestion(next);
    setActiveView(inferRecipe(next));
    setInput("");
  }

  function chooseSuggestion(suggestion: string) {
    setQuestion(suggestion);
    setActiveView(inferRecipe(suggestion));
    setShowSql(false);
  }

  function startNewAnalysis() {
    setQuestion(localizedSuggestions[0]);
    setActiveView("revenue-smooth-area");
    setInput("");
    setShowSql(false);
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const next = views[(index + offset + views.length) % views.length];
    if (!next) return;
    setActiveView(next.id);
    document.getElementById(`${tabsId}-${next.id}-tab`)?.focus();
  }

  return (
    <div className="heroChat" aria-label={chinese ? "Tessera Agent 交互式预览" : "Interactive Tessera Agent preview"} data-home-chat>
      <aside className="heroChatSidebar" aria-label={chinese ? "Tessera Agent 导航" : "Tessera Agent navigation"} data-home-chat-sidebar>
        <div className="heroChatBrand">
          <TesseraAgentLogo className="heroChatBrandLogo" />
          <strong>Tessera Agent</strong>
        </div>
        <button className="heroChatNew" onClick={startNewAnalysis} type="button">
          <PlusIcon aria-hidden="true" />
          {chinese ? "新建分析" : "New analysis"}
        </button>
        <nav className="heroChatNav">
          <p>{chinese ? "工作区" : "Workspace"}</p>
          <span className="heroChatNavActive">
            <SparklesIcon aria-hidden="true" />
            {chinese ? "分析师" : "Analyst"}
          </span>
          <span>
            <DatabaseIcon aria-hidden="true" />
            {chinese ? "数据源" : "Sources"}
          </span>
          <span>
            <SearchIcon aria-hidden="true" />
            {chinese ? "历史记录" : "History"}
          </span>
        </nav>
        <div className="heroChatSource">
          <span><DatabaseIcon aria-hidden="true" /></span>
          <div><strong>{chinese ? "数据仓库" : "Warehouse"}</strong><small>{chinese ? "已连接 4 个来源" : "4 sources connected"}</small></div>
          <CheckCircle2Icon aria-hidden="true" />
        </div>
      </aside>

      <section className="heroChatMain" data-home-chat-main>
        <header className="heroChatTopbar">
          <div><span className="heroChatStatus" />{chinese ? "受治理工作区" : "Governed workspace"}</div>
          <span><ListFilterIcon aria-hidden="true" />{chinese ? "最近 30 天" : "Last 30 days"}</span>
        </header>

        <div className="heroChatConversation">
          <div className="heroChatQuestion" key={question}>
            <span>{chinese ? "你" : "You"}</span>
            <p>{question}</p>
          </div>

          <article className="heroChatAnswer">
            <div className="heroChatAvatar"><SparklesIcon aria-hidden="true" /></div>
            <div className="heroChatAnswerBody">
              <div className="heroChatAnswerIntro">
                <div>
                  <span>Tessera Agent</span>
                  <h2>{chinese ? "收入总体呈上升趋势，其间出现两次短暂回落。" : "Revenue is trending up, with two short pullbacks."}</h2>
                </div>
                <small>{chinese ? "基于 2 个获准来源回答" : "Answered from 2 approved sources"}</small>
              </div>
              <p className="heroChatSummary">
                {chinese
                  ? "昨日完成的 Credit 交易量达到 8.4k。最近 30 天较上一周期增长 18.6%，主要由工作区升级和回流团队推动。"
                  : "Completed credit volume reached 8.4k yesterday. The 30-day trend is 18.6% above the previous period, led by workspace upgrades and returning teams."}
              </p>

              <ol aria-label={chinese ? "分析运行" : "Analysis run"} className="heroChatRun">
                {runSteps.map(({ detail, icon: StepIcon, label }, index) => (
                  <li key={label}>
                    <span><StepIcon aria-hidden="true" /></span>
                    <div><strong>{chinese ? chineseRunSteps[index]?.label : label}</strong><small>{chinese ? chineseRunSteps[index]?.detail : detail}</small></div>
                  </li>
                ))}
              </ol>

              <div className="heroChatTabs" role="tablist" aria-label={chinese ? "图表 Recipe" : "Chart recipe"}>
                {views.map(({ id, label, icon: Icon }, index) => (
                  <button
                    aria-controls={`${tabsId}-${id}-panel`}
                    aria-selected={activeView === id}
                    className={activeView === id ? "heroChatTabActive" : undefined}
                    id={`${tabsId}-${id}-tab`}
                    key={id}
                    onClick={() => setActiveView(id)}
                    onKeyDown={(event) => moveTab(event, index)}
                    role="tab"
                    tabIndex={activeView === id ? 0 : -1}
                    type="button"
                  >
                    <Icon aria-hidden="true" />
                    {chinese ? chineseViews[id] : label}
                  </button>
                ))}
              </div>

              <div
                aria-labelledby={`${tabsId}-${activeView}-tab`}
                className="heroChatResult"
                id={`${tabsId}-${activeView}-panel`}
                key={activeView}
                role="tabpanel"
              >
                <ChartRecipeDemo recipeName={activeView} />
              </div>

              <footer className="heroChatEvidence">
                <span><DatabaseIcon aria-hidden="true" />analytics.credit_ledger</span>
                <span>760 ms</span>
                <button
                  aria-expanded={showSql}
                  className="heroChatSqlToggle"
                  onClick={() => setShowSql((value) => !value)}
                  type="button"
                >
                  <BracesIcon aria-hidden="true" />
                  {showSql ? chinese ? "隐藏 SQL" : "Hide SQL" : chinese ? "查看 SQL" : "View SQL"}
                </button>
              </footer>
              {showSql ? (
                <pre className="heroChatSql"><code>{`select date, sum(credit_volume) as revenue\nfrom analytics.credit_ledger\nwhere date >= current_date - interval '30 days'\ngroup by date order by date;`}</code></pre>
              ) : null}
            </div>
          </article>
        </div>

        <div className="heroChatComposerArea">
          <div className="heroChatSuggestions">
            {localizedSuggestions.map((suggestion) => (
              <button key={suggestion} onClick={() => chooseSuggestion(suggestion)} type="button">
                {suggestion}
              </button>
            ))}
          </div>
          <form className="heroChatComposer" onSubmit={submit}>
            <input
              autoComplete="off"
              aria-label={chinese ? "询问数据" : "Ask about your data"}
              name="data-question"
              onChange={(event) => setInput(event.target.value)}
              placeholder={chinese ? "继续询问你的数据…" : "Ask a follow-up about your data…"}
              value={input}
            />
            <button aria-label={chinese ? "发送问题" : "Send question"} disabled={!input.trim()} type="submit"><ArrowUpIcon aria-hidden="true" /></button>
          </form>
          <p className="heroChatHint">{chinese ? "Schema 已验证 · 只读工具 · 包含来源溯源" : "Schema validated · read-only tools · source lineage included"}</p>
        </div>
      </section>
    </div>
  );
}

function inferRecipe(question: string): HeroRecipe {
  const normalized = question.toLowerCase();
  if (normalized.includes("compare") || normalized.includes("conversion") || normalized.includes("比较") || normalized.includes("转化")) {
    return "sessions-conversion-combo";
  }
  if (normalized.includes("activity") || normalized.includes("kpi") || normalized.includes("活跃") || normalized.includes("指标")) {
    return "activity-rings";
  }
  return "revenue-smooth-area";
}
