"use client";

import {
  ArrowUpIcon,
  BracesIcon,
  CheckCircle2Icon,
  CircleCheckIcon,
  DatabaseIcon,
  ListFilterIcon,
  PlusIcon,
  SearchIcon,
  ScanSearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { useState } from "react";
import type { FormEvent } from "react";
import { TesseraAgentLogo } from "@/components/tessera-agent-logo";

const suggestions = [
  "Show revenue by day for the last 30 days",
  "Compare activation across plans",
  "Find the largest week-over-week change",
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
  const [showSql, setShowSql] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = input.trim();
    if (!next) return;
    setQuestion(next);
    setInput("");
  }

  function chooseSuggestion(suggestion: string) {
    setQuestion(suggestion);
    setShowSql(false);
  }

  function startNewAnalysis() {
    setQuestion(localizedSuggestions[0]);
    setInput("");
    setShowSql(false);
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

              <div className="heroChatResult">
                <dl className="heroChatMetricList">
                  <div><dt>{chinese ? "30 天变化" : "30-day change"}</dt><dd>+18.6%</dd></div>
                  <div><dt>{chinese ? "昨日交易" : "Yesterday's volume"}</dt><dd>8.4k</dd></div>
                  <div><dt>{chinese ? "数据完整性" : "Data completeness"}</dt><dd>99.8%</dd></div>
                </dl>
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
