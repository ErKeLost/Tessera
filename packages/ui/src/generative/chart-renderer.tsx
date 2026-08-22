"use client";

import type {
  ChartCellValue,
  ChartSeries,
  FormatToken,
  ResolvedChartSpec,
} from "@open-generative/components";
import type {
  JsonObject,
} from "@open-generative/protocol";
import type { RendererInput } from "@open-generative/react";
import {
  Activity,
  Calendar,
  Circle,
  Database,
  DollarSign,
  Percent,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useId, type ReactNode } from "react";
import { canEmit, emitEvent, officialRendererEventPorts } from "./events";
import { asFiniteNumber, formatValue } from "./format";
import { EmptyState, Surface, classes } from "./primitives";

export type ResolvedChartDataModel = Readonly<{
  columns: readonly Readonly<{
    columnId: string;
    label: string;
    valueType: "boolean" | "date" | "datetime" | "number" | "string";
  }>[];
  rows: readonly Readonly<Record<string, ChartCellValue>>[];
  totalRows?: number;
}>;
export type WithResolvedChartData<T> = T extends unknown
  ? Omit<T, "data"> & Readonly<{ data: ResolvedChartDataModel }>
  : never;
export type UIResolvedChartSpec = WithResolvedChartData<ResolvedChartSpec> & JsonObject;
export type DataChartResolvedProps = JsonObject & Readonly<{ spec: UIResolvedChartSpec }>;
export type DataChartRendererInput = RendererInput<DataChartResolvedProps>;
export type ChartInput = DataChartRendererInput;
type AreaSpec = Extract<UIResolvedChartSpec, { family: "area" }>;
type BarSpec = Extract<UIResolvedChartSpec, { family: "bar" }>;
type LineSpec = Extract<UIResolvedChartSpec, { family: "line" }>;
type PieSpec = Extract<UIResolvedChartSpec, { family: "pie" }>;
type RadarSpec = Extract<UIResolvedChartSpec, { family: "radar" }>;
type RadialSpec = Extract<UIResolvedChartSpec, { family: "radial" }>;
type DataRow = Record<string, ChartCellValue>;

const heightPixels = { sm: 240, md: 320, lg: 400 } as const;
const chartFallbackColors = ["#2563eb", "#0f766e", "#7c3aed", "#ca8a04", "#dc2626"] as const;
const chartIconMap: Record<NonNullable<ChartSeries["iconToken"]>, LucideIcon> = {
  activity: Activity,
  calendar: Calendar,
  circle: Circle,
  database: Database,
  "dollar-sign": DollarSign,
  percent: Percent,
  "trending-down": TrendingDown,
  "trending-up": TrendingUp,
};

export type ResolvedChartProps = Readonly<{
  input: ChartInput;
  spec: UIResolvedChartSpec;
}>;

export function DataChartRenderer(input: ChartInput) {
  const { spec } = input.resolvedProps;
  return (
    <Surface className="og-chart-surface" data-og-component="data.chart" role="region">
      {input.slots.toolbar?.length ? <div className="og-data-toolbar"><div className="og-data-toolbar-slot">{input.slots.toolbar}</div></div> : null}
      <ResolvedChart input={input} spec={spec} />
    </Surface>
  );
}

export function ResolvedChart({ input, spec }: ResolvedChartProps) {
  const presentation = spec.presentation ?? { height: "md" as const, density: "comfortable" as const, animation: "entrance" as const };
  const height = heightPixels[presentation.height];
  const rows = spec.data.rows.map((row) => ({ ...row }));
  const instanceId = safeId(useId());
  const descriptionId = `og-chart-description-${instanceId}`;
  return (
    <figure
      aria-labelledby={descriptionId}
      className={classes("og-chart", `og-chart-${presentation.density}`)}
      data-chart-family={spec.family}
      data-chart-height={presentation.height}
      data-chart-stable-size="true"
      data-event-ports={chartEventPorts(spec).join(" ")}
      data-reduced-motion="disable-animation"
      data-semantic-elements={chartSemanticElements(spec).join(" ")}
    >
      {spec.title || spec.description ? (
        <figcaption className="og-chart-header" id={descriptionId}>
          {spec.title ? <strong>{spec.title}</strong> : null}
          {spec.description ? <p>{spec.description}</p> : null}
        </figcaption>
      ) : <figcaption className="og-sr-only" id={descriptionId}>{spec.accessibility.label}</figcaption>}
      {rows.length === 0 ? (
        <EmptyState description="The host returned an empty data window." title="No chart data" />
      ) : (
        <div
          aria-describedby={spec.accessibility.description ? descriptionId : undefined}
          aria-label={spec.accessibility.label}
          className="og-chart-canvas"
          role="img"
          style={{ height }}
        >
          <ResponsiveContainer
            height="100%"
            initialDimension={{ width: 640, height }}
            minHeight={height}
            minWidth={0}
            width="100%"
          >
            {renderChartFamily(spec, input, rows, instanceId)}
          </ResponsiveContainer>
        </div>
      )}
      <EquivalentChartView spec={spec} />
    </figure>
  );
}

