"use client";

import type {
  DataChartCellValue,
  DataChartField,
  DataChartMetric,
  ResolvedDataChart,
  ResolvedDataChartSpec,
} from "@open-generative/components";
import type { JsonObject } from "@open-generative/protocol";
import type { RendererInput } from "@open-generative/react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  Radar,
  RadarChart,
  PolarAngleAxis,
  PolarGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { useSyncExternalStore, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { ChartContainer, type ChartConfig } from "../components/ui/chart";
import { asFiniteNumber, formatValue } from "./format";

export type ResolvedChartDataModel = ResolvedDataChart;
export type UIResolvedChartSpec = ResolvedDataChartSpec & JsonObject;
export type DataChartResolvedProps = JsonObject & Readonly<{ spec: UIResolvedChartSpec }>;
export type DataChartRendererInput = RendererInput<DataChartResolvedProps>;
export type ChartInput = DataChartRendererInput;
export type ResolvedChartProps = Readonly<{ input: ChartInput; spec: UIResolvedChartSpec }>;

type DataRow = Record<string, DataChartCellValue>;
type Series = Readonly<{ color: string; key: string; label: string }>;
type CartesianProjection = Readonly<{ data: Record<string, DataChartCellValue>[]; series: readonly Series[]; xKey: string }>;

const COLORS = [
  "var(--og-chart-1)",
  "var(--og-chart-2)",
  "var(--og-chart-3)",
  "var(--og-chart-4)",
  "var(--og-chart-5)",
] as const;
const AXIS_TICK = { fill: "var(--og-muted-foreground)", fontSize: 11 } as const;
const subscribeHydration = () => () => undefined;

/**
 * One renderer for every Data Chart mark. It consumes the public grammar;
 * there are no domain recipes, copied labels, or row-count assumptions here.
 */
export function DataChartRenderer(input: ChartInput) {
  const { spec } = input.resolvedProps;
  return (
    <div className="og-chart-host">
      <section
        aria-label={spec.accessibility.label}
        className="og-ui og-chart-surface og-data-chart-surface"
        data-chart-mark={spec.mark}
        data-og-component="data.chart"
        data-og-renderer="grammar"
      >
        <ResolvedChart input={input} spec={spec} />
      </section>
    </div>
  );
}

export function ResolvedChart({ spec }: ResolvedChartProps) {
  const rows = spec.data.rows.map((row) => ({ ...row }));
  return (
    <figure
      className="og-chart og-data-chart"
      data-chart-stable-size="true"
      data-reduced-motion="disable-animation"
      data-renderer-kind="recharts"
      data-semantic-elements="title metric plot tooltip equivalent-view"
    >
      {rows.length === 0 ? <EmptyChart title={spec.title} /> : <ChartCard rows={rows} spec={spec} />}
      <EquivalentDataTable spec={spec} />
    </figure>
  );
}

function ChartCard({ rows, spec }: { rows: DataRow[]; spec: UIResolvedChartSpec }) {
  const config = chartConfig(spec, rows);
  return (
    <Card className="og-data-chart-card">
      <CardHeader className="og-data-chart-header">
        <div className="og-data-chart-heading">
          <CardTitle>{spec.title}</CardTitle>
          {spec.subtitle ? <p>{spec.subtitle}</p> : null}
        </div>
        {spec.summary?.length ? (
          <dl className="og-data-chart-summary">
            {spec.summary.map((metric) => (
              <div key={`${metric.field}-${metric.aggregate}`}>
                <dt>{metric.label ?? columnLabel(spec, metric.field)}</dt>
                <dd>{formatValue(metricValue(rows, metric), metric.format)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </CardHeader>
      <CardContent className="og-data-chart-content">
        <ChartContainer aria-label={spec.accessibility.label} className="og-data-chart-plot" config={config} role="img">
          <ClientChartProjection server={<ChartProjection rows={rows} spec={spec} />}>
            <ResponsiveContainer height="100%" width="100%">
              <InteractiveChart rows={rows} spec={spec} />
            </ResponsiveContainer>
          </ClientChartProjection>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function InteractiveChart({ rows, spec }: { rows: DataRow[]; spec: UIResolvedChartSpec }) {
  switch (spec.mark) {
    case "bar": return <BarMark rows={rows} spec={spec} />;
    case "line": return <LineMark rows={rows} spec={spec} />;
    case "area": return <AreaMark rows={rows} spec={spec} />;
    case "scatter": return <ScatterMark rows={rows} spec={spec} />;
    case "pie": return <PieMark rows={rows} spec={spec} />;
    case "radar": return <RadarMark rows={rows} spec={spec} />;
  }
}

function BarMark({ rows, spec }: { rows: DataRow[]; spec: Extract<UIResolvedChartSpec, { mark: "bar" }> }) {
  const projection = cartesianProjection(rows, spec);
  const horizontal = spec.options.orientation === "horizontal";
  return (
    <BarChart data={projection.data} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 12, right: 12, bottom: 4, left: 4 }}>
      {spec.options.grid ? <CartesianGrid stroke="var(--og-chart-grid)" strokeDasharray="3 5" vertical={!horizontal} /> : null}
      {horizontal ? (
        <>
          <XAxis axisLine={false} tick={AXIS_TICK} tickLine={false} type="number" />
          <YAxis axisLine={false} dataKey={projection.xKey} tick={AXIS_TICK} tickFormatter={(value) => formatFieldValue(value, spec.x)} tickLine={false} type="category" width={96} />
        </>
      ) : (
        <>
          <XAxis axisLine={false} dataKey={projection.xKey} minTickGap={20} tick={AXIS_TICK} tickFormatter={(value) => formatFieldValue(value, spec.x)} tickLine={false} />
          <YAxis axisLine={false} tick={AXIS_TICK} tickFormatter={(value) => formatFieldValue(value, spec.y)} tickLine={false} width={56} />
        </>
      )}
      {tooltip(spec)}
      {legend(spec, projection.series.length)}
      {projection.series.map((series) => (
        <Bar
          dataKey={series.key}
          fill={series.color}
          isAnimationActive={false}
          key={series.key}
          name={series.label}
          radius={[4, 4, 0, 0]}
          stackId={spec.options.stack === "none" ? undefined : "chart"}
        />
      ))}
    </BarChart>
  );
}

function LineMark({ rows, spec }: { rows: DataRow[]; spec: Extract<UIResolvedChartSpec, { mark: "line" }> }) {
  const projection = cartesianProjection(rows, spec);
  return (
    <LineChart data={projection.data} margin={{ top: 12, right: 12, bottom: 4, left: 4 }}>
      {spec.options.grid ? <CartesianGrid stroke="var(--og-chart-grid)" strokeDasharray="3 5" vertical={false} /> : null}
      <XAxis axisLine={false} dataKey={projection.xKey} minTickGap={20} tick={AXIS_TICK} tickFormatter={(value) => formatFieldValue(value, spec.x)} tickLine={false} />
      <YAxis axisLine={false} tick={AXIS_TICK} tickFormatter={(value) => formatFieldValue(value, spec.y)} tickLine={false} width={56} />
      {tooltip(spec)}
      {legend(spec, projection.series.length)}
      {projection.series.map((series) => <Line connectNulls dataKey={series.key} dot={false} isAnimationActive={false} key={series.key} name={series.label} stroke={series.color} strokeWidth={2.5} type={spec.options.curve} />)}
    </LineChart>
  );
}

function AreaMark({ rows, spec }: { rows: DataRow[]; spec: Extract<UIResolvedChartSpec, { mark: "area" }> }) {
  const projection = cartesianProjection(rows, spec);
  return (
    <AreaChart data={projection.data} margin={{ top: 12, right: 12, bottom: 4, left: 4 }}>
      {spec.options.grid ? <CartesianGrid stroke="var(--og-chart-grid)" strokeDasharray="3 5" vertical={false} /> : null}
      <XAxis axisLine={false} dataKey={projection.xKey} minTickGap={20} tick={AXIS_TICK} tickFormatter={(value) => formatFieldValue(value, spec.x)} tickLine={false} />
      <YAxis axisLine={false} tick={AXIS_TICK} tickFormatter={(value) => formatFieldValue(value, spec.y)} tickLine={false} width={56} />
      {tooltip(spec)}
      {legend(spec, projection.series.length)}
      {projection.series.map((series) => <Area connectNulls dataKey={series.key} fill={series.color} fillOpacity={0.16} isAnimationActive={false} key={series.key} name={series.label} stackId={spec.options.stack === "none" ? undefined : "chart"} stroke={series.color} strokeWidth={2.25} type={spec.options.curve} />)}
    </AreaChart>
  );
}

function ScatterMark({ rows, spec }: { rows: DataRow[]; spec: Extract<UIResolvedChartSpec, { mark: "scatter" }> }) {
  const groups = seriesGroups(rows, spec.color);
  return (
    <ScatterChart margin={{ top: 12, right: 16, bottom: 4, left: 4 }}>
      {spec.options.grid ? <CartesianGrid stroke="var(--og-chart-grid)" strokeDasharray="3 5" /> : null}
      <XAxis axisLine={false} dataKey={spec.x.field} name={fieldLabel(spec.x, spec)} tick={AXIS_TICK} tickLine={false} type="number" />
      <YAxis axisLine={false} dataKey={spec.y.field} name={fieldLabel(spec.y, spec)} tick={AXIS_TICK} tickLine={false} type="number" width={56} />
      {spec.size ? <ZAxis dataKey={spec.size.field} range={[32, 280]} /> : null}
      {tooltip(spec)}
      {legend(spec, groups.length)}
      {groups.map((group, index) => <Scatter data={group.rows} fill={COLORS[index % COLORS.length]!} key={group.label} name={group.label} />)}
    </ScatterChart>
  );
}

function PieMark({ rows, spec }: { rows: DataRow[]; spec: Extract<UIResolvedChartSpec, { mark: "pie" }> }) {
  const data = rows.map((row, index) => ({
    name: formatFieldValue(row[spec.color.field], spec.color),
    value: numeric(row[spec.theta.field]),
    fill: COLORS[index % COLORS.length]!,
  }));
  return (
    <PieChart>
      <Pie data={data} dataKey="value" innerRadius={spec.options.donut ? "55%" : 0} isAnimationActive={false} nameKey="name" outerRadius="78%">
        {data.map((entry) => <Cell fill={entry.fill} key={entry.name} />)}
      </Pie>
      {tooltip(spec)}
      {legend(spec, data.length)}
    </PieChart>
  );
}

function RadarMark({ rows, spec }: { rows: DataRow[]; spec: Extract<UIResolvedChartSpec, { mark: "radar" }> }) {
  const projection = cartesianProjection(rows, { x: spec.angle, y: spec.radius, color: spec.color });
  return (
    <RadarChart data={projection.data} margin={{ top: 12, right: 30, bottom: 12, left: 30 }}>
      <PolarGrid stroke="var(--og-chart-grid)" />
      <PolarAngleAxis dataKey={projection.xKey} tick={AXIS_TICK} tickFormatter={(value) => formatFieldValue(value, spec.angle)} />
      {tooltip(spec)}
      {legend(spec, projection.series.length)}
      {projection.series.map((series) => <Radar dataKey={series.key} fill={series.color} fillOpacity={0.18} isAnimationActive={false} key={series.key} name={series.label} stroke={series.color} strokeWidth={2} />)}
    </RadarChart>
  );
}

function ChartProjection({ rows, spec }: { rows: DataRow[]; spec: UIResolvedChartSpec }) {
  const labels = visibleLabels(rows, spec).slice(0, 12);
  const maximum = Math.max(...rows.map((row) => primaryValue(row, spec)), 1);
  return (
    <svg aria-hidden="true" className="og-server-chart" viewBox="0 0 720 252">
      {[0, 1, 2, 3].map((index) => {
        const y = 20 + index * 58;
        return <line key={index} stroke="var(--og-chart-grid)" strokeDasharray="3 5" x1="44" x2="702" y1={y} y2={y} />;
      })}
      {labels.map((label, index) => {
        const value = primaryValue(label.row, spec);
        const step = 658 / Math.max(labels.length, 1);
        const x = 44 + index * step + step * 0.18;
        const width = Math.max(4, step * 0.64);
        const height = Math.max(1, value / maximum * 174);
        return (
          <g key={`${label.label}-${index}`}>
            <rect fill={COLORS[index % COLORS.length]!} height={height} rx="4" width={width} x={x} y={194 - height} />
            <text className="og-data-chart-fallback-label" textAnchor="middle" x={x + width / 2} y="220">{truncate(label.label, 13)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function ClientChartProjection({ children, server }: { children: ReactNode; server: ReactNode }) {
  const hydrated = useSyncExternalStore(subscribeHydration, () => true, () => false);
  return hydrated ? children : server;
}

function cartesianProjection(
  rows: DataRow[],
  spec: Readonly<{ x: DataChartField; y: DataChartField; color?: DataChartField }>,
): CartesianProjection {
  const xKey = "__og_x";
  if (spec.color === undefined) {
    return {
      data: rows.map((row) => ({ [xKey]: row[spec.x.field] ?? null, [spec.y.field]: row[spec.y.field] ?? null })),
      series: [{ key: spec.y.field, label: fieldLabel(spec.y, undefined), color: COLORS[0] }],
      xKey,
    };
  }

  const groups = new Map<string, { key: string; label: string }>();
  const points = new Map<string, Record<string, DataChartCellValue>>();
  const order: string[] = [];
  for (const row of rows) {
    const xValue = row[spec.x.field] ?? null;
    const xIdentity = JSON.stringify(xValue);
    let point = points.get(xIdentity);
    if (point === undefined) {
      point = { [xKey]: xValue };
      points.set(xIdentity, point);
      order.push(xIdentity);
    }
    const label = String(row[spec.color.field] ?? "-");
    let group = groups.get(label);
    if (group === undefined) {
      group = { key: `__og_series_${groups.size}`, label };
      groups.set(label, group);
    }
    point[group.key] = row[spec.y.field] ?? null;
  }
  return {
    data: order.map((key) => points.get(key)!),
    series: [...groups.values()].map((group, index) => ({ ...group, color: COLORS[index % COLORS.length]! })),
    xKey,
  };
}

function seriesGroups(rows: DataRow[], color: DataChartField | undefined): readonly { label: string; rows: DataRow[] }[] {
  if (color === undefined) return [{ label: "Values", rows }];
  const grouped = new Map<string, DataRow[]>();
  for (const row of rows) {
    const label = String(row[color.field] ?? "-");
    const values = grouped.get(label) ?? [];
    values.push(row);
    grouped.set(label, values);
  }
  return [...grouped].map(([label, groupRows]) => ({ label, rows: groupRows }));
}

function chartConfig(spec: UIResolvedChartSpec, rows: DataRow[]): ChartConfig {
  if (spec.mark === "pie") {
    return Object.fromEntries(rows.map((row, index) => [
      String(row[spec.color.field] ?? index),
      { color: COLORS[index % COLORS.length]!, label: formatFieldValue(row[spec.color.field], spec.color) },
    ]));
  }
  const y = spec.mark === "radar" ? spec.radius : spec.y;
  const color = spec.mark === "radar" ? spec.color : spec.color;
  const projection = cartesianProjection(rows, { x: spec.mark === "radar" ? spec.angle : spec.x, y, color });
  return Object.fromEntries(projection.series.map((series) => [series.key, { color: series.color, label: series.label }]));
}

function tooltip(spec: UIResolvedChartSpec): ReactNode {
  return spec.tooltip.mode === "none" ? null : <Tooltip cursor={{ fill: "var(--og-chart-hover)" }} />;
}

function legend(spec: UIResolvedChartSpec, seriesCount: number): ReactNode {
  const options = spec.options;
  return options.legend === "auto" && seriesCount > 1 ? <Legend /> : null;
}

function visibleLabels(rows: DataRow[], spec: UIResolvedChartSpec): readonly { label: string; row: DataRow }[] {
  const field = spec.mark === "pie" ? spec.color : spec.mark === "radar" ? spec.angle : spec.x;
  return rows.map((row) => ({ label: formatFieldValue(row[field.field], field), row }));
}

function primaryValue(row: DataRow, spec: UIResolvedChartSpec): number {
  const field = spec.mark === "pie" ? spec.theta : spec.mark === "radar" ? spec.radius : spec.y;
  return numeric(row[field.field]);
}

function metricValue(rows: DataRow[], metric: DataChartMetric): DataChartCellValue | undefined {
  const values = rows.map((row) => row[metric.field]).filter((value): value is DataChartCellValue => value !== undefined);
  if (metric.aggregate === "count") return values.length;
  if (metric.aggregate === "distinct-count") return new Set(values.map((value) => JSON.stringify(value))).size;
  if (metric.aggregate === "first") return values[0];
  if (metric.aggregate === "last") return values.at(-1);
  const numbers = values.map(asFiniteNumber).filter((value): value is number => value !== undefined);
  if (numbers.length === 0) return undefined;
  if (metric.aggregate === "sum") return numbers.reduce((sum, value) => sum + value, 0);
  if (metric.aggregate === "average") return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  if (metric.aggregate === "minimum") return Math.min(...numbers);
  return Math.max(...numbers);
}

function formatFieldValue(value: DataChartCellValue | undefined, field: DataChartField): string {
  if (field.type !== "temporal") return formatValue(value, field.format);
  if (typeof value === "string" && /^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year!, month! - 1, 1)));
  }
  return formatValue(value, field.format ?? { kind: "date", dateStyle: field.timeUnit === "month" ? "medium" : "short" });
}

function fieldLabel(field: DataChartField, spec: UIResolvedChartSpec | undefined): string {
  return field.title ?? (spec === undefined ? field.field : columnLabel(spec, field.field));
}

function columnLabel(spec: UIResolvedChartSpec, field: string): string {
  return spec.data.columns.find((column) => column.columnId === field)?.label ?? field;
}

function numeric(value: DataChartCellValue | undefined): number {
  return asFiniteNumber(value) ?? 0;
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, Math.max(1, length - 3))}...` : value;
}

function EmptyChart({ title }: { title: string }) {
  return <div className="og-chart-empty" role="status"><strong>{title}</strong><span>No data available</span></div>;
}

function EquivalentDataTable({ spec }: { spec: UIResolvedChartSpec }) {
  return (
    <div className="og-sr-only" data-equivalent-view="table">
      <table>
        <caption>{spec.title} data</caption>
        <thead><tr>{spec.data.columns.map((column) => <th key={column.columnId}>{column.label}</th>)}</tr></thead>
        <tbody>{spec.data.rows.map((row, rowIndex) => <tr key={rowIndex}>{spec.data.columns.map((column) => <td key={column.columnId}>{formatValue(row[column.columnId])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
