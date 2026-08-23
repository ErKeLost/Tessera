"use client";

import type {
  ChartCellValue,
  ChartMetric,
  ChartSeriesColumn,
  FormatToken,
  ResolvedChartData,
  ResolvedChartSpec,
} from "@open-generative/components";
import type { JsonObject } from "@open-generative/protocol";
import type { RendererInput } from "@open-generative/react";
import {
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Crown,
  Eye,
  Monitor,
  Smartphone,
  Tablet,
  UserRoundPlus,
  UsersRound,
  Watch,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  PolarAngleAxis,
  PolarGrid,
  Pie,
  PieChart,
  Radar,
  RadarChart,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  type BarShapeProps,
} from "recharts";
import { useId, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ChartContainer, type ChartConfig } from "../components/ui/chart";
import { Progress } from "../components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { asFiniteNumber, formatValue } from "./format";

export type ResolvedChartDataModel = ResolvedChartData;
export type WithResolvedChartData<T> = T extends { data: unknown }
  ? Omit<T, "data"> & Readonly<{ data: ResolvedChartDataModel }>
  : never;
export type UIResolvedChartSpec = WithResolvedChartData<ResolvedChartSpec> & JsonObject;
export type DataChartResolvedProps = JsonObject & Readonly<{ spec: UIResolvedChartSpec }>;
export type DataChartRendererInput = RendererInput<DataChartResolvedProps>;
export type ChartInput = DataChartRendererInput;
export type ResolvedChartProps = Readonly<{
  input: ChartInput;
  spec: UIResolvedChartSpec;
}>;

type DataRow = Record<string, ChartCellValue>;
type RecipeSpec<TRecipe extends UIResolvedChartSpec["recipe"]> = Extract<
  UIResolvedChartSpec,
  { recipe: TRecipe }
>;

const THEME_COLORS = [
  "var(--og-lime)",
  "var(--og-blue)",
  "var(--og-violet)",
  "var(--og-pink)",
  "var(--og-yellow)",
] as const;
const PIPELINE_ICONS = [Eye, UserRoundPlus, Zap, Crown, UsersRound, Building2] as const;
const GRID = "var(--og-chart-grid)";
const MUTED = "var(--og-muted-foreground)";

export function DataChartRenderer(input: ChartInput) {
  const { spec } = input.resolvedProps;
  return (
    <div className="og-chart-host">
      <section
        aria-label={spec.accessibility.label}
        className={`og-ui og-chart-surface og-recipe-${spec.recipe}`}
        data-chart-recipe={spec.recipe}
        data-og-component="data.chart"
        data-og-renderer="recipe"
      >
        <ResolvedChart input={input} spec={spec} />
      </section>
    </div>
  );
}

export function ResolvedChart({ spec }: ResolvedChartProps) {
  const instanceId = safeId(useId());
  const rows = spec.data.rows.map((row) => ({ ...row }));

  return (
    <figure
      className="og-chart"
      data-renderer-kind={rendererKind(spec.recipe)}
      data-semantic-elements="title metric plot tooltip equivalent-view"
      data-chart-stable-size="true"
      data-reduced-motion="disable-animation"
    >
      {rows.length === 0 ? (
        <EmptyChart title={spec.title} />
      ) : (
        renderRecipe(spec, rows, instanceId)
      )}
      <EquivalentDataTable spec={spec} />
    </figure>
  );
}

function renderRecipe(spec: UIResolvedChartSpec, rows: DataRow[], instanceId: string): ReactNode {
  switch (spec.recipe) {
    case "steps-bars": return <StepsBars rows={rows} spec={spec} />;
    case "pipeline-stage-bars": return <PipelineStageBars rows={rows} spec={spec} />;
    case "sleep-score": return <SleepScore rows={rows} spec={spec} />;
    case "revenue-per-account-scatter": return <RevenueScatter rows={rows} spec={spec} />;
    case "tracked-time-sankey": return <TrackedTimeSankey rows={rows} spec={spec} />;
    case "visitors-radial": return <VisitorsRadial rows={rows} spec={spec} />;
    case "visitors-radar": return <VisitorsRadar rows={rows} spec={spec} />;
    case "activity-calendar": return <ActivityCalendar rows={rows} spec={spec} />;
    case "revenue-smooth-area": return <RevenueSmoothArea instanceId={instanceId} rows={rows} spec={spec} />;
    case "active-users-heatmap": return <ActiveUsersHeatmap rows={rows} spec={spec} />;
    case "sign-up-funnel": return <SignUpFunnel rows={rows} spec={spec} />;
    case "earned-so-far-bars": return <EarnedSoFarBars rows={rows} spec={spec} />;
    case "contributions-heatmap": return <ContributionsHeatmap rows={rows} spec={spec} />;
    case "sessions-conversion-combo": return <SessionsConversionCombo rows={rows} spec={spec} />;
    case "devices-bars": return <DevicesBars rows={rows} spec={spec} />;
    case "visitors-stacked-area": return <VisitorsStackedArea instanceId={instanceId} rows={rows} spec={spec} />;
    case "activity-rings": return <ActivityRings rows={rows} spec={spec} />;
  }
}