function renderChartFamily(spec: UIResolvedChartSpec, input: ChartInput, rows: DataRow[], instanceId: string): ReactNode {
  switch (spec.family) {
    case "area": return <ResolvedAreaChart input={input} instanceId={instanceId} rows={rows} spec={spec} />;
    case "bar": return <ResolvedBarChart input={input} rows={rows} spec={spec} />;
    case "line": return <ResolvedLineChart input={input} rows={rows} spec={spec} />;
    case "pie": return <ResolvedPieChart input={input} rows={rows} spec={spec} />;
    case "radar": return <ResolvedRadarChart input={input} rows={rows} spec={spec} />;
    case "radial": return <ResolvedRadialChart input={input} rows={rows} spec={spec} />;
  }
}

function ResolvedAreaChart({ input, instanceId, rows, spec }: { input: ChartInput; instanceId: string; rows: DataRow[]; spec: AreaSpec }) {
  const animate = animationSetting(spec);
  return (
    <AreaChart accessibilityLayer data={rows} margin={cartesianMargin(spec)} stackOffset={spec.stack?.mode === "normalized" ? "expand" : undefined}>
      {spec.fill === "gradient" ? (
        <defs>
          {spec.series.map((series, index) => {
            const id = gradientId(instanceId, series);
            const color = seriesColor(series, index);
            return (
              <linearGradient id={id} key={id} x1="0" x2="0" y1="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.38} />
                <stop offset="95%" stopColor={color} stopOpacity={0.03} />
              </linearGradient>
            );
          })}
        </defs>
      ) : null}
      <CartesianGridLayer grid={spec.axes?.grid} />
      <CartesianAxes axes={spec.axes} domainKey={spec.x} />
      <ChartTooltipLayer spec={spec} />
      <ChartLegendLayer input={input} spec={spec} />
      {spec.series.map((series, index) => {
        const color = seriesColor(series, index);
        const visible = isSeriesVisible(spec, series.column);
        return (
          <Area
            activeDot={spec.activeMark ? { r: 5, strokeWidth: 2 } : false}
            dataKey={series.column}
            fill={spec.fill === "gradient" ? `url(#${gradientId(instanceId, series)})` : color}
            fillOpacity={spec.fill === "gradient" ? 1 : 0.18}
            hide={!visible}
            isAnimationActive={animate}
            key={series.column}
            name={series.label ?? columnLabel(spec, series.column)}
            onClick={canEmit(input, officialRendererEventPorts.select)
              ? (datum: unknown) => selectDatum(input, spec, series, datum, spec.x)
              : undefined}
            stackId={stackId(spec, series)}
            stroke={color}
            strokeWidth={2}
            type={spec.curve}
          >
            <ChartLabelList domainKey={spec.x} series={series} spec={spec} />
          </Area>
        );
      })}
      <ChartRangeBrush domainKey={spec.x} input={input} spec={spec} />
    </AreaChart>
  );
}

function ResolvedBarChart({ input, rows, spec }: { input: ChartInput; rows: DataRow[]; spec: BarSpec }) {
  const horizontal = spec.orientation === "horizontal";
  const animate = animationSetting(spec);
  return (
    <BarChart
      accessibilityLayer
      data={rows}
      layout={horizontal ? "vertical" : "horizontal"}
      margin={cartesianMargin(spec)}
      stackOffset={spec.stack?.mode === "normalized" ? "expand" : undefined}
    >
      <CartesianGridLayer grid={spec.axes?.grid} />
      {horizontal ? (
        <>
          <XAxis
            domain={["auto", "auto"]}
            hide={spec.axes?.x?.visible === false}
            label={cartesianAxisLabel(spec.axes?.x?.label, "x")}
            tickFormatter={tickFormatter(spec.axes?.x?.tickFormat)}
            tickCount={spec.axes?.x?.tickCount}
            type="number"
          />
          <YAxis
            dataKey={spec.category}
            hide={spec.axes?.y?.visible === false}
            label={cartesianAxisLabel(spec.axes?.y?.label, "y")}
            tickFormatter={tickFormatter(spec.axes?.y?.tickFormat)}
            type="category"
            width={spec.axes?.y?.label ? 112 : 88}
          />
        </>
      ) : <CartesianAxes axes={spec.axes} domainKey={spec.category} />}
      <ChartTooltipLayer spec={spec} />
      <ChartLegendLayer input={input} spec={spec} />
      {spec.series.map((series, index) => {
        const color = seriesColor(series, index);
        return (
          <Bar
            activeBar={spec.activeMark ? { fillOpacity: 0.86, stroke: color, strokeWidth: 2 } : false}
            dataKey={series.column}
            fill={color}
            hide={!isSeriesVisible(spec, series.column)}
            isAnimationActive={animate}
            key={series.column}
            name={series.label ?? columnLabel(spec, series.column)}
            onClick={canEmit(input, officialRendererEventPorts.select)
              ? (datum: unknown) => selectDatum(input, spec, series, datum, spec.category)
              : undefined}
            radius={barRadius(spec, horizontal)}
            stackId={stackId(spec, series)}
          >
            {spec.colorMode === "series" ? null : rows.map((row, rowIndex) => (
              <Cell fill={barDatumColor(spec, series, index, row, rowIndex)} key={rowIndex} />
            ))}
            <ChartLabelList domainKey={spec.category} series={series} spec={spec} />
          </Bar>
        );
      })}
      <ChartRangeBrush domainKey={spec.category} input={input} spec={spec} />
    </BarChart>
  );
}

