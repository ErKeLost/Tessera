"use client";

import {
  ArrowUpRightIcon,
  BetweenHorizontalStartIcon,
  CalculatorIcon,
  ChartNoAxesColumnIncreasingIcon,
  FlaskConicalIcon,
  GitCompareArrowsIcon,
  Grid3X3Icon,
  LaptopIcon,
  LineChartIcon,
  ListTreeIcon,
  MinusIcon,
  MousePointer2Icon,
  PlusIcon,
  ScanIcon,
  SmartphoneIcon,
  TabletIcon,
  TrendingUpIcon,
} from "lucide-react";
import Link from "next/link";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { type CSSProperties, type KeyboardEvent, useId, useState } from "react";
import {
  CalculatorDemo,
  BreakdownDemo,
  CohortDemo,
  ComparisonDemo,
  DistributionDemo,
  DriverDemo,
  ExperimentDemo,
  QueryDemo,
  TrendDemo,
} from "@/components/examples";
import styles from "./home.module.css";
import { localizedPath } from "@/lib/i18n";

const items = [
  {
    id: "query",
    label: "Query",
    detail: "Chart, table, SQL, and lineage in one result.",
    href: "/docs/components/query-artifact",
    icon: LineChartIcon,
    scene: "blue-field",
    sceneLabel: "Blue field",
  },
  {
    id: "calculator",
    label: "Calculator",
    detail: "Trusted local calculations with live controls.",
    href: "/docs/components/calculator-artifact",
    icon: CalculatorIcon,
    scene: "sage-flow",
    sceneLabel: "Sage flow",
  },
  {
    id: "comparison",
    label: "Comparison",
    detail: "Inspectable recommendations across clear criteria.",
    href: "/docs/components/comparison-artifact",
    icon: GitCompareArrowsIcon,
    scene: "indigo-flow",
    sceneLabel: "Indigo flow",
  },
  {
    id: "trend",
    label: "Trend",
    detail: "Focused time-series context and point selection.",
    href: "/docs/components/trend-artifact",
    icon: TrendingUpIcon,
    scene: "blue-mountains",
    sceneLabel: "Blue mountains",
  },
  {
    id: "breakdown",
    label: "Breakdown",
    detail: "Ranked contribution with share and category change.",
    href: "/docs/components/breakdown-artifact",
    icon: ListTreeIcon,
    scene: "cyan-ridge",
    sceneLabel: "Cyan ridge",
  },
  {
    id: "distribution",
    label: "Distribution",
    detail: "Histogram, quantiles, center, and outlier context.",
    href: "/docs/components/distribution-artifact",
    icon: ChartNoAxesColumnIncreasingIcon,
    scene: "blue-dunes",
    sceneLabel: "Blue dunes",
  },
  {
    id: "cohort",
    label: "Cohort",
    detail: "Retention aligned by cohort age and start date.",
    href: "/docs/components/cohort-artifact",
    icon: Grid3X3Icon,
    scene: "sage-flow",
    sceneLabel: "Sage flow",
  },
  {
    id: "experiment",
    label: "Experiment",
    detail: "Effect size, uncertainty, samples, and guardrails.",
    href: "/docs/components/experiment-artifact",
    icon: FlaskConicalIcon,
    scene: "plum-flow",
    sceneLabel: "Plum flow",
  },
  {
    id: "driver",
    label: "Drivers",
    detail: "Signed contributions that reconcile start to end.",
    href: "/docs/components/driver-artifact",
    icon: BetweenHorizontalStartIcon,
    scene: "gold-field",
    sceneLabel: "Gold field",
  },
] as const;

const viewports = [
  { id: "desktop", label: "Desktop preview", size: "Flexible", icon: LaptopIcon },
  { id: "tablet", label: "Tablet preview", size: "768 px", icon: TabletIcon },
  { id: "mobile", label: "Mobile preview", size: "390 px", icon: SmartphoneIcon },
] as const;

