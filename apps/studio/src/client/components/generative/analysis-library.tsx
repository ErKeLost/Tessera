"use client";

/**
 * Tessera's analysis view library.
 *
 * The prop contracts come from the shared, framework-free spec module so the
 * model contract compiled on the server and the renderers below can never
 * drift. Every renderer is presentation-only: it draws the values it is given
 * and refuses to infer anything a tool did not return.
 */
import { createLibrary, defineComponent, type ComponentRenderer } from "@openuidev/react-lang";
import { AlertTriangleIcon, InfoIcon, ShieldAlertIcon, TrendingUpIcon } from "lucide-react";
import type { ReactNode } from "react";
import { z } from "zod";
import {
  ANALYSIS_ROOT_COMPONENT,
  analysisLeafSpecs,
  analysisTones,
  buildAnalysisLayoutSpecs,
  type AnalysisTone,
} from "../../../generative/analysis-components";

const gapClass = { tight: "is-tight", normal: "is-normal", loose: "is-loose" } as const;
type Gap = keyof typeof gapClass;

/**
 * Skipped positional arguments arrive as `null`, not `undefined`. Every
 * optional prop goes through these normalizers so a skipped argument never
 * renders the word "null" and never throws.
 */
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalList<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? value as readonly T[] : [];
}

function optionalCount(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function optionalTone(value: unknown): AnalysisTone {
  return typeof value === "string" && (analysisTones as readonly string[]).includes(value)
    ? value as AnalysisTone
    : "neutral";
}

function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : "—";
}

function withUnit(value: unknown, unit: string | undefined): string {
  const formatted = formatNumber(value);
  return unit === undefined ? formatted : `${formatted} ${unit}`;
}

/** Bars scale against the largest absolute value in the series. */
function barPercent(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || maximum <= 0) return 0;
  return Math.max(Math.abs(value) / maximum * 100, 1.5);
}

function maximumOf(values: readonly unknown[]): number {
  return values.reduce<number>(
    (maximum, value) => (typeof value === "number" && Number.isFinite(value)
      ? Math.max(maximum, Math.abs(value))
      : maximum),
    0,
  );
}

const Stack: ComponentRenderer<{ children?: unknown; gap?: Gap }> = ({ props, renderNode }) => (
  <div className={`tessera-analysis-stack ${gapClass[props.gap ?? "normal"] ?? gapClass.normal}`}>
    {optionalList(props.children).map((child, index) => (
      <div className="tessera-analysis-block" key={index}>{renderNode(child)}</div>
    ))}
  </div>
);

const Grid: ComponentRenderer<{ children?: unknown; columns?: number }> = ({ props, renderNode }) => (
  <div
    className="tessera-analysis-grid"
    style={{ ["--tessera-analysis-columns" as string]: String(optionalCount(props.columns, 2, 1, 4)) }}
  >
    {optionalList(props.children).map((child, index) => (
      <div className="tessera-analysis-block" key={index}>{renderNode(child)}</div>
    ))}
  </div>
);

const Section: ComponentRenderer<{ title: string; children?: unknown; description?: string }> = ({ props, renderNode }) => {
  const description = optionalText(props.description);
  return (
    <section className="tessera-analysis-section">
      <header className="tessera-analysis-section-header">
        <h4 className="tessera-analysis-section-title">{props.title}</h4>
        {description === undefined ? null : (
          <p className="tessera-analysis-section-description">{description}</p>
        )}
      </header>
      <div className="tessera-analysis-stack is-normal">
        {optionalList(props.children).map((child, index) => (
          <div className="tessera-analysis-block" key={index}>{renderNode(child)}</div>
        ))}
      </div>
    </section>
  );
};

const Metric: ComponentRenderer<{ label: string; value: string; delta?: string; hint?: string; tone?: AnalysisTone }> = ({ props }) => {
  const delta = optionalText(props.delta);
  const hint = optionalText(props.hint);
  return (
    <div className="tessera-analysis-metric" data-tone={optionalTone(props.tone)}>
      <p className="tessera-analysis-metric-label">{props.label}</p>
      <p className="tessera-analysis-metric-value">{props.value}</p>
      {delta === undefined ? null : (
        <p className="tessera-analysis-metric-delta">
          <TrendingUpIcon aria-hidden="true" size={13} />
          {delta}
        </p>
      )}
      {hint === undefined ? null : <p className="tessera-analysis-metric-hint">{hint}</p>}
    </div>
  );
};