function ResolvedLineChart({ input, rows, spec }: { input: ChartInput; rows: DataRow[]; spec: LineSpec }) {
  const animate = animationSetting(spec);
  return (
    <LineChart accessibilityLayer data={rows} margin={cartesianMargin(spec)}>
      <CartesianGridLayer grid={spec.axes?.grid} />
      <CartesianAxes axes={spec.axes} domainKey={spec.x} />
      <ChartTooltipLayer spec={spec} />
      <ChartLegendLayer input={input} spec={spec} />
      {spec.series.map((series, index) => {
        const color = seriesColor(series, index);
        return (
          <Line
            activeDot={spec.activeMark ? { r: 5, strokeWidth: 2 } : { r: 4 }}
            dataKey={series.column}
            dot={lineDot(spec, color)}
            hide={!isSeriesVisible(spec, series.column)}
            isAnimationActive={animate}
            key={series.column}
            name={series.label ?? columnLabel(spec, series.column)}
            onClick={canEmit(input, officialRendererEventPorts.select)
              ? (datum: unknown) => selectDatum(input, spec, series, datum, spec.x)
              : undefined}
            stroke={color}
            strokeWidth={2}
            type={spec.curve}
          >
            <ChartLabelList domainKey={spec.x} series={series} spec={spec} />
          </Line>
        );
      })}
      <ChartRangeBrush domainKey={spec.x} input={input} spec={spec} />
    </LineChart>
  );
}

function ResolvedPieChart({ input, rows, spec }: { input: ChartInput; rows: DataRow[]; spec: PieSpec }) {
  const animate = animationSetting(spec);
  const ringCount = spec.rings === "stacked" ? spec.series.length : 1;
  const renderedSeries = spec.rings === "stacked" ? spec.series : spec.series.slice(0, 1);
  return (
    <PieChart accessibilityLayer margin={{ top: 12, right: 12, bottom: 12, left: 12 }}>
      <ChartTooltipLayer spec={spec} />
      <ChartLegendLayer input={input} spec={spec} />
      {renderedSeries.map((series, seriesIndex) => {
        const radii = pieRadii(spec, seriesIndex, ringCount);
        return (
          <Pie
            activeShape={spec.activeMark || spec.shape === "active-sector" ? { outerRadius: radii.outer + 5 } : undefined}
            cornerRadius={spec.shape === "active-sector" ? 5 : 2}
            data={rows}
            dataKey={series.column}
            endAngle={-270}
            hide={!isSeriesVisible(spec, series.column)}
            innerRadius={`${radii.inner}%`}
            isAnimationActive={animate}
            key={series.column}
            name={series.label ?? columnLabel(spec, series.column)}
            nameKey={spec.name}
            onClick={canEmit(input, officialRendererEventPorts.select)
              ? (datum: unknown) => selectDatum(input, spec, series, datum, spec.name)
              : undefined}
            outerRadius={`${radii.outer}%`}
            paddingAngle={spec.separator === "none" ? 0 : 1}
            startAngle={90}
            stroke={spec.separator === "none" ? "none" : "var(--og-surface, #fff)"}
            strokeWidth={spec.separator === "none" ? 0 : 2}
          >
            {rows.map((row, rowIndex) => (
              <Cell fill={pieDatumColor(spec, series, seriesIndex, rowIndex)} key={rowIndex} />
            ))}
            <ChartLabelList domainKey={spec.name} series={series} spec={spec} />
          </Pie>
        );
      })}
      {spec.centerText ? <ChartCenterText spec={spec} /> : null}
    </PieChart>
  );
}