const chineseItems = {
  query: { label: "查询", detail: "在一个结果中整合图表、表格、SQL 和溯源信息。", sceneLabel: "蓝色平原" },
  calculator: { label: "计算器", detail: "使用实时控件执行可信的本地计算。", sceneLabel: "鼠尾草流线" },
  comparison: { label: "比较", detail: "依据清晰标准给出可审查的建议。", sceneLabel: "靛蓝流线" },
  trend: { label: "趋势", detail: "聚焦时间序列上下文和数据点选择。", sceneLabel: "蓝色山脉" },
  breakdown: { label: "拆解", detail: "按贡献排序并展示占比和类别变化。", sceneLabel: "青色山脊" },
  distribution: { label: "分布", detail: "呈现直方图、分位数、中心位置和离群值上下文。", sceneLabel: "蓝色沙丘" },
  cohort: { label: "Cohort", detail: "按 Cohort 年龄和起始日期对齐留存率。", sceneLabel: "鼠尾草流线" },
  experiment: { label: "实验", detail: "展示效应量、不确定性、样本和护栏指标。", sceneLabel: "梅紫流线" },
  driver: { label: "驱动因素", detail: "使用带符号的贡献项核对起始值和结束值。", sceneLabel: "金色平原" },
} as const;

type ItemId = (typeof items)[number]["id"];
type ViewportId = (typeof viewports)[number]["id"];