const Table: ComponentRenderer<{ title: string; columns?: unknown; rows?: unknown; note?: string }> = ({ props }) => {
  const columns = optionalList<string>(props.columns);
  const rows = optionalList<string[]>(props.rows);
  const note = optionalText(props.note);
  const aligned = rows.every((row) => Array.isArray(row) && row.length === columns.length);
  return (
    <figure className="tessera-analysis-figure">
      <figcaption className="tessera-analysis-figure-title">{props.title}</figcaption>
      {aligned && columns.length > 0 ? (
        <div className="tessera-analysis-table-scroll">
          <table className="tessera-analysis-table">
            <thead>
              <tr>
                {columns.map((column, index) => <th key={index} scope="col">{column}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="tessera-analysis-invalid" role="status">
          Rows do not match the {columns.length} columns, so this table was not rendered.
        </p>
      )}
      {note === undefined ? null : <p className="tessera-analysis-note">{note}</p>}
    </figure>
  );
};

const BarChart: ComponentRenderer<{ title: string; categories?: unknown; values?: unknown; unit?: string; note?: string }> = ({ props }) => {
  const categories = optionalList<string>(props.categories);
  const values = optionalList<number>(props.values);
  const unit = optionalText(props.unit);
  const note = optionalText(props.note);
  const aligned = categories.length > 0 && categories.length === values.length;
  const maximum = maximumOf(values);
  return (
    <figure className="tessera-analysis-figure">
      <figcaption className="tessera-analysis-figure-title">{props.title}</figcaption>
      {aligned ? (
        <div className="tessera-analysis-bars" role="img" aria-label={`${props.title}: ${categories.length} categories`}>
          {categories.map((category, index) => (
            <div className="tessera-analysis-bar-column" key={index}>
              <span className="tessera-analysis-bar-value">{formatNumber(values[index])}</span>
              <div className="tessera-analysis-bar-track">
                <div className="tessera-analysis-bar" style={{ height: `${barPercent(values[index], maximum)}%` }} />
              </div>
              <span className="tessera-analysis-bar-label" title={category}>{category}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="tessera-analysis-invalid" role="status">
          {categories.length} categories and {values.length} values do not line up, so this chart was not rendered.
        </p>
      )}
      {unit === undefined ? null : <p className="tessera-analysis-note">Unit: {unit}</p>}
      {note === undefined ? null : <p className="tessera-analysis-note">{note}</p>}
    </figure>
  );
};

const LINE_VIEWBOX = { width: 100, height: 40, inset: 3 } as const;

function linePath(values: readonly number[]): string {
  if (values.length === 0) return "";
  const finite = values.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : 0));
  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  const span = maximum - minimum || 1;
  const plotHeight = LINE_VIEWBOX.height - LINE_VIEWBOX.inset * 2;
  return finite.map((value, index) => {
    const x = finite.length === 1 ? LINE_VIEWBOX.width / 2 : index / (finite.length - 1) * LINE_VIEWBOX.width;
    const y = LINE_VIEWBOX.inset + (1 - (value - minimum) / span) * plotHeight;
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

const LineChart: ComponentRenderer<{ title: string; categories?: unknown; values?: unknown; unit?: string; note?: string }> = ({ props }) => {
  const categories = optionalList<string>(props.categories);
  const values = optionalList<number>(props.values);
  const unit = optionalText(props.unit);
  const note = optionalText(props.note);
  const aligned = categories.length > 0 && categories.length === values.length;
  const path = aligned ? linePath(values) : "";
  return (
    <figure className="tessera-analysis-figure">
      <figcaption className="tessera-analysis-figure-title">{props.title}</figcaption>
      {aligned && path.length > 0 ? (
        <>
          <svg
            aria-label={`${props.title}: trend across ${categories.length} buckets`}
            className="tessera-analysis-line"
            preserveAspectRatio="none"
            role="img"
            viewBox={`0 0 ${LINE_VIEWBOX.width} ${LINE_VIEWBOX.height}`}
          >
            <path className="tessera-analysis-line-path" d={path} vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="tessera-analysis-line-axis">
            {categories.map((category, index) => (
              <span className="tessera-analysis-bar-label" key={index} title={category}>{category}</span>
            ))}
          </div>
        </>
      ) : (
        <p className="tessera-analysis-invalid" role="status">
          {aligned
            ? "This trend has no points, so this chart was not rendered."
            : `${categories.length} buckets and ${values.length} values do not line up, so this chart was not rendered.`}
        </p>
      )}
      {unit === undefined ? null : <p className="tessera-analysis-note">Unit: {unit}</p>}
      {note === undefined ? null : <p className="tessera-analysis-note">{note}</p>}
    </figure>
  );
};

const Ranking: ComponentRenderer<{ title: string; labels?: unknown; values?: unknown; unit?: string; note?: string }> = ({ props }) => {
  const labels = optionalList<string>(props.labels);
  const values = optionalList<number>(props.values);
  const unit = optionalText(props.unit);
  const note = optionalText(props.note);
  const aligned = labels.length > 0 && labels.length === values.length;
  const maximum = maximumOf(values);
  return (
    <figure className="tessera-analysis-figure">
      <figcaption className="tessera-analysis-figure-title">{props.title}</figcaption>
      {aligned ? (
        <ol className="tessera-analysis-ranking">
          {labels.map((label, index) => (
            <li className="tessera-analysis-ranking-item" key={index}>
              <span className="tessera-analysis-ranking-label" title={label}>{label}</span>
              <span aria-hidden="true" className="tessera-analysis-ranking-track">
                <span className="tessera-analysis-ranking-bar" style={{ width: `${barPercent(values[index], maximum)}%` }} />
              </span>
              <span className="tessera-analysis-ranking-value">{withUnit(values[index], unit)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="tessera-analysis-invalid" role="status">
          {labels.length} labels and {values.length} values do not line up, so this ranking was not rendered.
        </p>
      )}
      {note === undefined ? null : <p className="tessera-analysis-note">{note}</p>}
    </figure>
  );
};

const Insight: ComponentRenderer<{ title: string; summary: string; points?: string[]; tone?: AnalysisTone }> = ({ props }) => {
  const points = optionalList<string>(props.points).filter((point) => typeof point === "string" && point.trim().length > 0);
  return (
    <div className="tessera-analysis-insight" data-tone={optionalTone(props.tone)}>
      <p className="tessera-analysis-insight-title">{props.title}</p>
      <p className="tessera-analysis-insight-summary">{props.summary}</p>
      {points.length === 0 ? null : (
        <ul className="tessera-analysis-insight-points">
          {points.map((point, index) => <li key={index}>{point}</li>)}
        </ul>
      )}
    </div>
  );
};

const calloutIcons: Record<AnalysisTone, ReactNode> = {
  neutral: <InfoIcon aria-hidden="true" size={15} />,
  positive: <TrendingUpIcon aria-hidden="true" size={15} />,
  warning: <AlertTriangleIcon aria-hidden="true" size={15} />,
  critical: <ShieldAlertIcon aria-hidden="true" size={15} />,
};

const Callout: ComponentRenderer<{ tone?: AnalysisTone; title: string; body: string }> = ({ props }) => {
  const tone = optionalTone(props.tone);
  return (
    <div className="tessera-analysis-callout" data-tone={tone} role="note">
      <span className="tessera-analysis-callout-icon">{calloutIcons[tone]}</span>
      <div>
        <p className="tessera-analysis-callout-title">{props.title}</p>
        <p className="tessera-analysis-callout-body">{props.body}</p>
      </div>
    </div>
  );
};

const renderers: Record<string, ComponentRenderer<never>> = {
  Stack: Stack as ComponentRenderer<never>,
  Grid: Grid as ComponentRenderer<never>,
  Section: Section as ComponentRenderer<never>,
  Metric: Metric as ComponentRenderer<never>,
  Table: Table as ComponentRenderer<never>,
  Ranking: Ranking as ComponentRenderer<never>,
  BarChart: BarChart as ComponentRenderer<never>,
  LineChart: LineChart as ComponentRenderer<never>,
  Insight: Insight as ComponentRenderer<never>,
  Callout: Callout as ComponentRenderer<never>,
};

function buildAnalysisLibrary() {
  const leaves = analysisLeafSpecs.map((spec) => defineComponent({
    name: spec.name,
    props: spec.props,
    description: spec.description,
    component: renderers[spec.name] as ComponentRenderer<z.infer<typeof spec.props>>,
  }));

  const block = z.union(leaves.map((leaf) => leaf.ref));
  const layouts = buildAnalysisLayoutSpecs(block).map((spec) => defineComponent({
    name: spec.name,
    props: spec.props,
    description: spec.description,
    component: renderers[spec.name] as ComponentRenderer<z.infer<typeof spec.props>>,
  }));

  return createLibrary({
    id: "tessera-analysis",
    root: ANALYSIS_ROOT_COMPONENT,
    components: [...layouts, ...leaves],
    componentGroups: [
      { name: "Layout", components: ["Stack", "Grid", "Section"] },
      { name: "Data", components: ["Metric", "Table", "Ranking", "BarChart", "LineChart"] },
      { name: "Narrative", components: ["Insight", "Callout"] },
    ],
  });
}

/** Built once at module scope; parsers memoize by library identity. */
export const tesseraAnalysisLibrary = buildAnalysisLibrary();