function ResolvedRadarChart({ input, rows, spec }: { input: ChartInput; rows: DataRow[]; spec: RadarSpec }) {
  const animate = animationSetting(spec);
  const grid = radarGridProps(spec.grid);
  return (
    <RadarChart accessibilityLayer data={rows} margin={{ top: 28, right: 36, bottom: 28, left: 36 }}>
      {spec.grid !== "none" ? (
        <PolarGrid
          fill={grid.filled ? "var(--og-muted, #f4f4f5)" : "none"}
          fillOpacity={grid.filled ? 0.48 : 0}
          gridType={grid.type}
          radialLines={grid.radialLines}
          stroke="var(--og-border, #e4e4e7)"
        />
      ) : null}
      <PolarAngleAxis dataKey={spec.angle} tick={{ fill: "var(--og-muted-foreground, #71717a)", fontSize: 11 }} />
      {spec.radiusAxis?.visible ? (
        <PolarRadiusAxis
          angle={90}
          domain={spec.radiusAxis.domain ?? [0, "auto"]}
          tick={{ fill: "var(--og-muted-foreground, #71717a)", fontSize: 10 }}
        />
      ) : null}
      <ChartTooltipLayer spec={spec} />
      <ChartLegendLayer input={input} spec={spec} />
      {spec.series.map((series, index) => {
        const color = seriesColor(series, index);
        return (
          <Radar
            dataKey={series.column}
            dot={spec.points === "visible" ? { r: 3, fill: color } : false}
            fill={spec.fill === "area" ? color : "none"}
            fillOpacity={spec.fill === "area" ? 0.16 : 0}
            hide={!isSeriesVisible(spec, series.column)}
            isAnimationActive={animate}
            key={series.column}
            name={series.label ?? columnLabel(spec, series.column)}
            onClick={canEmit(input, officialRendererEventPorts.select)
              ? () => selectSeries(input, spec, series)
              : undefined}
            stroke={color}
            strokeWidth={2}
          >
            <ChartLabelList domainKey={spec.angle} series={series} spec={spec} />
          </Radar>
        );
      })}
    </RadarChart>
  );
}

function ResolvedRadialChart({ input, rows, spec }: { input: ChartInput; rows: DataRow[]; spec: RadialSpec }) {
  const animate = animationSetting(spec);
  const angles = radialAngles(spec.sweep);
  return (
    <RadialBarChart
      accessibilityLayer
      barCategoryGap={8}
      data={rows}
      endAngle={angles.end}
      innerRadius="28%"
      margin={{ top: 18, right: 18, bottom: 18, left: 18 }}
      outerRadius="88%"
      startAngle={angles.start}
    >
      {spec.grid !== "none" ? (
        <PolarGrid
          gridType="circle"
          radialLines={false}
          stroke="var(--og-border, #e4e4e7)"
          strokeDasharray={spec.grid === "ring" ? "3 3" : undefined}
        />
      ) : null}
      <PolarRadiusAxis angle={90} domain={[spec.domain.min, spec.domain.max]} tick={false} />
      <ChartTooltipLayer spec={spec} />
      <ChartLegendLayer input={input} spec={spec} />
      {spec.series.map((series, index) => {
        const color = seriesColor(series, index);
        return (
          <RadialBar
            activeShape={spec.shape === "custom" ? { fillOpacity: 0.82, stroke: color, strokeWidth: 2 } : undefined}
            background={{ fill: "var(--og-muted, #f4f4f5)" }}
            cornerRadius={spec.shape === "round" || spec.shape === "custom" ? 999 : 3}
            dataKey={series.column}
            fill={color}
            hide={!isSeriesVisible(spec, series.column)}
            isAnimationActive={animate}
            key={series.column}
            name={series.label ?? columnLabel(spec, series.column)}
            onClick={canEmit(input, officialRendererEventPorts.select)
              ? () => selectSeries(input, spec, series)
              : undefined}
            stackId={stackId(spec, series)}
          >
            <ChartLabelList domainKey={spec.name} series={series} spec={spec} />
          </RadialBar>
        );
      })}
      {spec.centerText ? <ChartCenterText spec={spec} /> : null}
    </RadialBarChart>
  );
}

function CartesianAxes({
  axes,
  domainKey,
}: {
  axes: AreaSpec["axes"] | BarSpec["axes"] | LineSpec["axes"];
  domainKey: string;
}) {
  return (
    <>
      <XAxis
        dataKey={domainKey}
        hide={axes?.x?.visible === false}
        height={axes?.x?.label ? 52 : undefined}
        label={cartesianAxisLabel(axes?.x?.label, "x")}
        minTickGap={24}
        tickFormatter={tickFormatter(axes?.x?.tickFormat)}
        tickCount={axes?.x?.tickCount}
        type={axes?.x?.scale === "number" ? "number" : "category"}
      />
      <YAxis
        domain={["auto", "auto"]}
        hide={axes?.y?.visible === false}
        label={cartesianAxisLabel(axes?.y?.label, "y")}
        tickFormatter={tickFormatter(axes?.y?.tickFormat)}
        tickCount={axes?.y?.tickCount}
        type="number"
        width={axes?.y?.label ? 84 : 64}
      />
    </>
  );
}

function CartesianGridLayer({ grid = "horizontal" }: { grid?: "none" | "horizontal" | "vertical" | "both" }) {
  if (grid === "none") return null;
  return (
    <CartesianGrid
      horizontal={grid === "horizontal" || grid === "both"}
      stroke="var(--og-border, #e4e4e7)"
      strokeDasharray="3 3"
      vertical={grid === "vertical" || grid === "both"}
    />
  );
}