export function ComponentCanvas() {
  const { locale = "en" } = useI18n();
  const chinese = locale === "zh";
  const [active, setActive] = useState<ItemId>("query");
  const [viewport, setViewport] = useState<ViewportId>("desktop");
  const [showGrid, setShowGrid] = useState(true);
  const [zoom, setZoom] = useState(88);
  const tabsId = useId();
  const item = items.find((entry) => entry.id === active) ?? items[0];
  const viewportOption = viewports.find((entry) => entry.id === viewport) ?? viewports[0];
  const itemText = chinese ? chineseItems[item.id] : item;
  const viewportLabel = viewport === "desktop"
    ? chinese ? "桌面端" : "Desktop"
    : viewport === "tablet"
      ? chinese ? "平板端" : "Tablet"
      : chinese ? "移动端" : "Mobile";

  function adjustZoom(amount: number) {
    setZoom((current) => Math.min(110, Math.max(60, current + amount)));
  }

  function fitCanvas() {
    setZoom(viewport === "desktop" ? 88 : viewport === "tablet" ? 82 : 92);
  }

  function moveItem(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const next = items[(index + offset + items.length) % items.length];
    if (!next) return;
    setActive(next.id);
    document.getElementById(`${tabsId}-${next.id}-tab`)?.focus();
  }

  return (
    <div className={styles.componentCanvas} data-home-canvas>
      <nav
        aria-label={chinese ? "Artifact 预览" : "Artifact previews"}
        className={styles.componentRail}
        data-home-canvas-item
        role="tablist"
      >
        <p>Artifacts</p>
        {items.map(({ icon: ItemIcon, id, label }, index) => (
          <button
            aria-controls={`${tabsId}-${id}-panel`}
            aria-selected={active === id}
            className={active === id ? styles.componentRailActive : undefined}
            id={`${tabsId}-${id}-tab`}
            key={id}
            onClick={() => setActive(id)}
            onKeyDown={(event) => moveItem(event, index)}
            role="tab"
            tabIndex={active === id ? 0 : -1}
            type="button"
          >
            <ItemIcon aria-hidden="true" />
            <span>{chinese ? chineseItems[id].label : label}</span>
          </button>
        ))}
      </nav>

      <article
        aria-labelledby={`${tabsId}-${active}-tab`}
        className={styles.componentWorkspace}
        data-home-canvas-item
        id={`${tabsId}-${active}-panel`}
        role="tabpanel"
      >
        <header>
          <div>
            <span>{chinese ? "实时组件" : "Live component"} / {itemText.label}</span>
            <h3>{itemText.detail}</h3>
          </div>
          <div className={styles.componentTools}>
            <div aria-label={chinese ? "预览宽度" : "Preview width"} className={styles.viewportControl} role="group">
              {viewports.map(({ icon: ViewportIcon, id, label }) => (
                <button
                  aria-label={chinese ? `${id === "desktop" ? "桌面端" : id === "tablet" ? "平板端" : "移动端"}预览` : label}
                  aria-pressed={viewport === id}
                  className={viewport === id ? styles.viewportActive : undefined}
                  key={id}
                  onClick={() => setViewport(id)}
                  title={chinese ? `${id === "desktop" ? "桌面端" : id === "tablet" ? "平板端" : "移动端"}预览` : label}
                  type="button"
                >
                  <ViewportIcon aria-hidden="true" />
                </button>
              ))}
            </div>
            <Link aria-label={chinese ? `打开 ${itemText.label} 文档` : `Open ${item.label} documentation`} href={localizedPath(locale, item.href)} title={chinese ? "打开文档" : "Open documentation"}>
              <ArrowUpRightIcon aria-hidden="true" />
            </Link>
          </div>
        </header>
        <div className={styles.componentSurface}>
          <div className={styles.canvasToolbar}>
            <div className={styles.canvasToolGroup}>
              <button aria-pressed="true" className={styles.canvasToolActive} title={chinese ? "选择" : "Select"} type="button"><MousePointer2Icon aria-hidden="true" /><span className="sr-only">{chinese ? "选择" : "Select"}</span></button>
              <button aria-pressed={showGrid} className={showGrid ? styles.canvasToolActive : undefined} onClick={() => setShowGrid((current) => !current)} title={chinese ? "切换网格" : "Toggle grid"} type="button"><Grid3X3Icon aria-hidden="true" /><span className="sr-only">{chinese ? "切换网格" : "Toggle grid"}</span></button>
              <span className={styles.canvasCoordinates}>X&nbsp;0&nbsp;&nbsp;Y&nbsp;0</span>
            </div>
          <div className={styles.canvasScene}>
              <span aria-hidden="true" className={styles.canvasSwatch} />
              <span>{chinese ? "单色画布" : "Monochrome canvas"}</span>
            </div>
            <div className={styles.canvasZoom}>
              <button aria-label={chinese ? "缩小" : "Zoom out"} disabled={zoom <= 60} onClick={() => adjustZoom(-6)} title={chinese ? "缩小" : "Zoom out"} type="button"><MinusIcon aria-hidden="true" /></button>
              <output aria-live="polite">{zoom}%</output>
              <button aria-label={chinese ? "放大" : "Zoom in"} disabled={zoom >= 110} onClick={() => adjustZoom(6)} title={chinese ? "放大" : "Zoom in"} type="button"><PlusIcon aria-hidden="true" /></button>
              <button aria-label={chinese ? "适应画布" : "Fit canvas"} onClick={fitCanvas} title={chinese ? "适应画布" : "Fit canvas"} type="button"><ScanIcon aria-hidden="true" /></button>
            </div>
          </div>
          <div className={styles.componentStage} data-grid={showGrid}>
            <div className={styles.canvasTopRuler} aria-hidden="true"><span>0</span><span>240</span><span>480</span><span>720</span><span>960</span></div>
            <div className={styles.canvasSideRuler} aria-hidden="true"><span>0</span><span>160</span><span>320</span><span>480</span></div>
            <div className={styles.canvasAxisX} aria-hidden="true" />
            <div className={styles.canvasAxisY} aria-hidden="true" />
            <div
              className={styles.componentFrame}
              data-viewport={viewport}
              style={{ "--canvas-zoom": zoom / 100 } as CSSProperties}
            >
              <span className={styles.canvasFrameLabel}>{chinese ? "画框" : "Frame"} / {itemText.label}</span>
              <span aria-hidden="true" className={styles.canvasHandle} data-corner="north-west" />
              <span aria-hidden="true" className={styles.canvasHandle} data-corner="north-east" />
              <span aria-hidden="true" className={styles.canvasHandle} data-corner="south-west" />
              <span aria-hidden="true" className={styles.canvasHandle} data-corner="south-east" />
              <div aria-live="polite" className={styles.componentPreview} key={active}>
                {active === "query" && <QueryDemo />}
                {active === "calculator" && <CalculatorDemo />}
                {active === "comparison" && <ComparisonDemo />}
                {active === "trend" && <TrendDemo />}
                {active === "breakdown" && <BreakdownDemo />}
                {active === "distribution" && <DistributionDemo />}
                {active === "cohort" && <CohortDemo />}
                {active === "experiment" && <ExperimentDemo />}
                {active === "driver" && <DriverDemo />}
              </div>
            </div>
            <div className={styles.canvasStatus}>
              <span>{viewportLabel}</span>
              <code>{viewportOption.size}</code>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}