function StepsBars({ rows, spec }: RecipeProps<"steps-bars">) {
  const days = rows
    .map((row) => ({
      date: parseDate(row[spec.dateColumn])!,
      dateValue: String(row[spec.dateColumn]),
      goal: numeric(row, spec.goalColumn),
      value: numeric(row, spec.valueColumn),
    }))
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  const [selectedDate, setSelectedDate] = useState(spec.selectedDate);
  const [previewDate, setPreviewDate] = useState<string>();
  const displayedDate = previewDate ?? selectedDate;
  const selected = days.find((day) => day.dateValue === displayedDate)!;
  const dateFormatter = new Intl.DateTimeFormat(spec.locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const weekdayFormatter = new Intl.DateTimeFormat(spec.locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  const rangeLabel = `${dateFormatter.format(days[0]!.date)} - ${dateFormatter.format(days.at(-1)!.date)}`;

  return (
    <div className="og-steps-panel">
      <header className="og-steps-header">
        <div className="og-steps-heading">
          <h3>{fullWeekday(selected.date, spec.locale)}</h3>
          <p>
            <strong>{formatValue(selected.value, spec.valueFormat)}</strong>
            <span>{spec.unitLabel}</span>
          </p>
        </div>
        <div aria-label={`Week ${rangeLabel}`} className="og-steps-period">
          <Button aria-label="Previous week" className="og-steps-period-button" disabled size="icon-xs" variant="ghost">
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span>{rangeLabel}</span>
          <Button aria-label="Next week" className="og-steps-period-button" disabled size="icon-xs" variant="ghost">
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </header>
      <ol aria-label={spec.accessibility.label} className="og-steps-bars" data-chart-mark="bars">
        {days.map((day) => {
          const progress = day.goal <= 0 ? 0 : clamp(day.value / day.goal * 100, 0, 100);
          const valueLabel = `${weekdayFormatter.format(day.date)}, ${formatValue(day.value, spec.valueFormat)} ${spec.unitLabel}`;
          return (
            <li className="og-steps-day" key={day.dateValue}>
              <button
                aria-label={valueLabel}
                aria-pressed={selectedDate === day.dateValue}
                className="og-steps-day-trigger"
                onBlur={() => setPreviewDate(undefined)}
                onClick={() => setSelectedDate(day.dateValue)}
                onFocus={() => setPreviewDate(day.dateValue)}
                onPointerEnter={() => setPreviewDate(day.dateValue)}
                onPointerLeave={() => setPreviewDate(undefined)}
                type="button"
              >
                <div className="og-steps-track-shell">
                  <Progress
                    aria-label={valueLabel}
                    className="og-steps-track"
                    indicatorClassName="og-steps-fill"
                    orientation="vertical"
                    title={valueLabel}
                    value={progress}
                  />
                </div>
                <time dateTime={day.dateValue}>{weekdayFormatter.format(day.date)}</time>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function PipelineStageBars({ rows, spec }: RecipeProps<"pipeline-stage-bars">) {
  const maximum = Math.max(numericValue(metricValue(rows, spec.summary)), 1);
  const change = numericValue(metricValue(rows, spec.change));
  return (
    <div className="og-pipeline-panel">
      <header className="og-pipeline-header">
        <div className="og-pipeline-heading">
          <h3>{spec.title}</h3>
          <div>
            <strong>{formatValue(maximum, spec.summary.format)}</strong>
            <Badge variant="positive">{change > 0 ? "+" : ""}{formatValue(change, spec.change.format)}</Badge>
          </div>
        </div>
        <Button aria-label={`Period: ${spec.periodLabel}`} className="og-pipeline-period" disabled variant="outline">
          <CalendarDays aria-hidden="true" />
          <span>{spec.periodLabel}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </header>
      <ol aria-label={spec.accessibility.label} className="og-pipeline-stages" data-chart-mark="bars">
        {rows.map((row, index) => {
          const value = numeric(row, spec.valueColumn);
          const ratio = clamp(value / maximum, 0, 1);
          const label = text(row, spec.stageColumn);
          const Icon = PIPELINE_ICONS[index]!;
          const valueLabel = `${label}: ${formatValue(value, spec.valueFormat)}, ${formatPercent(ratio)}`;
          return (
            <li className={`og-pipeline-stage og-pipeline-tone-${index}`} key={`${label}-${index}`}>
              <span className="og-pipeline-stage-label">{label}</span>
              <div className="og-pipeline-progress-wrap">
                <Progress aria-label={valueLabel} className="og-pipeline-progress" indicatorClassName="og-pipeline-progress-fill" title={valueLabel} value={ratio * 100} />
                <Icon aria-hidden="true" className="og-pipeline-stage-icon" />
              </div>
              <strong>{formatValue(value, spec.valueFormat)}</strong>
              <span className="og-pipeline-percent">{formatPercent(ratio)}</span>
            </li>
          );
        })}
      </ol>
      <div className="og-pipeline-summary-grid">
        {rows.map((row, index) => {
          const label = text(row, spec.stageColumn);
          return (
            <Card className={`og-pipeline-summary-card og-pipeline-tone-${index}`} key={`${label}-summary`}>
              <div><i aria-hidden="true" /><span>{label}</span></div>
              <strong>{formatValue(row[spec.valueColumn], spec.valueFormat)}</strong>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function SleepScore({ rows, spec }: RecipeProps<"sleep-score">) {
  const score = numericValue(metricValue(rows, spec.score));
  const chartData = rows.map((row, index) => ({
    fill: `var(--color-segment-${index})`,
    label: text(row, spec.labelColumn),
    value: numeric(row, spec.scoreColumn),
  }));
  const chartConfig = Object.fromEntries(chartData.map((entry, index) => [
    `segment-${index}`,
    { color: `var(--og-sleep-segment-${index + 1})`, label: entry.label },
  ])) as ChartConfig;
  const periodLabel = formatDateRange(spec.periodStart, spec.periodEnd, spec.locale);
  return (
    <div className="og-sleep-score-panel">
      <header className="og-sleep-score-header">
        <div className="og-sleep-score-heading">
          <h3>{spec.title}</h3>
          <p>{spec.subtitle}</p>
        </div>
        <div aria-label={`Week ${periodLabel}`} className="og-sleep-score-period">
          <Button aria-label="Previous week" className="og-sleep-score-period-button" disabled size="icon-xs" variant="ghost">
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span>{periodLabel}</span>
          <Button aria-label="Next week" className="og-sleep-score-period-button" disabled size="icon-xs" variant="ghost">
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </header>
      <div className="og-sleep-score-visual">
        <ChartContainer aria-label={spec.accessibility.label} className="og-sleep-score-chart" config={chartConfig} role="img">
          <ClientChartProjection server={<SleepScoreProjection rows={rows} spec={spec} />}>
            <PieChart height={120} width={120}>
              <Pie
                cornerRadius={10}
                data={chartData}
                dataKey="value"
                endAngle={-270}
                innerRadius={37}
                isAnimationActive={false}
                nameKey="label"
                outerRadius={52}
                paddingAngle={7}
                startAngle={90}
                stroke="none"
              >
                {chartData.map((entry) => <Cell fill={entry.fill} key={entry.label} />)}
              </Pie>
            </PieChart>
          </ClientChartProjection>
        </ChartContainer>
        <strong>{formatValue(score, spec.scoreFormat)}</strong>
      </div>
      <Card className="og-sleep-score-details">
        <ol>
          {rows.map((row, index) => {
            const label = text(row, spec.labelColumn);
            const valueLabel = `${label}: ${text(row, spec.detailColumn)}, ${formatValue(row[spec.scoreColumn], spec.scoreFormat)} of ${formatValue(row[spec.targetColumn], spec.scoreFormat)}`;
            return (
              <li aria-label={valueLabel} className={`og-sleep-score-detail og-sleep-score-tone-${index}`} key={`${label}-${index}`}>
                <i aria-hidden="true" />
                <span>{label}: {text(row, spec.detailColumn)}</span>
                <strong>{formatValue(row[spec.scoreColumn], spec.scoreFormat)}/{formatValue(row[spec.targetColumn], spec.scoreFormat)}</strong>
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}

function SleepScoreProjection({ rows, spec }: RecipeProps<"sleep-score">) {
  const total = Math.max(rows.reduce((sum, row) => sum + numeric(row, spec.scoreColumn), 0), 1);
  let consumed = 0;
  return (
    <svg aria-hidden="true" className="og-sleep-score-chart-svg" viewBox="0 0 120 120">
      <title>{spec.accessibility.label}</title>
      {rows.map((row, index) => {
        const percentage = numeric(row, spec.scoreColumn) / total * 100;
        const dash = Math.max(percentage - 5.5, 0);
        const offset = -consumed - 2.75;
        consumed += percentage;
        return (
          <circle
            className={`og-sleep-score-arc og-sleep-score-arc-${index}`}
            cx="60"
            cy="60"
            fill="none"
            key={`${text(row, spec.labelColumn)}-${index}`}
            pathLength="100"
            r="44.5"
            strokeDasharray={`${dash} ${100 - dash}`}
            strokeDashoffset={offset}
            strokeLinecap="round"
            strokeWidth="15"
            transform="rotate(-90 60 60)"
          >
            <title>{`${text(row, spec.labelColumn)}: ${formatValue(row[spec.scoreColumn], spec.scoreFormat)}`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

function RevenueScatter({ rows, spec }: RecipeProps<"revenue-per-account-scatter">) {
  const groups = unique(rows.map((row) => text(row, spec.groupColumn)));
  const change = numericValue(metricValue(rows, spec.change));
  const [activeIndex, setActiveIndex] = useState<number>();
  const activeRow = activeIndex === undefined ? undefined : rows[activeIndex];
  const tooltipStyle = activeRow === undefined
    ? undefined
    : revenueScatterTooltipStyle(
        numeric(activeRow, spec.comparisonColumn),
        numeric(activeRow, spec.revenueColumn),
      );
  const chartConfig = Object.fromEntries(groups.map((group, index) => [
    `group-${index}`,
    { color: `var(--og-revenue-segment-${index + 1})`, label: group },
  ])) as ChartConfig;
  return (
    <div className="og-revenue-scatter-panel">
      <header className="og-revenue-scatter-header">
        <div className="og-revenue-scatter-heading">
          <h3>{spec.title}</h3>
          <div>
            <strong>{formatValue(metricValue(rows, spec.summary), spec.summary.format)}</strong>
            <Badge variant="positive">{change > 0 ? "+" : ""}{formatValue(change, spec.change.format)}</Badge>
          </div>
        </div>
        <Button aria-label={`Period: ${spec.periodLabel}`} className="og-revenue-scatter-period" disabled variant="outline">
          <CalendarDays aria-hidden="true" />
          <span>{spec.periodLabel}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </header>
      <ChartContainer className="og-revenue-scatter-chart" config={chartConfig} data-chart-mark="scatter">
        <ClientChartProjection server={<ScatterProjection rows={rows} spec={spec} />}>
          <ScatterChart height={220} margin={{ top: 8, right: 16, bottom: 32, left: 8 }} width={576}>
            <CartesianGrid stroke="var(--og-chart-grid)" strokeDasharray="3 5" />
            <XAxis axisLine={false} dataKey={spec.comparisonColumn} domain={[0, 100]} name={columnLabel(spec, spec.comparisonColumn)} tick={axisTick} ticks={[0, 25, 50, 75, 100]} tickFormatter={(value) => formatValue(value, spec.comparisonFormat)} tickLine={false} type="number" />
            <YAxis axisLine={false} dataKey={spec.revenueColumn} domain={[0, 1700]} name={columnLabel(spec, spec.revenueColumn)} tick={axisTick} ticks={[0, 550, 1100, 1700]} tickFormatter={(value) => formatValue(value, spec.revenueFormat)} tickLine={false} type="number" width={52} />
            <ZAxis dataKey={spec.sizeColumn} range={[110, 390]} />
            <Scatter activeShape={{ fillOpacity: 0.88, strokeWidth: 3 }} data={rows} fill="var(--og-revenue-segment-1)" fillOpacity={0.62} isAnimationActive={false} name={spec.title}>
              {rows.map((row, index) => {
                const groupIndex = groups.indexOf(text(row, spec.groupColumn));
                const color = `var(--color-group-${groupIndex})`;
                const active = activeIndex === undefined || activeIndex === index;
                return (
                  <Cell
                    fill={color}
                    fillOpacity={active ? 0.72 : 0.24}
                    key={index}
                    onBlur={() => setActiveIndex(undefined)}
                    onFocus={() => setActiveIndex(index)}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseLeave={() => setActiveIndex(undefined)}
                    stroke={color}
                    strokeWidth={activeIndex === index ? 3 : 2}
                    tabIndex={0}
                  />
                );
              })}
            </Scatter>
          </ScatterChart>
        </ClientChartProjection>
      </ChartContainer>
      <div className="og-revenue-scatter-axis-labels"><span>{columnLabel(spec, spec.revenueColumn)}</span><span>{columnLabel(spec, spec.comparisonColumn)}</span></div>
      {activeRow ? <RevenueScatterTooltip row={activeRow} spec={spec} style={tooltipStyle} /> : null}
      <div className="og-revenue-scatter-summary-grid">
        {groups.map((group, index) => {
          const groupRows = rows.filter((row) => text(row, spec.groupColumn) === group);
          const average = groupRows.reduce((sum, row) => sum + numeric(row, spec.revenueColumn), 0) / groupRows.length;
          return (
            <Card className={`og-revenue-scatter-summary-card og-revenue-tone-${index}`} key={group}>
              <div><i aria-hidden="true" /><span>{group} · avg</span></div>
              <strong>{formatValue(average, spec.summary.format)}</strong>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function TrackedTimeSankey({ rows, spec }: RecipeProps<"tracked-time-sankey">) {
  const layout = trackedTimeLayout(rows, spec.sourceColumn, spec.targetColumn, spec.valueColumn);
  const [activeEdgeIndex, setActiveEdgeIndex] = useState<number>();
  const activeEdge = activeEdgeIndex === undefined ? undefined : layout.edges[activeEdgeIndex];
  const total = numericValue(metricValue(rows, spec.summary));
  const heading = activeEdge === undefined ? spec.title : `${activeEdge.source} \u2192 ${activeEdge.target}`;
  const headingValue = activeEdge?.value ?? total;
  return (
    <div className="og-tracked-time-panel">
      <header className="og-tracked-time-header">
        <div className="og-tracked-time-heading">
          <h3>{heading}</h3>
          <strong>{formatValue(headingValue, spec.valueFormat)}{spec.unitLabel}</strong>
        </div>
        <Button aria-label={`Period: ${spec.periodLabel}`} className="og-tracked-time-period" disabled variant="outline">
          <CalendarDays aria-hidden="true" />
          <span>{spec.periodLabel}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </header>
      <ChartContainer className="og-tracked-time-chart" config={trackedTimeChartConfig}>
        <svg
          aria-label={spec.accessibility.label}
          className={activeEdge === undefined ? "og-tracked-time-svg" : "og-tracked-time-svg is-interacting"}
          onPointerLeave={() => setActiveEdgeIndex(undefined)}
          role="img"
          viewBox="0 0 672 480"
        >
          <title>{spec.accessibility.label}</title>
          {layout.edges.map((edge, index) => (
            <path
              aria-label={`${edge.source} to ${edge.target}: ${formatValue(edge.value, spec.valueFormat)}${spec.unitLabel}`}
              className={activeEdgeIndex === index ? `og-tracked-time-flow og-tracked-time-source-${edge.sourceIndex} is-active` : `og-tracked-time-flow og-tracked-time-source-${edge.sourceIndex}`}
              d={edge.path}
              key={`${edge.source}-${edge.target}`}
              onBlur={() => setActiveEdgeIndex(undefined)}
              onFocus={() => setActiveEdgeIndex(index)}
              onPointerEnter={() => setActiveEdgeIndex(index)}
              tabIndex={0}
            >
              <title>{`${edge.source} to ${edge.target}: ${formatValue(edge.value, spec.valueFormat)}${spec.unitLabel}`}</title>
            </path>
          ))}
          {activeEdge ? <path className={`og-tracked-time-flow og-tracked-time-source-${activeEdge.sourceIndex} is-active-overlay`} d={activeEdge.path} pointerEvents="none" /> : null}
          {layout.sources.map((node) => {
            const active = activeEdge === undefined || activeEdge.source === node.name;
            return (
              <g className={active ? `og-tracked-time-node og-tracked-time-source-${node.index}` : `og-tracked-time-node og-tracked-time-source-${node.index} is-dimmed`} key={`source-${node.name}`}>
                <text className="og-tracked-time-source-name" textAnchor="end" x="96" y={node.y + node.height / 2 - 4}>{node.name}</text>
                <text className="og-tracked-time-source-value" textAnchor="end" x="96" y={node.y + node.height / 2 + 13}>{formatValue(node.value, spec.valueFormat)}{spec.unitLabel}</text>
                <rect className="og-tracked-time-source-node" height={node.height} rx="var(--og-radius-mark)" width="12" x="104" y={node.y} />
              </g>
            );
          })}
          {layout.targets.map((node) => {
            const active = activeEdge === undefined || activeEdge.target === node.name;
            return (
              <g className={active ? "og-tracked-time-node" : "og-tracked-time-node is-dimmed"} key={`target-${node.name}`}>
                <rect className="og-tracked-time-target-node" height={node.height} rx="var(--og-radius-mark)" width="12" x="494" y={node.y} />
                <text className="og-tracked-time-target-name" x="514" y={node.y + node.height / 2 + 5}>{node.name}<tspan> · {formatPercent(node.value / total)}</tspan></text>
              </g>
            );
          })}
          <text className="og-tracked-time-axis-label" x="16" y="461">Tracked time</text>
          <text className="og-tracked-time-axis-label" textAnchor="end" x="656" y="461">Share of tracked time</text>
        </svg>
      </ChartContainer>
    </div>
  );
}

const trackedTimeChartConfig = {
  focus: { color: "var(--og-tracked-source-1)", label: "Focus" },
  meetings: { color: "var(--og-tracked-source-2)", label: "Meetings" },
  breaks: { color: "var(--og-tracked-source-3)", label: "Breaks" },
  admin: { color: "var(--og-tracked-source-4)", label: "Admin" },
  learning: { color: "var(--og-tracked-source-5)", label: "Learning" },
} satisfies ChartConfig;

function VisitorsRadial({ rows, spec }: RecipeProps<"visitors-radial">) {
  const visible = rows.slice(0, 5);
  const max = Math.max(...visible.map((row) => numeric(row, spec.valueColumn)), 1);
  const [activeIndex, setActiveIndex] = useState<number>();
  const headline = activeIndex === undefined
    ? metricValue(rows, spec.summary)
    : visible[activeIndex]?.[spec.valueColumn];
  const chartConfig = Object.fromEntries(visible.map((row, index) => [
    `ring-${index}`,
    { color: THEME_COLORS[index]!, label: text(row, spec.categoryColumn) },
  ])) as ChartConfig;
  return (
    <Card className="og-visitors-radial-panel">
      <DashboardHeader
        change={numericValue(metricValue(rows, spec.change))}
        changeFormat={spec.change.format}
        format={spec.summary.format}
        periodLabel={spec.periodLabel}
        title={spec.title}
        value={headline}
      />
      <ChartContainer className="og-visitors-radial-chart" config={chartConfig}>
        <svg aria-label={spec.accessibility.label} onPointerLeave={() => setActiveIndex(undefined)} role="img" viewBox="0 0 360 360">
          <title>{spec.accessibility.label}</title>
          {visible.map((row, index) => {
            const radius = 142 - index * 20;
            const circumference = 2 * Math.PI * radius;
            const ratio = clamp(numeric(row, spec.valueColumn) / max, 0, 1);
            return (
              <g className={activeIndex === undefined || activeIndex === index ? "og-radial-ring" : "og-radial-ring is-dimmed"} key={`${text(row, spec.categoryColumn)}-${index}`}>
                <circle className="og-radial-track" cx="180" cy="180" fill="none" r={radius} strokeWidth="12" />
                <circle
                  className={`og-radial-value og-tone-${index}`}
                  cx="180"
                  cy="180"
                  fill="none"
                  onBlur={() => setActiveIndex(undefined)}
                  onFocus={() => setActiveIndex(index)}
                  onPointerEnter={() => setActiveIndex(index)}
                  r={radius}
                  strokeDasharray={`${ratio * circumference} ${circumference}`}
                  strokeLinecap="round"
                  strokeWidth="12"
                  tabIndex={0}
                  transform="rotate(-90 180 180)"
                ><title>{`${text(row, spec.categoryColumn)}: ${formatValue(row[spec.valueColumn], spec.valueFormat)}`}</title></circle>
              </g>
            );
          })}
        </svg>
      </ChartContainer>
      <div className="og-dashboard-card-grid og-visitors-radial-summary">
        {visible.map((row, index) => (
          <DashboardValueCard
            index={index}
            key={`${text(row, spec.categoryColumn)}-${index}`}
            label={text(row, spec.categoryColumn)}
            value={formatValue(row[spec.valueColumn], spec.valueFormat)}
          />
        ))}
      </div>
    </Card>
  );
}

function VisitorsRadar({ rows, spec }: RecipeProps<"visitors-radar">) {
  const chartConfig = {
    visitors: { color: "var(--og-lime)", label: columnLabel(spec, spec.valueColumn) },
  } satisfies ChartConfig;
  return (
    <Card className="og-visitors-radar-panel">
      <DashboardHeader
        change={numericValue(metricValue(rows, spec.change))}
        changeFormat={spec.change.format}
        format={spec.summary.format}
        periodLabel={spec.periodLabel}
        title={spec.title}
        value={metricValue(rows, spec.summary)}
      />
      <ChartContainer className="og-visitors-radar-chart" config={chartConfig} data-chart-mark="radar">
        <ClientChartProjection server={<RadarProjection rows={rows} spec={spec} />}>
          <RadarChart data={rows} height={310} margin={{ top: 34, right: 62, bottom: 30, left: 62 }} width={576}>
            <PolarGrid gridType="polygon" stroke="var(--og-chart-grid)" />
            <PolarAngleAxis dataKey={spec.dimensionColumn} tick={{ fill: "var(--og-muted-foreground)", fontSize: 14 }} />
            <Tooltip content={<ChartTooltipContent format={spec.valueFormat} />} />
            <Radar dataKey={spec.valueColumn} fill="var(--og-lime)" fillOpacity={0.22} isAnimationActive={false} name={columnLabel(spec, spec.valueColumn)} stroke="var(--og-lime)" strokeWidth={3} />
          </RadarChart>
        </ClientChartProjection>
      </ChartContainer>
      <div className="og-dashboard-card-grid og-visitors-radar-summary">
        {rows.map((row, index) => (
          <Card className="og-dashboard-value-card og-radar-value-card" key={`${text(row, spec.dimensionColumn)}-${index}`}>
            <span>{text(row, spec.dimensionColumn)}</span>
            <strong>{formatValue(row[spec.valueColumn], spec.valueFormat)}</strong>
          </Card>
        ))}
      </div>
    </Card>
  );
}

function ActivityCalendar({ rows, spec }: RecipeProps<"activity-calendar">) {
  const cells = monthCalendarCells(rows, spec.dateColumn, spec.valueColumn);
  const [selectedDate, setSelectedDate] = useState(spec.selectedDate);
  const selectedRow = rows.find((row) => text(row, spec.dateColumn) === selectedDate) ?? rows[0]!;
  const month = parseDate(rows[0]?.[spec.dateColumn])!;
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(month);
  const selectedLabel = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(parseDate(selectedRow[spec.dateColumn])!);
  return (
    <div className="og-activity-calendar-layout">
      <Card className="og-activity-calendar-panel">
        <header className="og-activity-calendar-header">
          <div><h3>{spec.title}</h3><p><strong>{formatValue(metricValue(rows, spec.summary), spec.summary.format)}</strong><span>total steps</span></p></div>
          <div className="og-month-control">
            <Button aria-label="Previous month" disabled size="icon-xs" variant="ghost"><ChevronLeft aria-hidden="true" /></Button>
            <span>{monthLabel}</span>
            <Button aria-label="Next month" disabled size="icon-xs" variant="ghost"><ChevronRight aria-hidden="true" /></Button>
          </div>
        </header>
        <div className="og-calendar-scroll">
          <h4>{monthLabel.slice(0, 3)}</h4>
          <div className="og-activity-calendar-grid">
            {cells.map((cell) => {
              const row = rows.find((candidate) => text(candidate, spec.dateColumn) === cell.key);
              return (
                <button
                  aria-label={`${cell.key}: ${formatValue(cell.value, spec.valueFormat)} steps`}
                  aria-pressed={selectedDate === cell.key}
                  className="og-activity-day"
                  key={cell.key}
                  onClick={() => setSelectedDate(cell.key)}
                  style={{ gridColumn: cell.day + 1 }}
                  type="button"
                >
                  <span>{cell.date.getUTCDate()}</span>
                  <MiniActivityRings row={row} series={spec.series} />
                </button>
              );
            })}
          </div>
        </div>
      </Card>
      <Card className="og-selected-activity-panel">
        <h3>Activity for {selectedLabel}</h3>
        <div className="og-activity-stat-grid">
          {spec.series.map((series, index) => (
            <DashboardValueCard
              index={activityTone(index)}
              key={series.column}
              label={series.label ?? columnLabel(spec, series.column)}
              value={formatActivityDetail(series.label ?? series.column, numeric(selectedRow, series.column))}
            />
          ))}
        </div>
        <ChartContainer className="og-selected-activity-rings" config={activityChartConfig(spec.series)}>
          <ActivityRingsSvg row={selectedRow} series={spec.series} />
        </ChartContainer>
      </Card>
    </div>
  );
}

function RevenueSmoothArea({ instanceId, rows, spec }: RecipeProps<"revenue-smooth-area"> & { instanceId: string }) {
  const gradientId = `og-revenue-${instanceId}`;
  const chartConfig = { revenue: { color: "var(--og-lime)", label: columnLabel(spec, spec.revenueColumn) } } satisfies ChartConfig;
  return (
    <Card className="og-revenue-area-panel">
      <DashboardHeader
        change={numericValue(metricValue(rows, spec.change))}
        changeFormat={spec.change.format}
        format={spec.summary.format}
        tabs
        title={spec.title}
        value={metricValue(rows, spec.summary)}
      />
      <ChartContainer className="og-revenue-area-chart" config={chartConfig} data-chart-mark="area">
        <ClientChartProjection server={<AreaProjection format={spec.revenueFormat} rows={rows} timeColumn={spec.timeColumn} valueColumn={spec.revenueColumn} />}>
          <AreaChart data={rows} height={330} margin={{ top: 18, right: 12, bottom: 4, left: 12 }} width={760}>
            <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={THEME_COLORS[0]} stopOpacity="0.48" /><stop offset="100%" stopColor={THEME_COLORS[0]} stopOpacity="0.02" /></linearGradient></defs>
            <CartesianGrid horizontal={false} vertical={false} />
            <XAxis axisLine={false} dataKey={spec.timeColumn} tick={axisTick} tickFormatter={timeTick} tickLine={false} />
            <YAxis axisLine={false} domain={[0, 6000]} tick={axisTick} tickFormatter={currencyAxisTick} tickLine={false} ticks={[0, 2000, 4000, 6000]} width={52} />
            <Tooltip content={<ChartTooltipContent format={spec.revenueFormat} />} cursor={{ stroke: MUTED, strokeDasharray: "3 3" }} />
            <Area activeDot={{ fill: "var(--og-lime)", r: 5, stroke: "var(--og-surface)", strokeWidth: 3 }} dataKey={spec.revenueColumn} fill={`url(#${gradientId})`} isAnimationActive={false} name={columnLabel(spec, spec.revenueColumn)} stroke="var(--og-lime)" strokeWidth={3} type="monotone" />
          </AreaChart>
        </ClientChartProjection>
      </ChartContainer>
    </Card>
  );
}

function ActiveUsersHeatmap({ rows, spec }: RecipeProps<"active-users-heatmap">) {
  const days = unique(rows.map((row) => text(row, spec.dayColumn))).slice(0, 7);
  const buckets = unique(rows.map((row) => text(row, spec.timeBucketColumn))).slice(0, 12);
  const values = new Map(rows.map((row) => [`${text(row, spec.dayColumn)}\u0000${text(row, spec.timeBucketColumn)}`, numeric(row, spec.valueColumn)]));
  const max = Math.max(...values.values(), 1);
  const [activeKey, setActiveKey] = useState<string>();
  const activeValue = activeKey === undefined ? undefined : values.get(activeKey);
  const config = { users: { color: "var(--og-blue)", label: columnLabel(spec, spec.valueColumn) } } satisfies ChartConfig;
  return (
    <Card className="og-active-users-panel">
      <DashboardHeader
        change={numericValue(metricValue(rows, spec.change))}
        changeFormat={spec.change.format}
        format={spec.summary.format}
        periodLabel={spec.periodLabel}
        title={activeKey === undefined ? spec.title : activeKey.replace("\u0000", " · ")}
        value={activeValue ?? metricValue(rows, spec.summary)}
      />
      <ChartContainer className="og-active-users-grid" config={config} onPointerLeave={() => setActiveKey(undefined)} role="grid">
        <span aria-hidden="true" />
        {buckets.map((bucket) => <span className="og-active-hour" key={bucket}>{bucket}</span>)}
        {days.flatMap((day) => [
          <span className="og-active-day" key={`${day}-label`}>{day}</span>,
          ...buckets.map((bucket) => {
            const key = `${day}\u0000${bucket}`;
            const value = values.get(key) ?? 0;
            return (
              <button
                aria-label={`${day} ${bucket}: ${formatValue(value, spec.valueFormat)}`}
                className={`og-active-cell og-blue-intensity-${intensity(value, max)}`}
                key={key}
                onBlur={() => setActiveKey(undefined)}
                onFocus={() => setActiveKey(key)}
                onPointerEnter={() => setActiveKey(key)}
                type="button"
              />
            );
          }),
        ])}
      </ChartContainer>
      <div className="og-active-users-scale"><span>Less</span>{[0, 1, 2, 3, 4].map((level) => <i className={`og-blue-intensity-${level}`} key={level} />)}<span>More</span></div>
    </Card>
  );
}

function SignUpFunnel({ rows, spec }: RecipeProps<"sign-up-funnel">) {
  const visible = rows.slice(0, 4);
  const max = Math.max(...visible.map((row) => numeric(row, spec.valueColumn)), 1);
  const [activeIndex, setActiveIndex] = useState<number>();
  const activeRow = activeIndex === undefined ? undefined : visible[activeIndex];
  const segmentWidth = 720 / Math.max(visible.length, 1);
  const chartConfig = Object.fromEntries(visible.map((row, index) => [
    `stage-${index}`,
    { color: THEME_COLORS[index]!, label: text(row, spec.stageColumn) },
  ])) as ChartConfig;
  return (
    <Card className="og-signup-funnel-panel">
      <DashboardHeader
        change={numericValue(metricValue(rows, spec.change))}
        changeFormat={spec.change.format}
        format={spec.summary.format}
        periodLabel={spec.periodLabel}
        title={activeRow === undefined ? spec.title : text(activeRow, spec.stageColumn)}
        value={activeRow?.[spec.valueColumn] ?? metricValue(rows, spec.summary)}
      />
      <ChartContainer className="og-signup-funnel-chart" config={chartConfig}>
        <svg aria-label={spec.accessibility.label} onPointerLeave={() => setActiveIndex(undefined)} role="img" viewBox="0 0 760 220">
          <title>{spec.accessibility.label}</title>
        {visible.map((row, index) => {
          const current = numeric(row, spec.valueColumn);
          const next = index === visible.length - 1 ? current : numeric(visible[index + 1]!, spec.valueColumn);
          const h0 = 46 + 116 * current / max;
          const h1 = 46 + 116 * next / max;
          const x0 = 20 + index * segmentWidth;
          const x1 = x0 + segmentWidth - 2;
          const y0 = 110 - h0 / 2;
          const y1 = 110 - h1 / 2;
          const points = `${x0},${y0} ${x1},${y1} ${x1},${y1 + h1} ${x0},${y0 + h0}`;
          const percentage = numeric(row, spec.conversion.column);
          return (
            <g className={activeIndex === undefined || activeIndex === index ? "og-funnel-stage" : "og-funnel-stage is-dimmed"} key={`${text(row, spec.stageColumn)}-${index}`}>
              <polygon
                className={`og-funnel-track og-tone-${index}`}
                onBlur={() => setActiveIndex(undefined)}
                onFocus={() => setActiveIndex(index)}
                onPointerEnter={() => setActiveIndex(index)}
                points={points}
                tabIndex={0}
              ><title>{`${text(row, spec.stageColumn)}: ${formatValue(current, spec.valueFormat)}`}</title></polygon>
              <rect className="og-funnel-pill" height="26" rx="var(--og-radius-pill)" width="58" x={(x0 + x1) / 2 - 29} y="97" />
              <text className="og-funnel-percent" dominantBaseline="middle" textAnchor="middle" x={(x0 + x1) / 2} y="110">{formatPercent(percentage)}</text>
            </g>
          );
        })}
        </svg>
      </ChartContainer>
      <div className="og-dashboard-card-grid og-funnel-summary-grid">
        {visible.map((row, index) => (
          <DashboardValueCard index={index} key={`${text(row, spec.stageColumn)}-${index}`} label={text(row, spec.stageColumn)} value={formatValue(row[spec.valueColumn], spec.valueFormat)} />
        ))}
      </div>
    </Card>
  );
}

function EarnedSoFarBars({ rows, spec }: RecipeProps<"earned-so-far-bars">) {
  const maximum = Math.max(...rows.map((row) => numeric(row, spec.targetColumn ?? spec.earnedColumn)), 1);
  const chartConfig = { earned: { color: "var(--og-lime)", label: columnLabel(spec, spec.earnedColumn) } } satisfies ChartConfig;
  return (
    <Card className="og-earned-panel">
      <DashboardHeader
        change={numericValue(metricValue(rows, spec.change))}
        changeFormat={spec.change.format}
        format={spec.summary.format}
        tabs
        title={spec.title}
        value={metricValue(rows, spec.summary)}
      />
      <ChartContainer className="og-earned-chart" config={chartConfig} data-chart-mark="bars">
        <ClientChartProjection server={<BarsProjection categoryColumn={spec.periodColumn} format={spec.earnedFormat} rows={rows} targetColumn={spec.targetColumn} valueColumn={spec.earnedColumn} />}>
          <BarChart barCategoryGap="34%" data={rows} height={330} margin={{ top: 16, right: 8, bottom: 0, left: 8 }} width={820}>
            <XAxis axisLine={false} dataKey={spec.periodColumn} tick={axisTick} tickLine={false} />
            <YAxis axisLine={false} domain={[0, maximum]} tick={axisTick} tickFormatter={currencyAxisTick} tickLine={false} ticks={[0, 3000, 5000, 10000]} width={55} />
            <Tooltip content={<ChartTooltipContent format={spec.earnedFormat} />} cursor={{ fill: "var(--og-card)", fillOpacity: 0.5 }} />
            <Bar background={ThemedLargeBarBackground} dataKey={spec.earnedColumn} fill="var(--og-lime)" isAnimationActive={false} name={columnLabel(spec, spec.earnedColumn)} shape={ThemedLargeBarShape} />
          </BarChart>
        </ClientChartProjection>
      </ChartContainer>
    </Card>
  );
}

function ContributionsHeatmap({ rows, spec }: RecipeProps<"contributions-heatmap">) {
  const cells = contributionCells(rows, spec.dateColumn, spec.valueColumn);
  const max = Math.max(...cells.map((cell) => cell.value), 1);
  const [activeKey, setActiveKey] = useState<string>();
  const activeCell = activeKey === undefined ? undefined : cells.find((cell) => cell.key === activeKey);
  const chartConfig = { contributions: { color: "var(--og-violet)", label: columnLabel(spec, spec.valueColumn) } } satisfies ChartConfig;
  return (
    <Card className="og-contributions-panel">
      <DashboardHeader
        change={numericValue(metricValue(rows, spec.change))}
        changeFormat={spec.change.format}
        format={activeCell === undefined ? spec.summary.format : spec.valueFormat}
        title={activeCell === undefined ? spec.title : activeCell.key}
        value={activeCell?.value ?? metricValue(rows, spec.summary)}
      />
      <div className="og-contribution-highlights">
        {spec.highlights.map((metric) => (
          <Card className="og-contribution-highlight" key={metric.column}>
            <strong>{formatContributionHighlight(metric.label ?? columnLabel(spec, metric.column), metricValue(rows, metric), metric.format)}</strong>
            <span>{metric.label ?? columnLabel(spec, metric.column)}</span>
          </Card>
        ))}
      </div>
      <div className="og-contribution-toolbar"><span>Activity</span><TimeframeTabs /></div>
      <ChartContainer className="og-contribution-grid" config={chartConfig} onPointerLeave={() => setActiveKey(undefined)} role="grid">
        {cells.map((cell) => (
          <button
            aria-label={`${cell.key}: ${formatValue(cell.value, spec.valueFormat)}`}
            className={`og-contribution-button og-purple-intensity-${intensity(cell.value, max)}`}
            key={cell.key}
            onBlur={() => setActiveKey(undefined)}
            onFocus={() => setActiveKey(cell.key)}
            onPointerEnter={() => setActiveKey(cell.key)}
            style={{ gridColumn: cell.week + 1, gridRow: cell.day + 1 }}
            type="button"
          />
        ))}
      </ChartContainer>
      <div className="og-contribution-months">{["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((month) => <span key={month}>{month}</span>)}</div>
    </Card>
  );
}

function SessionsConversionCombo({ rows, spec }: RecipeProps<"sessions-conversion-combo">) {
  const chartConfig = {
    sessions: { color: "var(--og-lime)", label: columnLabel(spec, spec.sessionsColumn) },
    conversion: { color: "var(--og-blue)", label: columnLabel(spec, spec.conversionColumn) },
  } satisfies ChartConfig;
  return (
    <Card className="og-combo-panel">
      <DashboardHeader
        change={numericValue(metricValue(rows, spec.change))}
        changeFormat={spec.change.format}
        format={spec.sessionsSummary.format}
        periodLabel={spec.periodLabel}
        title={spec.title}
        value={metricValue(rows, spec.sessionsSummary)}
      />
      <ChartContainer className="og-combo-chart" config={chartConfig} data-chart-mark="bar line">
        <ClientChartProjection server={<ComboProjection rows={rows} spec={spec} />}>
          <ComposedChart data={rows} height={320} margin={{ top: 14, right: 16, bottom: 0, left: 8 }} width={760}>
            <CartesianGrid stroke="var(--og-chart-grid)" strokeDasharray="3 5" vertical={false} />
            <XAxis axisLine={false} dataKey={spec.timeColumn} tick={axisTick} tickFormatter={timeTick} tickLine={false} />
            <YAxis axisLine={false} domain={[0, 10500]} tick={axisTick} tickFormatter={compactAxisTick} tickLine={false} ticks={[0, 3500, 7000, 10500]} width={52} yAxisId="sessions" />
            <YAxis axisLine={false} domain={[0, 0.06]} orientation="right" tick={axisTick} tickFormatter={percentAxisTick} tickLine={false} ticks={[0, 0.02, 0.04, 0.06]} width={42} yAxisId="conversion" />
            <Tooltip content={<ChartTooltipContent />} cursor={{ fill: "var(--og-card)", fillOpacity: 0.55 }} />
            <Bar dataKey={spec.sessionsColumn} fill="var(--og-lime)" isAnimationActive={false} name={columnLabel(spec, spec.sessionsColumn)} shape={ThemedBarShape} yAxisId="sessions" />
            <Line activeDot={{ fill: "var(--og-blue)", r: 5, stroke: "var(--og-surface)", strokeWidth: 3 }} dataKey={spec.conversionColumn} dot={{ fill: "var(--og-blue)", r: 3, stroke: "var(--og-surface)", strokeWidth: 2 }} isAnimationActive={false} name={columnLabel(spec, spec.conversionColumn)} stroke="var(--og-blue)" strokeWidth={3} type="monotone" yAxisId="conversion" />
          </ComposedChart>
        </ClientChartProjection>
      </ChartContainer>
      <div className="og-dashboard-card-grid og-combo-summary-grid">
        <DashboardValueCard index={0} label={`${columnLabel(spec, spec.sessionsColumn)} · total`} value={formatValue(metricValue(rows, spec.sessionsSummary), spec.sessionsSummary.format)} />
        <DashboardValueCard index={1} label={`${columnLabel(spec, spec.conversionColumn)} · average`} value={formatValue(metricValue(rows, spec.conversionSummary), spec.conversionSummary.format)} />
      </div>
    </Card>
  );
}

function DevicesBars({ rows, spec }: RecipeProps<"devices-bars">) {
  const visible = rows.slice(0, 3);
  return (
    <Card className="og-devices-panel">
      <header className="og-devices-tabs">
        <Tabs defaultValue="devices">
          <TabsList>
            <TabsTrigger value="devices">Devices</TabsTrigger>
            <TabsTrigger value="browsers">Browsers</TabsTrigger>
            <TabsTrigger value="operating-systems">Operating systems</TabsTrigger>
          </TabsList>
        </Tabs>
        <span>{spec.summary?.label ?? "Visitors"}</span>
      </header>
      <div className="og-device-list" role="img" aria-label={spec.accessibility.label}>
        {visible.map((row, index) => {
          const label = text(row, spec.deviceColumn);
          const value = numeric(row, spec.valueColumn);
          const Icon = deviceIcon(label);
          return (
            <div className="og-device-row" key={`${label}-${index}`}>
              <Progress className="og-device-progress" indicatorClassName="og-device-progress-value" value={value * 100} />
              <span className="og-device-label"><Icon aria-hidden="true" size={17} strokeWidth={1.8} /><span>{label}</span></span>
              <strong>{formatValue(value, spec.valueFormat)}</strong>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function VisitorsStackedArea({ instanceId, rows, spec }: RecipeProps<"visitors-stacked-area"> & { instanceId: string }) {
  const chartConfig = Object.fromEntries(spec.series.map((series, index) => [
    series.column,
    { color: THEME_COLORS[index]!, label: series.label ?? columnLabel(spec, series.column) },
  ])) as ChartConfig;
  return (
    <Card className="og-stacked-area-panel">
      <DashboardHeader
        change={numericValue(metricValue(rows, spec.change))}
        changeFormat={spec.change.format}
        format={spec.summary.format}
        periodLabel={spec.periodLabel}
        title={spec.title}
        value={metricValue(rows, spec.summary)}
      />
      <ChartContainer className="og-stacked-area-chart" config={chartConfig} data-chart-mark="stacked-area">
        <ClientChartProjection server={<StackedAreaProjection rows={rows} spec={spec} />}>
          <AreaChart data={rows} height={330} margin={{ top: 16, right: 10, bottom: 2, left: 8 }} width={760}>
            <defs>{spec.series.map((series, index) => <linearGradient id={`og-stack-${instanceId}-${index}`} key={series.column} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={THEME_COLORS[index % THEME_COLORS.length]} stopOpacity="0.78" /><stop offset="100%" stopColor={THEME_COLORS[index % THEME_COLORS.length]} stopOpacity="0.2" /></linearGradient>)}</defs>
            <CartesianGrid stroke="var(--og-chart-grid)" strokeDasharray="3 5" vertical={false} />
            <XAxis axisLine={false} dataKey={spec.timeColumn} tick={axisTick} tickFormatter={timeTick} tickLine={false} />
            <YAxis axisLine={false} domain={[0, 13500]} tick={axisTick} tickFormatter={compactAxisTick} tickLine={false} ticks={[0, 4500, 9000, 13500]} width={52} />
            <Tooltip content={<ChartTooltipContent />} cursor={{ stroke: MUTED, strokeDasharray: "3 3" }} />
            {spec.series.map((series, index) => <Area dataKey={series.column} fill={`url(#og-stack-${instanceId}-${index})`} isAnimationActive={false} key={series.column} name={series.label ?? columnLabel(spec, series.column)} stackId="visitors" stroke={THEME_COLORS[index]} strokeWidth={2.5} type="monotone" />)}
          </AreaChart>
        </ClientChartProjection>
      </ChartContainer>
      <div className="og-dashboard-card-grid og-stacked-area-summary">
        {spec.series.map((series, index) => (
          <DashboardValueCard
            index={index}
            key={series.column}
            label={series.label ?? columnLabel(spec, series.column)}
            value={formatValue(rows.reduce((sum, row) => sum + numeric(row, series.column), 0), series.format)}
          />
        ))}
      </div>
    </Card>
  );
}

function ActivityRings({ rows, spec }: RecipeProps<"activity-rings">) {
  const visible = rows.slice(0, 3);
  const [activeIndex, setActiveIndex] = useState<number>();
  const chartConfig = Object.fromEntries(visible.map((row, index) => [
    `activity-${index}`,
    { color: activityColor(index), label: text(row, spec.activityColumn) },
  ])) as ChartConfig;
  return (
    <Card className="og-activity-rings-panel">
      <h3>{spec.title}</h3>
      <div className="og-activity-stat-grid">
        {visible.map((row, index) => (
          <DashboardValueCard index={activityTone(index)} key={`${text(row, spec.activityColumn)}-${index}`} label={text(row, spec.activityColumn)} value={text(row, spec.detailColumn)} />
        ))}
      </div>
      <ChartContainer className="og-activity-rings-chart" config={chartConfig}>
        <svg aria-label={spec.accessibility.label} onPointerLeave={() => setActiveIndex(undefined)} role="img" viewBox="0 0 360 360">
          <title>{spec.accessibility.label}</title>
          {visible.map((row, index) => {
            const radius = 142 - index * 42;
            const circumference = 2 * Math.PI * radius;
            const ratio = clamp(numeric(row, spec.valueColumn) / Math.max(numeric(row, spec.targetColumn), 1), 0, 1);
            return (
              <g className={activeIndex === undefined || activeIndex === index ? "og-activity-ring" : "og-activity-ring is-dimmed"} key={`${text(row, spec.activityColumn)}-${index}`}>
                <circle className={`og-activity-ring-track og-activity-tone-${index}`} cx="180" cy="180" fill="none" r={radius} strokeWidth="30" />
                <circle
                  className={`og-activity-ring-value og-activity-tone-${index}`}
                  cx="180"
                  cy="180"
                  fill="none"
                  onBlur={() => setActiveIndex(undefined)}
                  onFocus={() => setActiveIndex(index)}
                  onPointerEnter={() => setActiveIndex(index)}
                  r={radius}
                  strokeDasharray={`${circumference * ratio} ${circumference}`}
                  strokeLinecap="round"
                  strokeWidth="30"
                  tabIndex={0}
                  transform="rotate(-90 180 180)"
                ><title>{`${text(row, spec.activityColumn)}: ${text(row, spec.detailColumn)}`}</title></circle>
              </g>
            );
          })}
        </svg>
      </ChartContainer>
    </Card>
  );
}

function DashboardHeader({ change, changeFormat, format, periodLabel, tabs = false, title, value }: {
  change: number;
  changeFormat: FormatToken | undefined;
  format: FormatToken | undefined;
  periodLabel?: string;
  tabs?: boolean;
  title: string;
  value: ChartCellValue | undefined;
}) {
  return (
    <header className="og-dashboard-header">
      <div className="og-dashboard-heading">
        <h3>{title}</h3>
        <div>
          <strong>{formatValue(value, format)}</strong>
          <Badge variant="positive">{change > 0 ? "+" : ""}{formatValue(change, changeFormat)}</Badge>
        </div>
      </div>
      {tabs ? <TimeframeTabs /> : periodLabel ? <PeriodControl label={periodLabel} /> : null}
    </header>
  );
}

function PeriodControl({ label }: { label: string }) {
  return (
    <Button aria-label={`Period: ${label}`} className="og-dashboard-period" disabled variant="outline">
      <CalendarDays aria-hidden="true" />
      <span>{label}</span>
      <ChevronDown aria-hidden="true" />
    </Button>
  );
}

function TimeframeTabs() {
  return (
    <Tabs className="og-timeframe-tabs" defaultValue="weekly">
      <TabsList>
        <TabsTrigger value="weekly">Weekly</TabsTrigger>
        <TabsTrigger value="monthly">Monthly</TabsTrigger>
        <TabsTrigger value="yearly">Yearly</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function DashboardValueCard({ index, label, value }: { index: number; label: string; value: string }) {
  return (
    <Card className={`og-dashboard-value-card og-tone-${index}`}>
      <div><i aria-hidden="true" /><span>{label}</span></div>
      <strong>{value}</strong>
    </Card>
  );
}

function MiniActivityRings({ row, series }: { row: DataRow | undefined; series: readonly ChartSeriesColumn[] }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 44 44">
      {series.map((entry, index) => {
        const radius = 18 - index * 5;
        const circumference = 2 * Math.PI * radius;
        const ratio = row === undefined ? 0 : activityRatio(entry.label ?? entry.column, numeric(row, entry.column));
        return (
          <g key={entry.column}>
            <circle className={`og-mini-ring-track og-activity-tone-${index}`} cx="22" cy="22" fill="none" r={radius} strokeWidth="3" />
            <circle className={`og-mini-ring-value og-activity-tone-${index}`} cx="22" cy="22" fill="none" r={radius} strokeDasharray={`${circumference * ratio} ${circumference}`} strokeLinecap="round" strokeWidth="3" transform="rotate(-90 22 22)" />
          </g>
        );
      })}
    </svg>
  );
}

function ActivityRingsSvg({ row, series }: { row: DataRow; series: readonly ChartSeriesColumn[] }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 360 360">
      {series.map((entry, index) => {
        const radius = 142 - index * 42;
        const circumference = 2 * Math.PI * radius;
        const ratio = activityRatio(entry.label ?? entry.column, numeric(row, entry.column));
        return (
          <g key={entry.column}>
            <circle className={`og-activity-ring-track og-activity-tone-${index}`} cx="180" cy="180" fill="none" r={radius} strokeWidth="30" />
            <circle className={`og-activity-ring-value og-activity-tone-${index}`} cx="180" cy="180" fill="none" r={radius} strokeDasharray={`${circumference * ratio} ${circumference}`} strokeLinecap="round" strokeWidth="30" transform="rotate(-90 180 180)" />
          </g>
        );
      })}
    </svg>
  );
}

function activityRatio(label: string, value: number): number {
  const normalized = label.toLowerCase();
  const target = normalized.includes("move") ? 900 : normalized.includes("exercise") ? 120 : 6.5;
  return clamp(value / target, 0, 1);
}

function activityTone(index: number): number {
  return [3, 0, 1][index] ?? index;
}

function ThemedBarShape(props: BarShapeProps) {
  return <ThemedBarRect {...props} themedRadius="var(--og-radius-bar)" />;
}

function ThemedLargeBarShape(props: BarShapeProps) {
  return <ThemedBarRect {...props} themedRadius="var(--og-radius-large)" />;
}

function ThemedLargeBarBackground(props: BarShapeProps) {
  return <ThemedBarRect {...props} fill="var(--og-progress-track)" themedRadius="var(--og-radius-large)" />;
}

function ThemedBarRect({ fill, height, themedRadius, width, x, y }: BarShapeProps & { themedRadius: string }) {
  return (
    <rect
      fill={fill}
      height={Math.max(height, 0)}
      rx={themedRadius}
      width={Math.max(width, 0)}
      x={x}
      y={y}
    />
  );
}

function activityColor(index: number): string {
  return ["var(--og-pink)", "var(--og-lime)", "var(--og-blue)"][index] ?? "var(--og-muted)";
}

function activityChartConfig(series: readonly ChartSeriesColumn[]): ChartConfig {
  return Object.fromEntries(series.map((entry, index) => [
    entry.column,
    { color: activityColor(index), label: entry.label ?? entry.column },
  ]));
}

function formatActivityDetail(label: string, value: number): string {
  const normalized = label.toLowerCase();
  if (normalized.includes("move")) return `${formatValue(value, { kind: "number", notation: "standard", maximumFractionDigits: 0 })} kcal`;
  if (normalized.includes("exercise")) return `${Math.floor(value / 60)}h ${Math.round(value % 60)}m`;
  return `${formatValue(value, { kind: "number", notation: "standard", maximumFractionDigits: 1 })} km`;
}

function formatContributionHighlight(label: string, value: ChartCellValue | undefined, format: FormatToken | undefined): string {
  const number = numericValue(value);
  const normalized = label.toLowerCase();
  if (normalized.includes("longest")) return `${Math.floor(number)}h ${Math.round((number % 1) * 60)}m`;
  if (normalized.includes("streak")) return `${formatValue(number, format)} days`;
  return formatValue(value, format);
}

function currencyAxisTick(value: number): string {
  return value === 0 ? "$0" : `$${Math.round(value / 1000)}K`;
}

function compactAxisTick(value: number): string {
  return value === 0 ? "0" : value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : String(value);
}

function percentAxisTick(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const subscribeHydration = () => () => undefined;

function ClientChartProjection({ children, server }: { children: ReactNode; server: ReactNode }) {
  const hydrated = useSyncExternalStore(subscribeHydration, () => true, () => false);
  return hydrated ? children : server;
}

function BarsProjection({ categoryColumn, format, rows, targetColumn, valueColumn }: {
  categoryColumn: string;
  format?: FormatToken;
  rows: DataRow[];
  targetColumn: string | undefined;
  valueColumn: string;
}) {
  const visible = rows.slice(0, 12);
  const candidates = visible.flatMap((row) => [numeric(row, valueColumn), ...(targetColumn ? [numeric(row, targetColumn)] : [])]);
  const max = Math.max(...candidates, 1);
  const plot = { bottom: 206, left: 32, right: 620, top: 16 } as const;
  const step = (plot.right - plot.left) / Math.max(visible.length, 1);
  const barWidth = Math.min(34, step * 0.52);
  return (
    <svg aria-hidden="true" className="og-server-chart" viewBox="0 0 640 238">
      {[0, 1, 2, 3].map((index) => {
        const y = plot.top + index * (plot.bottom - plot.top) / 3;
        return <line key={index} stroke={GRID} strokeDasharray="2 4" x1={plot.left} x2={plot.right} y1={y} y2={y} />;
      })}
      {visible.map((row, index) => {
        const value = numeric(row, valueColumn);
        const target = targetColumn ? numeric(row, targetColumn) : undefined;
        const x = plot.left + index * step + (step - barWidth) / 2;
        const valueHeight = value / max * (plot.bottom - plot.top);
        const targetHeight = target === undefined ? 0 : target / max * (plot.bottom - plot.top);
        return (
          <g key={`${text(row, categoryColumn)}-${index}`}>
            {target !== undefined ? <rect fill="var(--og-progress-track)" height={targetHeight} rx="var(--og-radius-mark)" width={barWidth} x={x} y={plot.bottom - targetHeight}><title>{`Target: ${formatValue(target, format)}`}</title></rect> : null}
            <rect fill={THEME_COLORS[0]} height={valueHeight} rx="var(--og-radius-mark)" width={target === undefined ? barWidth : barWidth * 0.64} x={target === undefined ? x : x + barWidth * 0.18} y={plot.bottom - valueHeight}><title>{`${text(row, categoryColumn)}: ${formatValue(value, format)}`}</title></rect>
            <text className="og-heatmap-axis" textAnchor="middle" x={x + barWidth / 2} y="226">{text(row, categoryColumn)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function ScatterProjection({ rows, spec }: RecipeProps<"revenue-per-account-scatter">) {
  const groups = unique(rows.map((row) => text(row, spec.groupColumn)));
  const sizes = rows.map((row) => numeric(row, spec.sizeColumn));
  const sizeRange = numericRange(sizes);
  const plot = { bottom: 166, left: 60, right: 560, top: 8 } as const;
  return (
    <svg aria-hidden="true" className="og-server-chart" viewBox="0 0 576 220">
      {[0, 550, 1100, 1700].map((value) => {
        const y = scale(value, [0, 1700], [plot.bottom, plot.top]);
        return <g key={value}><line stroke="var(--og-chart-grid)" strokeDasharray="3 5" x1={plot.left} x2={plot.right} y1={y} y2={y} /><text className="og-revenue-axis-tick" textAnchor="end" x="51" y={y + 4}>{formatValue(value, spec.revenueFormat)}</text></g>;
      })}
      {[0, 25, 50, 75, 100].map((value) => {
        const x = scale(value, [0, 100], [plot.left, plot.right]);
        return <g key={value}><line stroke="var(--og-chart-grid)" strokeDasharray="3 5" x1={x} x2={x} y1={plot.top} y2={plot.bottom} /><text className="og-revenue-axis-tick" textAnchor="middle" x={x} y="190">{formatValue(value, spec.comparisonFormat)}</text></g>;
      })}
      {rows.map((row, index) => {
        const xValue = numeric(row, spec.comparisonColumn);
        const yValue = numeric(row, spec.revenueColumn);
        const sizeValue = sizes[index]!;
        const groupIndex = groups.indexOf(text(row, spec.groupColumn));
        const x = scale(xValue, [0, 100], [plot.left, plot.right]);
        const y = scale(yValue, [0, 1700], [plot.bottom, plot.top]);
        const radius = scale(sizeValue, sizeRange, [7, 14]);
        return <circle className={`og-revenue-projection-point og-revenue-tone-${groupIndex}`} cx={x} cy={y} key={index} r={radius}><title>{`${text(row, spec.accountColumn)}: ${formatValue(yValue, spec.revenueFormat)}`}</title></circle>;
      })}
    </svg>
  );
}

function RadarProjection({ rows, spec }: RecipeProps<"visitors-radar">) {
  const visible = rows.slice(0, 12);
  const compared = spec.comparisonColumn ? visible.flatMap((row) => [numeric(row, spec.valueColumn), numeric(row, spec.comparisonColumn!)]) : visible.map((row) => numeric(row, spec.valueColumn));
  const max = Math.max(...compared, 1);
  const center = { x: 320, y: 140 };
  const radius = 96;
  const polygon = (column: string) => visible.map((row, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.max(visible.length, 1);
    const valueRadius = numeric(row, column) / max * radius;
    return `${(center.x + Math.cos(angle) * valueRadius).toFixed(1)},${(center.y + Math.sin(angle) * valueRadius).toFixed(1)}`;
  }).join(" ");
  return (
    <svg aria-hidden="true" className="og-server-chart" viewBox="0 0 640 286">
      {[0.25, 0.5, 0.75, 1].map((ratio) => <polygon fill="none" key={ratio} points={regularPolygon(center.x, center.y, radius * ratio, visible.length)} stroke={GRID} />)}
      {visible.map((row, index) => {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / visible.length;
        return <text className="og-svg-label" dominantBaseline="middle" key={index} textAnchor={Math.cos(angle) > 0.2 ? "start" : Math.cos(angle) < -0.2 ? "end" : "middle"} x={center.x + Math.cos(angle) * 119} y={center.y + Math.sin(angle) * 119}>{text(row, spec.dimensionColumn)}</text>;
      })}
      {spec.comparisonColumn ? <polygon fill={THEME_COLORS[1]} fillOpacity="0.09" points={polygon(spec.comparisonColumn)} stroke={THEME_COLORS[1]} strokeWidth="2"><title>{columnLabel(spec, spec.comparisonColumn)}</title></polygon> : null}
      <polygon fill={THEME_COLORS[0]} fillOpacity="0.24" points={polygon(spec.valueColumn)} stroke={THEME_COLORS[0]} strokeWidth="2.5"><title>{columnLabel(spec, spec.valueColumn)}</title></polygon>
    </svg>
  );
}

function AreaProjection({ format, rows, timeColumn, valueColumn }: {
  format?: FormatToken;
  rows: DataRow[];
  timeColumn: string;
  valueColumn: string;
}) {
  const values = rows.map((row) => numeric(row, valueColumn));
  const points = cartesianPoints(values, 40, 614, 24, 208);
  const line = pathFromPoints(points);
  const area = points.length === 0 ? "" : `${line} L${points.at(-1)!.x} 208 L${points[0]!.x} 208 Z`;
  return (
    <svg aria-hidden="true" className="og-server-chart" viewBox="0 0 640 252">
      {[0, 1, 2, 3].map((index) => <line key={index} stroke={GRID} strokeDasharray="2 4" x1="34" x2="620" y1={24 + index * 61} y2={24 + index * 61} />)}
      <path d={area} fill={THEME_COLORS[0]} fillOpacity="0.26"><title>{rows.map((row) => `${text(row, timeColumn)}: ${formatValue(row[valueColumn], format)}`).join(", ")}</title></path>
      <path d={line} fill="none" stroke={THEME_COLORS[0]} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
      {axisLabels(rows, timeColumn, 40, 614, 242)}
    </svg>
  );
}

function ComboProjection({ rows, spec }: RecipeProps<"sessions-conversion-combo">) {
  const sessions = rows.map((row) => numeric(row, spec.sessionsColumn));
  const conversions = rows.map((row) => numeric(row, spec.conversionColumn));
  const sessionMax = Math.max(...sessions, 1);
  const conversionPoints = cartesianPoints(conversions, 54, 610, 24, 212);
  const step = 556 / Math.max(rows.length, 1);
  const width = Math.min(36, step * 0.56);
  return (
    <svg aria-hidden="true" className="og-server-chart" viewBox="0 0 640 264">
      {[0, 1, 2, 3].map((index) => <line key={index} stroke={GRID} strokeDasharray="2 4" x1="42" x2="620" y1={24 + index * 62} y2={24 + index * 62} />)}
      {rows.map((row, index) => {
        const height = sessions[index]! / sessionMax * 188;
        const x = 54 + index * step - width / 2;
        return <rect fill={THEME_COLORS[1]} height={height} key={index} rx="var(--og-radius-mark)" width={width} x={x} y={212 - height}><title>{`${text(row, spec.timeColumn)}: ${formatValue(row[spec.sessionsColumn], spec.sessionsFormat)}`}</title></rect>;
      })}
      <path d={pathFromPoints(conversionPoints)} fill="none" stroke={THEME_COLORS[3]} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3"><title>{columnLabel(spec, spec.conversionColumn)}</title></path>
      {conversionPoints.map((point, index) => <circle cx={point.x} cy={point.y} fill={THEME_COLORS[3]} key={index} r="3.5" />)}
      {axisLabels(rows, spec.timeColumn, 54, 610, 252)}
    </svg>
  );
}

function StackedAreaProjection({ rows, spec }: RecipeProps<"visitors-stacked-area">) {
  const totals = rows.map((row) => spec.series.reduce((sum, series) => sum + numeric(row, series.column), 0));
  const max = Math.max(...totals, 1);
  let lower = rows.map(() => 0);
  return (
    <svg aria-hidden="true" className="og-server-chart" viewBox="0 0 640 260">
      {[0, 1, 2, 3].map((index) => <line key={index} stroke={GRID} strokeDasharray="2 4" x1="34" x2="620" y1={22 + index * 63} y2={22 + index * 63} />)}
      {spec.series.map((series, seriesIndex) => {
        const upper = rows.map((row, index) => lower[index]! + numeric(row, series.column));
        const upperPoints = stackedPoints(upper, max, 40, 614, 22, 211);
        const lowerPoints = stackedPoints(lower, max, 40, 614, 22, 211).reverse();
        const path = polygonPath([...upperPoints, ...lowerPoints]);
        lower = upper;
        return <path d={path} fill={THEME_COLORS[seriesIndex % THEME_COLORS.length]} fillOpacity={0.56 + seriesIndex * 0.05} key={series.column} stroke={THEME_COLORS[seriesIndex % THEME_COLORS.length]} strokeWidth="1.5"><title>{series.label ?? series.column}</title></path>;
      })}
      {axisLabels(rows, spec.timeColumn, 40, 614, 250)}
    </svg>
  );
}

type Point = { x: number; y: number };

function numericRange(values: number[]): readonly [number, number] {
  const minimum = Math.min(...values, 0);
  const maximum = Math.max(...values, 1);
  return minimum === maximum ? [minimum, minimum + 1] : [minimum, maximum];
}

function scale(value: number, domain: readonly [number, number], range: readonly [number, number]): number {
  return range[0] + (value - domain[0]) / Math.max(domain[1] - domain[0], 1) * (range[1] - range[0]);
}

function cartesianPoints(values: number[], left: number, right: number, top: number, bottom: number): Point[] {
  const range = numericRange(values);
  return values.map((value, index) => ({
    x: values.length === 1 ? (left + right) / 2 : left + index / (values.length - 1) * (right - left),
    y: scale(value, range, [bottom, top]),
  }));
}

function stackedPoints(values: number[], maximum: number, left: number, right: number, top: number, bottom: number): Point[] {
  return values.map((value, index) => ({
    x: values.length === 1 ? (left + right) / 2 : left + index / (values.length - 1) * (right - left),
    y: bottom - value / maximum * (bottom - top),
  }));
}

function pathFromPoints(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
}

function polygonPath(points: Point[]): string {
  return points.length === 0 ? "" : `${pathFromPoints(points)} Z`;
}

function regularPolygon(cx: number, cy: number, radius: number, sides: number): string {
  return Array.from({ length: sides }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.max(sides, 1);
    return `${(cx + Math.cos(angle) * radius).toFixed(1)},${(cy + Math.sin(angle) * radius).toFixed(1)}`;
  }).join(" ");
}

function axisLabels(rows: DataRow[], column: string, left: number, right: number, y: number): ReactNode[] {
  const visibleIndexes = rows.length <= 8
    ? rows.map((_, index) => index)
    : rows.map((_, index) => index).filter((index) => index % Math.ceil(rows.length / 6) === 0 || index === rows.length - 1);
  return visibleIndexes.map((index) => {
    const x = rows.length === 1 ? (left + right) / 2 : left + index / (rows.length - 1) * (right - left);
    return <text className="og-heatmap-axis" key={index} textAnchor="middle" x={x} y={y}>{timeTick(rows[index]![column])}</text>;
  });
}

type RecipeProps<TRecipe extends UIResolvedChartSpec["recipe"]> = Readonly<{
  rows: DataRow[];
  spec: RecipeSpec<TRecipe>;
}>;

function RecipeLayout({ children, header }: { children: ReactNode; header: ReactNode }) {
  return <div className="og-recipe-layout">{header}<div className="og-recipe-body">{children}</div></div>;
}

function RecipeHeader({ children, spec }: { children?: ReactNode; spec: UIResolvedChartSpec }) {
  return (
    <header className="og-chart-header">
      <div className="og-chart-heading"><h3>{spec.title}</h3>{spec.subtitle ? <p>{spec.subtitle}</p> : null}</div>
      {children ? <div className="og-chart-summary">{children}</div> : null}
    </header>
  );
}

function SummaryStat({ metric, spec, value }: { metric: ChartMetric; spec: UIResolvedChartSpec; value: ChartCellValue | undefined }) {
  return (
    <div className="og-summary-stat">
      <span>{metric.label ?? columnLabel(spec, metric.column)}</span>
      <strong>{formatValue(value, metric.format)}</strong>
    </div>
  );
}

function ChartTooltipContent({ active, format, label, labelColumn, payload }: {
  active?: boolean;
  format?: FormatToken;
  label?: ChartCellValue;
  labelColumn?: string;
  payload?: readonly Readonly<{ color?: string; name?: ReactNode; payload?: DataRow; value?: ChartCellValue }>[];
}) {
  if (!active || !payload?.length) return null;
  const resolvedLabel = labelColumn === undefined ? label : payload[0]?.payload?.[labelColumn];
  return (
    <div className="og-chart-tooltip">
      {resolvedLabel !== undefined ? <strong>{String(resolvedLabel)}</strong> : null}
      {payload.map((entry, index) => <div key={`${String(entry.name)}-${index}`}><i className={`og-accent-bg-${index % THEME_COLORS.length}`} /><span>{entry.name}</span><b>{formatValue(entry.value, format)}</b></div>)}
    </div>
  );
}

function RevenueScatterTooltip({ row, spec, style }: {
  row: DataRow;
  spec: RecipeSpec<"revenue-per-account-scatter">;
  style: CSSProperties | undefined;
}) {
  return (
    <Card className="og-revenue-scatter-tooltip" style={style}>
      <header><strong>{text(row, spec.accountColumn)}</strong><span>{text(row, spec.groupColumn)}</span></header>
      <div><span>{columnLabel(spec, spec.revenueColumn)}</span><strong>{formatValue(row[spec.revenueColumn], spec.revenueFormat)}</strong></div>
      <div><span>{columnLabel(spec, spec.comparisonColumn)}</span><strong>{formatValue(row[spec.comparisonColumn], spec.comparisonFormat)}</strong></div>
    </Card>
  );
}

function revenueScatterTooltipStyle(comparison: number, revenue: number): CSSProperties {
  const x = 11.8 + clamp(comparison, 0, 100) * 0.84;
  const top = clamp(17 + (1 - clamp(revenue, 0, 1700) / 1700) * 43, 18, 57);
  return x > 55
    ? { right: `${clamp(102 - x, 2, 78)}%`, top: `${top}%` }
    : { left: `${clamp(x + 2, 2, 72)}%`, top: `${top}%` };
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

function metricValue(rows: DataRow[], metric: ChartMetric): ChartCellValue | undefined {
  const values = rows.map((row) => row[metric.column]).filter((value): value is ChartCellValue => value !== undefined);
  if (metric.aggregate === "count") return values.length;
  if (metric.aggregate === "distinct-count") return new Set(values.map((value) => JSON.stringify(value))).size;
  if (metric.aggregate === "first") return values[0];
  if (metric.aggregate === "last") return values.at(-1);
  const numbers = values.map(asFiniteNumber).filter((value): value is number => value !== undefined);
  if (numbers.length === 0) return undefined;
  if (metric.aggregate === "sum") return numbers.reduce((sum, value) => sum + value, 0);
  if (metric.aggregate === "average") return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  if (metric.aggregate === "minimum") return Math.min(...numbers);
  if (metric.aggregate === "maximum") return Math.max(...numbers);
  return undefined;
}

function columnLabel(spec: UIResolvedChartSpec, columnId: string): string {
  return spec.data.columns.find((column) => column.columnId === columnId)?.label ?? columnId;
}

function numeric(row: DataRow, column: string): number {
  return asFiniteNumber(row[column]) ?? 0;
}

function numericValue(value: ChartCellValue | undefined): number {
  return asFiniteNumber(value) ?? 0;
}

function text(row: DataRow, column: string): string {
  const value = row[column];
  return value === null || value === undefined ? "-" : String(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function intensity(value: number, maximum: number): number {
  if (value <= 0 || maximum <= 0) return 0;
  return clamp(Math.ceil(value / maximum * 4), 1, 4);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 }).format(value);
}

function timeTick(value: ChartCellValue | undefined): string {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

const axisTick = { fill: "var(--og-muted-foreground)", fontSize: 11 } as const;

type TrackedTimeNode = { height: number; index: number; name: string; value: number; y: number };
type TrackedTimeEdge = { path: string; source: string; sourceIndex: number; target: string; value: number };

function trackedTimeLayout(rows: DataRow[], sourceColumn: string, targetColumn: string, valueColumn: string): { edges: TrackedTimeEdge[]; sources: TrackedTimeNode[]; targets: TrackedTimeNode[] } {
  const edges = rows.map((row) => ({ source: text(row, sourceColumn), target: text(row, targetColumn), value: Math.max(0, numeric(row, valueColumn)) })).filter((edge) => edge.value > 0);
  const sourceTotals = totalsBy(edges, "source");
  const targetTotals = totalsBy(edges, "target");
  const sources = trackedTimeNodes(sourceTotals, 118);
  const targets = trackedTimeNodes(targetTotals, 90);
  const sourceByName = new Map(sources.map((node) => [node.name, node]));
  const targetByName = new Map(targets.map((node) => [node.name, node]));
  const sourceOffsets = new Map<string, number>();
  const targetOffsets = new Map<string, number>();
  const flowEdges = edges.map((edge) => {
    const source = sourceByName.get(edge.source)!;
    const target = targetByName.get(edge.target)!;
    const thickness = edge.value * 3;
    const sourceOffset = sourceOffsets.get(edge.source) ?? 0;
    const targetOffset = targetOffsets.get(edge.target) ?? 0;
    const y0 = source.y + sourceOffset;
    const y1 = target.y + targetOffset;
    sourceOffsets.set(edge.source, sourceOffset + thickness);
    targetOffsets.set(edge.target, targetOffset + thickness);
    const path = `M116 ${y0} C245 ${y0},365 ${y1},494 ${y1} L494 ${y1 + thickness} C365 ${y1 + thickness},245 ${y0 + thickness},116 ${y0 + thickness} Z`;
    return { path, source: edge.source, sourceIndex: source.index, target: edge.target, value: edge.value };
  });
  return { edges: flowEdges, sources, targets };
}

function totalsBy(edges: readonly { source: string; target: string; value: number }[], side: "source" | "target"): Map<string, number> {
  const result = new Map<string, number>();
  for (const edge of edges) result.set(edge[side], (result.get(edge[side]) ?? 0) + edge.value);
  return result;
}

function trackedTimeNodes(totals: Map<string, number>, startY: number): TrackedTimeNode[] {
  let y = startY;
  return [...totals].map(([name, value], index) => {
    const height = value * 3;
    const node = { height, index, name, value, y };
    y += height + 14;
    return node;
  });
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
type CalendarCell = { date: Date; day: number; key: string; value: number; week: number };

function monthCalendarCells(rows: DataRow[], dateColumn: string, valueColumn: string): CalendarCell[] {
  const dated = rows.map((row) => ({ date: parseDate(row[dateColumn]), value: numeric(row, valueColumn) })).filter((item): item is { date: Date; value: number } => item.date !== undefined).sort((a, b) => a.date.getTime() - b.date.getTime());
  if (dated.length === 0) return [];
  const month = dated.at(-1)!.date;
  const first = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  const values = new Map(dated.map((item) => [dateKey(item.date), item.value]));
  const cells: CalendarCell[] = [];
  for (let day = 1; day <= last.getUTCDate(); day += 1) {
    const date = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day));
    const offset = first.getUTCDay() + day - 1;
    cells.push({ date, day: offset % 7, key: dateKey(date), value: values.get(dateKey(date)) ?? 0, week: Math.floor(offset / 7) });
  }
  return cells;
}

function contributionCells(rows: DataRow[], dateColumn: string, valueColumn: string): CalendarCell[] {
  const dated = rows.map((row) => ({ date: parseDate(row[dateColumn]), value: numeric(row, valueColumn) })).filter((item): item is { date: Date; value: number } => item.date !== undefined).sort((a, b) => a.date.getTime() - b.date.getTime());
  if (dated.length === 0) return [];
  const start = new Date(dated[0]!.date);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  return dated.map(({ date, value }) => {
    const days = Math.floor((date.getTime() - start.getTime()) / 86_400_000);
    return { date, day: date.getUTCDay(), key: dateKey(date), value, week: Math.floor(days / 7) };
  });
}

function parseDate(value: ChartCellValue | undefined): Date | undefined {
  if (value === null || value === undefined || typeof value === "boolean") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fullWeekday(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(date);
}

function formatDateRange(start: string, end: string, locale: string): string {
  const formatter = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  return `${formatter.format(new Date(start))} - ${formatter.format(new Date(end))}`;
}

function deviceIcon(label: string): LucideIcon {
  const normalized = label.toLowerCase();
  if (normalized.includes("phone") || normalized.includes("mobile")) return Smartphone;
  if (normalized.includes("tablet") || normalized.includes("ipad")) return Tablet;
  if (normalized.includes("watch")) return Watch;
  if (normalized.includes("desktop") || normalized.includes("monitor") || normalized.includes("laptop")) return Monitor;
  return CircleHelp;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

function rendererKind(recipe: UIResolvedChartSpec["recipe"]): "dom" | "recharts" | "svg" {
  switch (recipe) {
    case "revenue-per-account-scatter":
    case "visitors-radar":
    case "revenue-smooth-area":
    case "earned-so-far-bars":
    case "sessions-conversion-combo":
    case "visitors-stacked-area": return "recharts";
    case "sleep-score": return "recharts";
    case "steps-bars":
    case "pipeline-stage-bars":
    case "activity-calendar":
    case "active-users-heatmap":
    case "contributions-heatmap":
    case "devices-bars": return "dom";
    case "tracked-time-sankey":
    case "visitors-radial":
    case "sign-up-funnel":
    case "activity-rings": return "svg";
  }
}