function ChartRangeBrush({
  domainKey,
  input,
  spec,
}: {
  domainKey: string;
  input: ChartInput;
  spec: AreaSpec | BarSpec | LineSpec;
}) {
  if (spec.interaction?.kind !== "range-select") return null;
  const range = isRange(spec.interaction.state) ? spec.interaction.state : undefined;
  return (
    <Brush
      ariaLabel="Select chart range"
      dataKey={domainKey}
      endIndex={range?.end}
      height={26}
      onChange={canEmit(input, officialRendererEventPorts.rangeChange) ? (next) => {
        if (next.startIndex === undefined || next.endIndex === undefined) return;
        emitEvent(input, officialRendererEventPorts.rangeChange, { start: next.startIndex, end: next.endIndex });
      } : undefined}
      startIndex={range?.start}
      stroke="var(--og-border-strong, #a1a1aa)"
      travellerWidth={7}
    />
  );
}

function ChartTooltipLayer({ spec }: { spec: UIResolvedChartSpec }) {
  if (spec.tooltip?.enabled !== true) return null;
  return (
    <Tooltip
      content={<ChartTooltipContent spec={spec} />}
      cursor={spec.tooltip.indicator === "none" ? false : {
        fill: "var(--og-muted, #f4f4f5)",
        stroke: spec.tooltip.indicator === "dashed" ? "var(--og-border-strong, #a1a1aa)" : "none",
        strokeDasharray: spec.tooltip.indicator === "dashed" ? "4 3" : undefined,
      }}
      isAnimationActive="auto"
    />
  );
}

type TooltipEntry = Readonly<{
  color?: string;
  dataKey?: string | number;
  name?: string | number;
  payload?: DataRow;
  value?: number | string | readonly (number | string)[];
}>;

type ChartTooltipContentProps = Readonly<{
  active?: boolean;
  label?: string | number;
  payload?: readonly TooltipEntry[];
  spec: UIResolvedChartSpec;
}>;

function ChartTooltipContent({ active, label, payload = [], spec }: ChartTooltipContentProps) {
  if (!active || payload.length === 0 || spec.tooltip === undefined) return null;
  const config = spec.tooltip;
  const sourceRow = payload[0]?.payload;
  const tooltipLabel = formatTooltipLabel(config, label, sourceRow);
  const numericValues = payload.flatMap((entry) => typeof entry.value === "number" ? [entry.value] : []);
  const aggregate = config.aggregate === "total"
    ? numericValues.reduce((sum, value) => sum + value, 0)
    : config.aggregate === "average" && numericValues.length > 0
      ? numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
      : undefined;
  return (
    <div className="og-chart-tooltip" role="status">
      {tooltipLabel === undefined ? null : <div className="og-chart-tooltip-label">{tooltipLabel}</div>}
      <ul>
        {payload.map((entry, index) => {
          const series = findSeries(spec, entry.dataKey, entry.name);
          const Icon = config.seriesIcons && series?.iconToken ? chartIconMap[series.iconToken] : undefined;
          const token = config.valueFormat ?? series?.valueFormat;
          return (
            <li key={`${String(entry.dataKey)}:${index}`}>
              {Icon ? <Icon aria-hidden="true" size={13} /> : (
                <span aria-hidden="true" className={classes("og-tooltip-indicator", `og-tooltip-indicator-${config.indicator}`)} style={{ background: entry.color }} />
              )}
              <span>{series?.label ?? entry.name ?? entry.dataKey}</span>
              <strong>{formatTooltipValue(entry.value, token)}</strong>
            </li>
          );
        })}
      </ul>
      {aggregate === undefined ? null : (
        <div className="og-chart-tooltip-aggregate">
          <span>{config.aggregate === "total" ? "Total" : "Average"}</span>
          <strong>{formatValue(aggregate, config.valueFormat)}</strong>
        </div>
      )}
    </div>
  );
}

function ChartLegendLayer({ input, spec }: { input: ChartInput; spec: UIResolvedChartSpec }) {
  const legend = spec.legend;
  if (legend === undefined || legend.visibility === "none") return null;
  if (legend.visibility === "auto" && spec.series.length < 2) return null;
  const side = legend.position === "left" || legend.position === "right";
  return (
    <Legend
      align={legend.position === "left" ? "left" : legend.position === "right" ? "right" : legend.align === "start" ? "left" : legend.align === "end" ? "right" : "center"}
      content={<ChartLegendContent input={input} spec={spec} />}
      layout={side ? "vertical" : "horizontal"}
      verticalAlign={legend.position === "top" ? "top" : legend.position === "bottom" ? "bottom" : "middle"}
    />
  );
}

type LegendEntry = Readonly<{
  color?: string;
  dataKey?: string | number | ((value: unknown) => unknown);
  inactive?: boolean;
  value?: string;
}>;

type ChartLegendContentProps = Readonly<{
  input: ChartInput;
  payload?: readonly LegendEntry[];
  spec: UIResolvedChartSpec;
}>;

