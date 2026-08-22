"use client";

import {
  ArrowUpRightIcon,
  ChartNoAxesCombinedIcon,
  DatabaseIcon,
  GaugeIcon,
  Grid3X3Icon,
  InboxIcon,
  LaptopIcon,
  ListFilterIcon,
  MessageSquareWarningIcon,
  MinusIcon,
  MousePointer2Icon,
  PanelsTopLeftIcon,
  PlusIcon,
  Rows3Icon,
  ScanIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  Table2Icon,
  TabletIcon,
  TypeIcon,
} from "lucide-react";
import Link from "next/link";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { type CSSProperties, type KeyboardEvent, useId, useState } from "react";
import { ComponentContractDemo } from "@/components/generative-gallery";
import styles from "./home.module.css";
import { localizedPath } from "@/lib/i18n";

const items = [
  {
    id: "layout-stack",
    componentType: "layout.stack",
    label: "Stack",
    detail: "Ordered reading flow for generated analysis.",
    href: "/docs/components/generative-ui-catalog",
    icon: Rows3Icon,
  },
  {
    id: "layout-grid",
    componentType: "layout.grid",
    label: "Grid",
    detail: "Responsive comparison without viewport-specific output.",
    href: "/docs/components/generative-ui-catalog",
    icon: Grid3X3Icon,
  },
  {
    id: "layout-section",
    componentType: "layout.section",
    label: "Section",
    detail: "Semantic grouping with stable heading levels.",
    href: "/docs/components/generative-ui-catalog",
    icon: PanelsTopLeftIcon,
  },
  {
    id: "content-text",
    componentType: "content.text",
    label: "Text",
    detail: "Safe text roles without markup or executable content.",
    href: "/docs/components/generative-ui-catalog",
    icon: TypeIcon,
  },
  {
    id: "content-callout",
    componentType: "content.callout",
    label: "Callout",
    detail: "Evidence-backed insight, warning, or constraint.",
    href: "/docs/components/generative-ui-catalog",
    icon: MessageSquareWarningIcon,
  },
  {
    id: "content-empty",
    componentType: "content.empty",
    label: "Empty",
    detail: "Explicit no-data, denied, and unavailable states.",
    href: "/docs/components/generative-ui-catalog",
    icon: InboxIcon,
  },
  {
    id: "data-metric",
    componentType: "data.metric",
    label: "Metric",
    detail: "Validated scalar values with comparison and selection.",
    href: "/docs/components/generative-ui-catalog",
    icon: GaugeIcon,
  },
  {
    id: "data-table",
    componentType: "data.table",
    label: "Table",
    detail: "Windowed exact rows with sort and pagination.",
    href: "/docs/components/generative-ui-catalog",
    icon: Table2Icon,
  },
  {
    id: "data-chart",
    componentType: "data.chart",
    label: "Chart",
    detail: "One strict ChartSpec covering all 70 recipes.",
    href: "/docs/components/generative-ui-catalog",
    icon: ChartNoAxesCombinedIcon,
  },
  {
    id: "data-query-details",
    componentType: "data.query-details",
    label: "Query details",
    detail: "Policy-controlled SQL, lineage, freshness, and evidence.",
    href: "/docs/components/generative-ui-catalog",
    icon: DatabaseIcon,
  },
  {
    id: "control-filter",
    componentType: "control.filter",
    label: "Filter",
    detail: "State-bound filter inputs over governed options.",
    href: "/docs/components/generative-ui-catalog",
    icon: ListFilterIcon,
  },
  {
    id: "control-group",
    componentType: "control.group",
    label: "Control group",
    detail: "Related filters with explicit apply and reset behavior.",
    href: "/docs/components/generative-ui-catalog",
    icon: SlidersHorizontalIcon,
  },
] as const;

const viewports = [
  { id: "desktop", label: "Desktop preview", size: "Flexible", icon: LaptopIcon },
  { id: "tablet", label: "Tablet preview", size: "768 px", icon: TabletIcon },
  { id: "mobile", label: "Mobile preview", size: "390 px", icon: SmartphoneIcon },
] as const;

const chineseItems = {
  "layout-stack": { label: "Stack", detail: "为生成式分析提供有序阅读流。" },
  "layout-grid": { label: "Grid", detail: "无需生成视口专用输出的响应式对比布局。" },
  "layout-section": { label: "Section", detail: "使用稳定 Heading Level 进行语义分组。" },
  "content-text": { label: "Text", detail: "不接收 Markup 或可执行内容的安全文本角色。" },
  "content-callout": { label: "Callout", detail: "由证据支撑的洞察、警告或约束。" },
  "content-empty": { label: "Empty", detail: "明确表达无数据、拒绝访问与不可用状态。" },
  "data-metric": { label: "Metric", detail: "带 Comparison 与 Selection 的已验证标量值。" },
  "data-table": { label: "Table", detail: "支持排序和分页的窗口化精确数据行。" },
  "data-chart": { label: "Chart", detail: "用一套严格 ChartSpec 覆盖全部 70 个 Recipe。" },
  "data-query-details": { label: "Query Details", detail: "受策略控制的 SQL、血缘、Freshness 与 Evidence。" },
  "control-filter": { label: "Filter", detail: "绑定 State、只使用受治理选项的筛选控件。" },
  "control-group": { label: "Control Group", detail: "组织相关筛选器，并明确 Apply 与 Reset 行为。" },
} as const;

type ItemId = (typeof items)[number]["id"];
type ViewportId = (typeof viewports)[number]["id"];

export function ComponentCanvas() {
  const { locale = "en" } = useI18n();
  const chinese = locale === "zh";
  const [active, setActive] = useState<ItemId>("layout-stack");
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
        aria-label={chinese ? "Component Contract 预览" : "Component Contract previews"}
        className={styles.componentRail}
        data-home-canvas-item
        role="tablist"
      >
        <p>Contracts</p>
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
                <ComponentContractDemo componentType={item.componentType} />
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
