"use client";

import {
  ArrowUpRightIcon,
  ChartNoAxesCombinedIcon,
  Grid3X3Icon,
  LaptopIcon,
  MinusIcon,
  MousePointer2Icon,
  PlusIcon,
  ScanIcon,
  SmartphoneIcon,
  TabletIcon,
} from "lucide-react";
import Link from "next/link";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { type CSSProperties, type KeyboardEvent, useId, useState } from "react";
import { ChartRecipeDemo } from "@/components/generative-gallery";
import {
  chartRecipeDocumentation,
  generativeGalleryConformanceDescriptors,
  type ChartRecipeName,
} from "@/components/generative-gallery-model";
import styles from "./home.module.css";
import { localizedPath } from "@/lib/i18n";

const items = generativeGalleryConformanceDescriptors.map(descriptor => ({
  id: descriptor.value,
  recipeName: descriptor.value,
  label: chartRecipeDocumentation[descriptor.value].title,
  detail: chartRecipeDocumentation[descriptor.value].description,
  href: "/docs/components/generative-ui-catalog",
  icon: ChartNoAxesCombinedIcon,
}));

const viewports = [
  { id: "desktop", label: "Desktop preview", size: "Flexible", icon: LaptopIcon },
  { id: "tablet", label: "Tablet preview", size: "768 px", icon: TabletIcon },
  { id: "mobile", label: "Mobile preview", size: "390 px", icon: SmartphoneIcon },
] as const;

const chineseDescriptions: Readonly<Record<ChartRecipeName, string>> = {
  "steps-bars": "展示选中日期、周范围与七天目标进度。",
  "pipeline-stage-bars": "展示六个管线阶段的转化进度、周期变化与汇总数据。",
  "sleep-score": "把三项睡眠贡献分数合成为一个分段总分。",
  "revenue-per-account-scatter": "保留离群点的账号收入关系与规模分布。",
  "tracked-time-sankey": "用加权连接展示工作类别到去向的时间流动。",
  "visitors-radial": "用克制的径向构图表达访问总量与分类构成。",
  "visitors-radar": "在同一量纲下比较多维访问者画像。",
  "activity-calendar": "按熟悉的月历布局展示每日活跃强度。",
  "revenue-smooth-area": "展示连续收入变化与派生的主要指标。",
  "active-users-heatmap": "比较不同日期与时间段的活跃集中度。",
  "sign-up-funnel": "展示注册流程各阶段的转化与流失。",
  "earned-so-far-bars": "对比累计收入与可选目标或参照值。",
  "contributions-heatmap": "在紧凑周网格中展示长期每日贡献密度。",
  "sessions-conversion-combo": "在同一时间轴对齐 Session 数量与转化趋势。",
  "devices-bars": "通过直接易读的横向条形图表达设备占比。",
  "visitors-stacked-area": "同时展示访问者构成与总量随时间的变化。",
  "activity-rings": "在一个紧凑状态界面中展示多项有界进度。",
};

type ItemId = ChartRecipeName;
type ViewportId = (typeof viewports)[number]["id"];

export function ComponentCanvas() {
  const { locale = "en" } = useI18n();
  const chinese = locale === "zh";
  const [active, setActive] = useState<ItemId>("steps-bars");
  const [viewport, setViewport] = useState<ViewportId>("desktop");
  const [showGrid, setShowGrid] = useState(true);
  const [zoom, setZoom] = useState(88);
  const tabsId = useId();
  const item = items.find((entry) => entry.id === active) ?? items[0]!;
  const viewportOption = viewports.find((entry) => entry.id === viewport) ?? viewports[0];
  const itemText = {
    label: item.label,
    detail: chinese ? chineseDescriptions[item.id] : item.detail,
  };
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
        aria-label={chinese ? "Data Chart Recipe 预览" : "Data Chart recipe previews"}
        className={styles.componentRail}
        data-home-canvas-item
        role="tablist"
      >
        <p>Recipes</p>
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
            <span>{label}</span>
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
            <span>{chinese ? "真实 Renderer" : "Live renderer"} / {itemText.label}</span>
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
              <span>{chinese ? "Schema 约束" : "Schema bound"}</span>
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
              <span className={styles.canvasFrameLabel}>data.chart / {itemText.label}</span>
              <span aria-hidden="true" className={styles.canvasHandle} data-corner="north-west" />
              <span aria-hidden="true" className={styles.canvasHandle} data-corner="north-east" />
              <span aria-hidden="true" className={styles.canvasHandle} data-corner="south-west" />
              <span aria-hidden="true" className={styles.canvasHandle} data-corner="south-east" />
              <div aria-live="polite" className={styles.componentPreview} key={active}>
                <ChartRecipeDemo recipeName={item.recipeName} />
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