function ChartLegendContent({ input, spec }: ChartLegendContentProps) {
  const interactive = canEmit(input, officialRendererEventPorts.legendToggle);
  return (
    <ul className={classes("og-chart-legend", `og-chart-legend-${spec.legend?.position ?? "bottom"}`)}>
      {spec.series.map((series, index) => {
        const visible = isSeriesVisible(spec, series.column);
        const Icon = spec.legend?.iconMode === "series-icon" && series.iconToken ? chartIconMap[series.iconToken] : undefined;
        const color = seriesColor(series, index);
        const content = (
          <>
            {Icon ? <Icon aria-hidden="true" size={13} /> : <span aria-hidden="true" className="og-legend-swatch" style={{ background: color }} />}
            <span>{series.label ?? columnLabel(spec, series.column)}</span>
          </>
        );
        return (
          <li data-visible={visible} key={`${series.column}:${index}`}>
            {interactive ? (
              <button
                aria-pressed={visible}
                onClick={() => emitEvent(input, officialRendererEventPorts.legendToggle, { series: series.column, visible: !visible })}
                type="button"
              >
                {content}
              </button>
            ) : <span>{content}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function ChartLabelList({
  domainKey,
  series,
  spec,
}: {
  domainKey: string;
  series: ChartSeries;
  spec: UIResolvedChartSpec;
}) {
  const labels = spec.labels;
  if (labels === undefined || labels.mode === "none") return null;
  return (
    <LabelList
      className="og-chart-label"
      dataKey={series.column}
      fill="var(--og-muted-foreground, #71717a)"
      fontSize={10}
      position={labelPosition(labels.position, spec.family)}
      valueAccessor={(entry) => labelValue(entry.payload as DataRow, domainKey, series, labels)}
    />
  );
}

function ChartCenterText({ spec }: { spec: PieSpec | RadialSpec }) {
  if (spec.centerText === undefined) return null;
  const value = centerTextValue(spec);
  return (
    <g className="og-chart-center-text">
      <text dominantBaseline="central" textAnchor="middle" x="50%" y="47%">
        {formatValue(value, spec.centerText.format)}
      </text>
      <text dominantBaseline="central" textAnchor="middle" x="50%" y="55%">
        {spec.centerText.label}
      </text>
    </g>
  );
}

function EquivalentChartView({ spec }: { spec: UIResolvedChartSpec }) {
  return (
    <details className="og-chart-equivalent" data-equivalent-view={spec.equivalentView}>
      <summary>{spec.equivalentView === "table" ? "View data table" : "View data summary"}</summary>
      {spec.equivalentView === "table" ? (
        <div className="og-table-viewport">
          <table className="og-table og-table-compact">
            <caption>{spec.accessibility.label}</caption>
            <thead><tr>{spec.data.columns.map((column) => <th key={column.columnId} scope="col">{column.label}</th>)}</tr></thead>
            <tbody>
              {spec.data.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {spec.data.columns.map((column) => {
                    const series = spec.series.find((candidate) => candidate.column === column.columnId);
                    return <td key={column.columnId}>{formatValue(row[column.columnId], series?.valueFormat)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="og-chart-summary">
          <p>{spec.data.rows.length} data points across {spec.series.length} series.</p>
          <dl>
            {spec.series.map((series) => {
              const values = spec.data.rows.flatMap((row) => {
                const value = asFiniteNumber(row[series.column]);
                return value === undefined ? [] : [value];
              });
              const total = values.reduce((sum, value) => sum + value, 0);
              return (
                <div key={series.column}>
                  <dt>{series.label ?? columnLabel(spec, series.column)}</dt>
                  <dd>{values.length === 0 ? "No numeric values" : `${formatValue(Math.min(...values), series.valueFormat)} to ${formatValue(Math.max(...values), series.valueFormat)}; total ${formatValue(total, series.valueFormat)}`}</dd>
                </div>
              );
            })}
          </dl>
        </div>
      )}
    </details>
  );
}

function animationSetting(spec: UIResolvedChartSpec): boolean | "auto" {
  return spec.presentation?.animation === "none" ? false : "auto";
}

function cartesianMargin(spec: AreaSpec | BarSpec | LineSpec) {
  return {
    top: spec.labels && spec.labels.mode !== "none" ? 24 : 12,
    right: 18,
    bottom: Math.max(spec.interaction?.kind === "range-select" ? 18 : 6, spec.axes?.x?.label ? 16 : 0),
    left: spec.axes?.y?.label ? 12 : 4,
  };
}

function cartesianAxisLabel(label: string | undefined, axis: "x" | "y") {
  if (label === undefined) return undefined;
  return axis === "x"
    ? { value: label, position: "insideBottom" as const, offset: -8 }
    : { value: label, position: "insideLeft" as const, angle: -90, offset: 4 };
}

function tickFormatter(format?: FormatToken) {
  return format === undefined ? undefined : (value: unknown) => formatValue(toCellValue(value), format);
}

function toCellValue(value: unknown): ChartCellValue {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return value;
  return String(value);
}

function stackId(
  spec: AreaSpec | BarSpec | RadialSpec,
  series: ChartSeries,
): string | undefined {
  if (series.stackId !== undefined) return series.stackId;
  return spec.stack?.mode !== undefined && spec.stack.mode !== "none" ? "og-stack" : undefined;
}

function barRadius(spec: BarSpec, horizontal: boolean): number | [number, number, number, number] {
  if (spec.shape === "default") return 2;
  return horizontal ? [0, 5, 5, 0] : [5, 5, 0, 0];
}

function lineDot(spec: LineSpec, color: string): false | { fill: string; r: number; stroke: string; strokeWidth: number } {
  if (spec.points === "hidden") return false;
  if (spec.points === "custom-symbol") return { fill: "var(--og-surface, #fff)", r: 4, stroke: color, strokeWidth: 2 };
  return { fill: color, r: spec.points === "visible" ? 3 : 3.5, stroke: color, strokeWidth: 1 };
}

function barDatumColor(
  spec: BarSpec,
  series: ChartSeries,
  seriesIndex: number,
  row: DataRow,
  rowIndex: number,
): string {
  if (spec.colorMode === "by-sign") {
    const value = asFiniteNumber(row[series.column]);
    if (value !== undefined && value < 0) return "var(--og-negative, #dc2626)";
    return "var(--og-positive, #15803d)";
  }
  if (spec.colorMode === "per-datum") return indexedChartColor(rowIndex);
  return seriesColor(series, seriesIndex);
}

function pieDatumColor(
  spec: PieSpec,
  series: ChartSeries,
  seriesIndex: number,
  rowIndex: number,
): string {
  if (spec.rings === "stacked") return seriesColor(series, seriesIndex);
  return indexedChartColor(rowIndex);
}

function indexedChartColor(index: number): string {
  const slot = index % chartFallbackColors.length;
  return `var(--og-chart-${slot + 1}, ${chartFallbackColors[slot]})`;
}

function seriesColor(series: ChartSeries, index: number): string {
  const token = series.colorToken;
  if (token === undefined) return indexedChartColor(index);
  if (token.startsWith("chart.")) {
    const slot = Number(token.slice("chart.".length));
    return `var(--og-chart-${slot}, ${chartFallbackColors[(slot - 1) % chartFallbackColors.length]})`;
  }
  const semantic = token.slice("semantic.".length);
  const fallback = semantic === "positive" ? "#15803d"
    : semantic === "negative" ? "#dc2626"
      : semantic === "warning" ? "#a16207"
        : semantic === "info" ? "#2563eb"
          : semantic === "accent" ? "#7c3aed"
            : "#52525b";
  return `var(--og-${semantic}, ${fallback})`;
}

function gradientId(instanceId: string, series: ChartSeries): string {
  return `og-gradient-${instanceId}-${safeId(series.column)}`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function columnLabel(spec: UIResolvedChartSpec, column: string): string {
  return spec.data.columns.find((candidate) => candidate.columnId === column)?.label ?? column;
}

function isSeriesVisible(spec: UIResolvedChartSpec, column: string): boolean {
  const state = spec.legend?.visibilityState;
  if (state === undefined || state === null || (typeof state === "object" && !Array.isArray(state))) return true;
  if (Array.isArray(state)) return state.some((candidate) => String(candidate) === column);
  return String(state) === column;
}

function findSeries(
  spec: UIResolvedChartSpec,
  dataKey: TooltipEntry["dataKey"],
  name: TooltipEntry["name"],
): ChartSeries | undefined {
  const key = dataKey === undefined ? undefined : String(dataKey);
  return spec.series.find((series) => series.column === key)
    ?? spec.series.find((series) => (series.label ?? columnLabel(spec, series.column)) === String(name));
}

function formatTooltipLabel(
  config: NonNullable<UIResolvedChartSpec["tooltip"]>,
  label: string | number | undefined,
  row: DataRow | undefined,
): string | undefined {
  if (config.label.mode === "none") return undefined;
  if (config.label.mode === "default") return label === undefined ? undefined : String(label);
  const source = config.label.column === undefined ? label : row?.[config.label.column];
  if (source === undefined) return undefined;
  return config.label.mode === "formatted" ? formatValue(toCellValue(source), config.label.format) : String(source);
}

function formatTooltipValue(value: TooltipEntry["value"], format?: FormatToken): string {
  if (Array.isArray(value)) return value.map((item) => formatValue(item, format)).join(" - ");
  return formatValue(value as ChartCellValue | undefined, format);
}

type ChartLabels = NonNullable<UIResolvedChartSpec["labels"]>;

function labelValue(
  row: DataRow,
  domainKey: string,
  series: ChartSeries,
  labels: ChartLabels,
): string {
  const category = formatValue(row[domainKey]);
  const value = formatValue(row[series.column], labels.mode === "formatted" ? labels.format : series.valueFormat);
  if (labels.mode === "category" || labels.mode === "list") return category;
  if (labels.mode === "category-value") return `${category}: ${value}`;
  return value;
}

function labelPosition(
  position: ChartLabels["position"],
  family: UIResolvedChartSpec["family"],
): "center" | "inside" | "outside" | "right" | "top" {
  if (position === "inside") return "inside";
  if (position === "outside") return family === "pie" || family === "radial" ? "outside" : "top";
  if (position === "right") return "right";
  if (position === "top") return "top";
  return family === "pie" || family === "radial" ? "outside" : "top";
}

function centerTextValue(spec: PieSpec | RadialSpec): ChartCellValue {
  const center = spec.centerText;
  if (center === undefined) return null;
  if (center.value === "total") {
    return spec.data.rows.reduce((total, row) => total + spec.series.reduce((seriesTotal, series) => {
      return seriesTotal + (asFiniteNumber(row[series.column]) ?? 0);
    }, 0), 0);
  }
  if (center.value === "selected") {
    const selection: unknown = spec.interaction?.kind === "none" || spec.interaction === undefined ? null : spec.interaction.state;
    if (Array.isArray(selection)) return selection.length;
    if (isRange(selection)) return `${selection.start}-${selection.end}`;
    if (selection === null || typeof selection === "boolean" || typeof selection === "string" || typeof selection === "number") return selection;
    return String(selection);
  }
  const value: unknown = center.value;
  if (Array.isArray(value)) return value.length;
  if (isRange(value)) return `${value.start}-${value.end}`;
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return value;
  return String(value);
}

function pieRadii(
  spec: PieSpec,
  index: number,
  count: number,
): { inner: number; outer: number } {
  const base = spec.innerRadius === "none" ? 0 : spec.innerRadius === "sm" ? 28 : spec.innerRadius === "md" ? 40 : 52;
  if (count === 1) return { inner: base, outer: 82 };
  const gap = 2;
  const thickness = Math.max(5, (82 - base - gap * (count - 1)) / count);
  const inner = base + index * (thickness + gap);
  return { inner, outer: inner + thickness };
}

function radarGridProps(grid: RadarSpec["grid"]): {
  filled: boolean;
  radialLines: boolean;
  type: "circle" | "polygon";
} {
  return {
    type: grid.startsWith("circle") ? "circle" : "polygon",
    filled: grid.includes("filled"),
    radialLines: !grid.includes("no-radial-lines") && grid !== "custom-radius-no-radial-lines",
  };
}

function radialAngles(sweep: RadialSpec["sweep"]): { start: number; end: number } {
  if (sweep === "semicircle") return { start: 180, end: 0 };
  if (sweep === "partial") return { start: 225, end: -45 };
  if (sweep === "extended-full") return { start: 105, end: -285 };
  return { start: 90, end: -270 };
}

function selectDatum(
  input: ChartInput,
  spec: UIResolvedChartSpec,
  series: ChartSeries,
  datum: unknown,
  domainKey: string,
): void {
  if (spec.interaction?.kind !== "datum-select" && spec.interaction?.kind !== "slice-select" && spec.interaction?.kind !== "series-select") return;
  if (spec.interaction.kind === "series-select") {
    selectSeries(input, spec, series);
    return;
  }
  const row = extractRow(datum);
  const value = row?.[domainKey];
  emitEvent(input, officialRendererEventPorts.select, {
    series: series.column,
    ...(typeof value === "string" || typeof value === "number" ? { datum: value } : {}),
  });
}

function selectSeries(input: ChartInput, spec: UIResolvedChartSpec, series: ChartSeries): void {
  if (spec.interaction?.kind !== "series-select") return;
  emitEvent(input, officialRendererEventPorts.select, { series: series.column });
}

function extractRow(value: unknown): DataRow | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const payload = candidate.payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) return payload as DataRow;
  return candidate as DataRow;
}

function isRange(value: unknown): value is { start: number; end: number } {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { start?: unknown }).start === "number"
    && typeof (value as { end?: unknown }).end === "number";
}

function chartSemanticElements(spec: UIResolvedChartSpec): string[] {
  const elements = new Set<string>(["series", "equivalent-view"]);
  if (spec.family === "area" || spec.family === "bar" || spec.family === "line") {
    elements.add("axis");
    if (spec.axes?.grid !== "none") elements.add("grid");
  }
  if (spec.family === "radar" || spec.family === "radial") elements.add("grid");
  if (spec.legend !== undefined && spec.legend.visibility !== "none") elements.add("legend");
  if (spec.tooltip?.enabled === true) elements.add("tooltip");
  if (spec.labels !== undefined && spec.labels.mode !== "none") elements.add("labels");
  if ((spec.family === "pie" || spec.family === "radial") && spec.centerText !== undefined) elements.add("center-text");
  return [...elements].sort();
}

function chartEventPorts(spec: UIResolvedChartSpec): string[] {
  const ports: string[] = [];
  if (spec.legend !== undefined && spec.legend.visibility !== "none") ports.push("legendToggle");
  if (spec.interaction?.kind === "range-select") ports.push("rangeChange");
  if (spec.interaction?.kind === "datum-select" || spec.interaction?.kind === "series-select" || spec.interaction?.kind === "slice-select") {
    ports.push("select");
  }
  return ports.sort();
}
