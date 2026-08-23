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
import { DataChartDemo } from "@/components/generative-gallery";
import {
  dataChartFixtureDocumentation,
  generativeGalleryConformanceDescriptors,
  type DataChartFixtureName,
} from "@/components/generative-gallery-model";
import styles from "./home.module.css";
import { localizedPath } from "@/lib/i18n";

const items = generativeGalleryConformanceDescriptors.map(descriptor => ({
  id: descriptor.value,
  fixtureName: descriptor.value,
  label: dataChartFixtureDocumentation[descriptor.value].title,
  detail: dataChartFixtureDocumentation[descriptor.value].description,
  href: "/docs/components/generative-ui-catalog",
  icon: ChartNoAxesCombinedIcon,
}));

const viewports = [
  { id: "desktop", label: "Desktop preview", size: "Flexible", icon: LaptopIcon },
  { id: "tablet", label: "Tablet preview", size: "768 px", icon: TabletIcon },
  { id: "mobile", label: "Mobile preview", size: "390 px", icon: SmartphoneIcon },
] as const;

const chineseDescriptions: Readonly<Record<DataChartFixtureName, string>> = {
  "data-chart.categorical-bar": "使用明确的定量度量比较分类数据。",
  "data-chart.temporal-line": "使用时间 x 编码和定量 y 编码展示时间序列。",
  "data-chart.stacked-area": "使用分类颜色编码展示分组时间序列。",
  "data-chart.correlation-scatter": "使用可选的颜色和尺寸编码展示定量关系。",
  "data-chart.share-pie": "使用定量角度编码展示分类占比。",
  "data-chart.profile-radar": "使用可比较的定量半径展示分类画像。",
};

type ItemId = DataChartFixtureName;
type ViewportId = (typeof viewports)[number]["id"];

export function ComponentCanvas() {
  const { locale = "en" } = useI18n();
  const chinese = locale === "zh";
  const [active, setActive] = useState<ItemId>("data-chart.categorical-bar");
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
        aria-label={chinese ? "Data Chart grammar 预览" : "Data Chart grammar previews"}
        className={styles.componentRail}
        data-home-canvas-item
        role="tablist"
      >
        <p>Grammar</p>
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
                <DataChartDemo fixtureName={item.fixtureName} />
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
