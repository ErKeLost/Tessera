"use client";

import type {
  ChartCellValue,
  ChartMetric,
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
} from "recharts";
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ChartContainer, type ChartConfig } from "../components/ui/chart";
import { Progress } from "../components/ui/progress";
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

const COLORS = ["#9CDF15", "#4E85FA", "#B373FF", "#E864AB", "#F1C300"] as const;
const PIPELINE_ICONS = [Eye, UserRoundPlus, Zap, Crown, UsersRound, Building2] as const;
const GRID = "#E2E2E2";
const MUTED = "#A3A3A3";

export function DataChartRenderer(input: ChartInput) {
  const { spec } = input.resolvedProps;
  return (
    <section
      aria-label={spec.accessibility.label}
      className={`og-ui og-chart-surface og-recipe-${spec.recipe}`}
      data-chart-recipe={spec.recipe}
      data-og-component="data.chart"
      data-og-renderer="recipe"
    >
      <ResolvedChart input={input} spec={spec} />
    </section>
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
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}>{spec.summary ? <SummaryStat metric={spec.summary} spec={spec} value={metricValue(rows, spec.summary)} /> : null}</RecipeHeader>}>
      <div className="og-chart-plot og-chart-plot-scatter" data-chart-mark="scatter">
        <ClientChartProjection server={<ScatterProjection rows={rows} spec={spec} />}>
          <ScatterChart height={264} margin={{ top: 12, right: 16, bottom: 14, left: 8 }} width={640}>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" />
            <XAxis axisLine={false} dataKey={spec.comparisonColumn} name={columnLabel(spec, spec.comparisonColumn)} tick={axisTick} tickFormatter={(value) => formatValue(value, spec.comparisonFormat)} tickLine={false} type="number" />
            <YAxis axisLine={false} dataKey={spec.revenueColumn} name={columnLabel(spec, spec.revenueColumn)} tick={axisTick} tickFormatter={(value) => formatValue(value, spec.revenueFormat)} tickLine={false} type="number" width={56} />
            {spec.sizeColumn ? <ZAxis dataKey={spec.sizeColumn} range={[64, 220]} /> : null}
            <Tooltip content={<ChartTooltipContent format={spec.revenueFormat} labelColumn={spec.accountColumn} />} cursor={{ stroke: MUTED, strokeDasharray: "3 3" }} />
            <Scatter data={rows} fill={COLORS[1]} isAnimationActive={false} name={spec.title}>
              {rows.map((_, index) => <Cell fill={COLORS[index % COLORS.length]} key={index} />)}
            </Scatter>
          </ScatterChart>
        </ClientChartProjection>
      </div>
    </RecipeLayout>
  );
}

function TrackedTimeSankey({ rows, spec }: RecipeProps<"tracked-time-sankey">) {
  const layout = sankeyLayout(rows, spec.sourceColumn, spec.targetColumn, spec.valueColumn);
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}>{spec.summary ? <SummaryStat metric={spec.summary} spec={spec} value={metricValue(rows, spec.summary)} /> : null}</RecipeHeader>}>
      <svg aria-label={spec.accessibility.label} className="og-schema-chart og-sankey-chart" role="img" viewBox="0 0 620 286">
        {layout.edges.map((edge, index) => (
          <path className={`og-flow-fill-${edge.colorIndex % COLORS.length}`} d={edge.path} key={`${edge.source}-${edge.target}-${index}`} opacity="0.48"><title>{`${edge.source} to ${edge.target}`}</title></path>
        ))}
        {layout.left.map((node, index) => (
          <g key={`source-${node.name}`}>
            <text className="og-svg-label" dominantBaseline="middle" textAnchor="end" x="104" y={node.y + node.height / 2}>{node.name}</text>
            <rect className={`og-accent-fill-${index % COLORS.length}`} height={node.height} rx="3" width="12" x="116" y={node.y} />
          </g>
        ))}
        {layout.right.map((node, index) => (
          <g key={`target-${node.name}`}>
            <rect className={`og-accent-fill-${(index + 1) % COLORS.length}`} height={node.height} rx="3" width="12" x="492" y={node.y} />
            <text className="og-svg-label" dominantBaseline="middle" x="516" y={node.y + node.height / 2}>{node.name}</text>
          </g>
        ))}
      </svg>
    </RecipeLayout>
  );
}

function VisitorsRadial({ rows, spec }: RecipeProps<"visitors-radial">) {
  const visible = rows.slice(0, 5);
  const max = Math.max(...visible.map((row) => numeric(row, spec.valueColumn)), 1);
  return (
    <RecipeLayout header={<RecipeHeader spec={spec} />}>
      <div className="og-radial-layout">
        <svg aria-label={spec.accessibility.label} className="og-radial-chart" role="img" viewBox="0 0 260 260">
          {visible.map((row, index) => {
            const radius = 108 - index * 16;
            const circumference = 2 * Math.PI * radius;
            const ratio = clamp(numeric(row, spec.valueColumn) / max, 0, 1);
            return (
              <g key={`${text(row, spec.categoryColumn)}-${index}`}>
                <circle cx="130" cy="130" fill="none" r={radius} stroke="#E5E5E5" strokeWidth="10" />
                <circle cx="130" cy="130" fill="none" r={radius} stroke={COLORS[index % COLORS.length]} strokeDasharray={`${ratio * circumference} ${circumference}`} strokeLinecap="round" strokeWidth="10" transform="rotate(-90 130 130)"><title>{`${text(row, spec.categoryColumn)}: ${formatValue(row[spec.valueColumn], spec.valueFormat)}`}</title></circle>
              </g>
            );
          })}
          <text className="og-svg-score og-svg-score-sm" dominantBaseline="middle" textAnchor="middle" x="130" y="122">{formatValue(metricValue(rows, spec.summary), spec.summary.format)}</text>
          <text className="og-svg-caption" dominantBaseline="middle" textAnchor="middle" x="130" y="149">{spec.summary.label ?? "Visitors"}</text>
        </svg>
        <div className="og-chart-legend-list">
          {visible.map((row, index) => (
            <div className="og-legend-row" key={`${text(row, spec.categoryColumn)}-${index}`}>
              <span className={`og-legend-swatch og-accent-bg-${index % COLORS.length}`} />
              <span>{text(row, spec.categoryColumn)}</span>
              <strong>{formatValue(row[spec.valueColumn], spec.valueFormat)}</strong>
            </div>
          ))}
        </div>
      </div>
    </RecipeLayout>
  );
}

function VisitorsRadar({ rows, spec }: RecipeProps<"visitors-radar">) {
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}>{spec.summary ? <SummaryStat metric={spec.summary} spec={spec} value={metricValue(rows, spec.summary)} /> : null}</RecipeHeader>}>
      <div className="og-chart-plot og-chart-plot-radar" data-chart-mark="radar">
        <ClientChartProjection server={<RadarProjection rows={rows} spec={spec} />}>
          <RadarChart data={rows} height={286} margin={{ top: 24, right: 52, bottom: 24, left: 52 }} width={640}>
            <PolarGrid gridType="polygon" radialLines={false} stroke={GRID} />
            <PolarAngleAxis dataKey={spec.dimensionColumn} tick={{ fill: "#777777", fontSize: 11 }} />
            <Tooltip content={<ChartTooltipContent format={spec.valueFormat} />} />
            <Radar dataKey={spec.valueColumn} fill={COLORS[0]} fillOpacity={0.24} isAnimationActive={false} name={columnLabel(spec, spec.valueColumn)} stroke={COLORS[0]} strokeWidth={2.5} />
            {spec.comparisonColumn ? <Radar dataKey={spec.comparisonColumn} fill={COLORS[1]} fillOpacity={0.09} isAnimationActive={false} name={columnLabel(spec, spec.comparisonColumn)} stroke={COLORS[1]} strokeWidth={2} /> : null}
          </RadarChart>
        </ClientChartProjection>
      </div>
    </RecipeLayout>
  );
}

function ActivityCalendar({ rows, spec }: RecipeProps<"activity-calendar">) {
  const cells = monthCalendarCells(rows, spec.dateColumn, spec.valueColumn);
  const max = Math.max(...cells.map((cell) => cell.value), 1);
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}>{spec.summary ? <SummaryStat metric={spec.summary} spec={spec} value={metricValue(rows, spec.summary)} /> : null}</RecipeHeader>}>
      <svg aria-label={spec.accessibility.label} className="og-schema-chart og-month-calendar" role="img" viewBox="0 0 560 318">
        {WEEKDAYS.map((day, index) => <text className="og-calendar-weekday" key={day} textAnchor="middle" x={52 + index * 76} y="18">{day}</text>)}
        {cells.map((cell) => {
          const x = 20 + cell.day * 76;
          const y = 34 + cell.week * 46;
          return (
            <g key={cell.key}>
              <rect className={`og-calendar-cell og-intensity-${intensity(cell.value, max)}`} height="38" rx="6" width="68" x={x} y={y}><title>{`${cell.key}: ${formatValue(cell.value, spec.valueFormat)}`}</title></rect>
              <text className="og-calendar-day" x={x + 9} y={y + 15}>{cell.date.getUTCDate()}</text>
              {cell.value > 0 ? <text className="og-calendar-value" textAnchor="end" x={x + 59} y={y + 29}>{formatValue(cell.value, spec.valueFormat)}</text> : null}
            </g>
          );
        })}
      </svg>
    </RecipeLayout>
  );
}

function RevenueSmoothArea({ instanceId, rows, spec }: RecipeProps<"revenue-smooth-area"> & { instanceId: string }) {
  const gradientId = `og-revenue-${instanceId}`;
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}><SummaryStat metric={spec.summary} spec={spec} value={metricValue(rows, spec.summary)} /></RecipeHeader>}>
      <div className="og-chart-plot og-chart-plot-area" data-chart-mark="area">
        <ClientChartProjection server={<AreaProjection format={spec.revenueFormat} rows={rows} timeColumn={spec.timeColumn} valueColumn={spec.revenueColumn} />}>
          <AreaChart data={rows} height={252} margin={{ top: 18, right: 8, bottom: 2, left: 8 }} width={640}>
            <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={COLORS[0]} stopOpacity="0.48" /><stop offset="100%" stopColor={COLORS[0]} stopOpacity="0.02" /></linearGradient></defs>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
            <XAxis axisLine={false} dataKey={spec.timeColumn} tick={axisTick} tickFormatter={timeTick} tickLine={false} />
            <YAxis hide />
            <Tooltip content={<ChartTooltipContent format={spec.revenueFormat} />} cursor={{ stroke: MUTED, strokeDasharray: "3 3" }} />
            <Area dataKey={spec.revenueColumn} fill={`url(#${gradientId})`} isAnimationActive={false} name={columnLabel(spec, spec.revenueColumn)} stroke={COLORS[0]} strokeWidth={3} type="monotone" />
          </AreaChart>
        </ClientChartProjection>
      </div>
    </RecipeLayout>
  );
}

function ActiveUsersHeatmap({ rows, spec }: RecipeProps<"active-users-heatmap">) {
  const days = unique(rows.map((row) => text(row, spec.dayColumn))).slice(0, 8);
  const buckets = unique(rows.map((row) => text(row, spec.timeBucketColumn))).slice(0, 14);
  const values = new Map(rows.map((row) => [`${text(row, spec.dayColumn)}\u0000${text(row, spec.timeBucketColumn)}`, numeric(row, spec.valueColumn)]));
  const max = Math.max(...values.values(), 1);
  const cellWidth = buckets.length > 0 ? Math.min(34, 440 / buckets.length) : 34;
  const viewWidth = 104 + buckets.length * cellWidth;
  const viewHeight = 54 + days.length * 30;
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}>{spec.summary ? <SummaryStat metric={spec.summary} spec={spec} value={metricValue(rows, spec.summary)} /> : null}</RecipeHeader>}>
      <svg aria-label={spec.accessibility.label} className="og-schema-chart og-active-heatmap" role="img" viewBox={`0 0 ${Math.max(520, viewWidth)} ${Math.max(240, viewHeight)}`}>
        {buckets.map((bucket, index) => <text className="og-heatmap-axis" key={bucket} textAnchor="middle" x={96 + index * cellWidth + (cellWidth - 5) / 2} y="24">{bucket}</text>)}
        {days.map((day, dayIndex) => (
          <g key={day}>
            <text className="og-svg-label" dominantBaseline="middle" textAnchor="end" x="80" y={48 + dayIndex * 30 + 10}>{day}</text>
            {buckets.map((bucket, bucketIndex) => {
              const value = values.get(`${day}\u0000${bucket}`) ?? 0;
              return <rect className={`og-heatmap-cell og-intensity-${intensity(value, max)}`} height="20" key={bucket} rx="4" width={Math.max(5, cellWidth - 5)} x={96 + bucketIndex * cellWidth} y={48 + dayIndex * 30}><title>{`${day} ${bucket}: ${formatValue(value, spec.valueFormat)}`}</title></rect>;
            })}
          </g>
        ))}
      </svg>
    </RecipeLayout>
  );
}

function SignUpFunnel({ rows, spec }: RecipeProps<"sign-up-funnel">) {
  const visible = rows.slice(0, 6);
  const max = Math.max(...visible.map((row) => numeric(row, spec.valueColumn)), 1);
  const segmentWidth = 480 / Math.max(visible.length, 1);
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}>{spec.summary ? <SummaryStat metric={spec.summary} spec={spec} value={metricValue(rows, spec.summary)} /> : null}{spec.conversion ? <SummaryStat metric={spec.conversion} spec={spec} value={metricValue(rows, spec.conversion)} /> : null}</RecipeHeader>}>
      <svg aria-label={spec.accessibility.label} className="og-schema-chart og-funnel-chart" role="img" viewBox="0 0 560 252">
        {visible.map((row, index) => {
          const current = numeric(row, spec.valueColumn);
          const next = index === visible.length - 1 ? current : numeric(visible[index + 1]!, spec.valueColumn);
          const h0 = 36 + 104 * current / max;
          const h1 = 36 + 104 * next / max;
          const x0 = 36 + index * segmentWidth;
          const x1 = x0 + segmentWidth - 3;
          const y0 = 112 - h0 / 2;
          const y1 = 112 - h1 / 2;
          const points = `${x0},${y0} ${x1},${y1} ${x1},${y1 + h1} ${x0},${y0 + h0}`;
          return (
            <g key={`${text(row, spec.stageColumn)}-${index}`}>
              <polygon className={`og-accent-fill-${index % COLORS.length}`} points={points}><title>{`${text(row, spec.stageColumn)}: ${formatValue(current, spec.valueFormat)}`}</title></polygon>
              <text className="og-funnel-value" dominantBaseline="middle" textAnchor="middle" x={(x0 + x1) / 2} y="112">{formatValue(current, spec.valueFormat)}</text>
              <text className="og-funnel-label" textAnchor="middle" x={(x0 + x1) / 2} y="210">{text(row, spec.stageColumn)}</text>
              {index > 0 ? <text className="og-funnel-rate" textAnchor="middle" x={(x0 + x1) / 2} y="232">{formatPercent(current / Math.max(numeric(visible[0]!, spec.valueColumn), 1))}</text> : null}
            </g>
          );
        })}
      </svg>
    </RecipeLayout>
  );
}

function EarnedSoFarBars({ rows, spec }: RecipeProps<"earned-so-far-bars">) {
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}><SummaryStat metric={spec.summary} spec={spec} value={metricValue(rows, spec.summary)} /></RecipeHeader>}>
      <div className="og-chart-plot og-chart-plot-earned" data-chart-mark="bars">
        <ClientChartProjection server={<BarsProjection categoryColumn={spec.periodColumn} format={spec.earnedFormat} rows={rows} targetColumn={spec.targetColumn} valueColumn={spec.earnedColumn} />}>
          <BarChart barCategoryGap="28%" data={rows} height={250} margin={{ top: 14, right: 8, bottom: 0, left: 8 }} width={640}>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
            <XAxis axisLine={false} dataKey={spec.periodColumn} tick={axisTick} tickLine={false} />
            <YAxis hide />
            <Tooltip content={<ChartTooltipContent format={spec.earnedFormat} />} cursor={{ fill: "rgba(255,255,255,.5)" }} />
            {spec.targetColumn ? <Bar dataKey={spec.targetColumn} fill="#DCDCDC" isAnimationActive={false} name={columnLabel(spec, spec.targetColumn)} radius={[4, 4, 1, 1]} /> : null}
            <Bar dataKey={spec.earnedColumn} fill={COLORS[0]} isAnimationActive={false} name={columnLabel(spec, spec.earnedColumn)} radius={[4, 4, 1, 1]} />
          </BarChart>
        </ClientChartProjection>
      </div>
    </RecipeLayout>
  );
}

function ContributionsHeatmap({ rows, spec }: RecipeProps<"contributions-heatmap">) {
  const cells = contributionCells(rows, spec.dateColumn, spec.valueColumn);
  const max = Math.max(...cells.map((cell) => cell.value), 1);
  const width = Math.max(620, 68 + (cells.at(-1)?.week ?? 0) * 12 + 20);
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}><SummaryStat metric={spec.summary} spec={spec} value={metricValue(rows, spec.summary)} /></RecipeHeader>}>
      <div className="og-contribution-scroll">
        <svg aria-label={spec.accessibility.label} className="og-schema-chart og-contribution-chart" role="img" viewBox={`0 0 ${width} 142`}>
          <text className="og-heatmap-axis" x="4" y="45">Mon</text><text className="og-heatmap-axis" x="4" y="81">Wed</text><text className="og-heatmap-axis" x="4" y="117">Fri</text>
          {cells.map((cell) => <rect className={`og-contribution-cell og-intensity-${intensity(cell.value, max)}`} height="10" key={cell.key} rx="2" width="10" x={48 + cell.week * 12} y={18 + cell.day * 16}><title>{`${cell.key}: ${formatValue(cell.value, spec.valueFormat)}`}</title></rect>)}
        </svg>
      </div>
      <div className="og-heatmap-scale"><span>Less</span>{[0, 1, 2, 3, 4].map((level) => <i className={`og-intensity-${level}`} key={level} />)}<span>More</span></div>
    </RecipeLayout>
  );
}

function SessionsConversionCombo({ rows, spec }: RecipeProps<"sessions-conversion-combo">) {
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}><SummaryStat metric={spec.sessionsSummary} spec={spec} value={metricValue(rows, spec.sessionsSummary)} /><SummaryStat metric={spec.conversionSummary} spec={spec} value={metricValue(rows, spec.conversionSummary)} /></RecipeHeader>}>
      <div className="og-chart-plot og-chart-plot-combo" data-chart-mark="bar line">
        <ClientChartProjection server={<ComboProjection rows={rows} spec={spec} />}>
          <ComposedChart data={rows} height={264} margin={{ top: 16, right: 10, bottom: 0, left: 10 }} width={640}>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
            <XAxis axisLine={false} dataKey={spec.timeColumn} tick={axisTick} tickFormatter={timeTick} tickLine={false} />
            <YAxis hide yAxisId="sessions" />
            <YAxis hide orientation="right" yAxisId="conversion" />
            <Tooltip content={<ChartTooltipContent />} cursor={{ fill: "rgba(255,255,255,.55)" }} />
            <Bar dataKey={spec.sessionsColumn} fill={COLORS[1]} isAnimationActive={false} name={columnLabel(spec, spec.sessionsColumn)} radius={[4, 4, 1, 1]} yAxisId="sessions" />
            <Line activeDot={{ r: 4, fill: COLORS[3] }} dataKey={spec.conversionColumn} dot={false} isAnimationActive={false} name={columnLabel(spec, spec.conversionColumn)} stroke={COLORS[3]} strokeWidth={3} type="monotone" yAxisId="conversion" />
          </ComposedChart>
        </ClientChartProjection>
      </div>
      <div className="og-inline-legend"><span><i className="og-accent-bg-1" />{columnLabel(spec, spec.sessionsColumn)}</span><span><i className="og-accent-bg-3" />{columnLabel(spec, spec.conversionColumn)}</span></div>
    </RecipeLayout>
  );
}

function DevicesBars({ rows, spec }: RecipeProps<"devices-bars">) {
  const visible = rows.slice(0, 6);
  const max = Math.max(...visible.map((row) => numeric(row, spec.valueColumn)), 1);
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}>{spec.summary ? <SummaryStat metric={spec.summary} spec={spec} value={metricValue(rows, spec.summary)} /> : null}</RecipeHeader>}>
      <div className="og-device-list" role="img" aria-label={spec.accessibility.label}>
        {visible.map((row, index) => {
          const label = text(row, spec.deviceColumn);
          const value = numeric(row, spec.valueColumn);
          const Icon = deviceIcon(label);
          return (
            <div className="og-device-row" key={`${label}-${index}`}>
              <span className="og-device-label"><Icon aria-hidden="true" size={17} strokeWidth={1.8} /><span>{label}</span></span>
              <svg aria-hidden="true" className="og-device-bar" preserveAspectRatio="none" viewBox="0 0 100 9"><title>{`${label}: ${formatValue(value, spec.valueFormat)}`}</title><rect fill="#E4E4E4" height="9" rx="4" width="100" /><rect className={`og-accent-fill-${index % COLORS.length}`} height="9" rx="4" width={Math.max(1, 100 * value / max)} /></svg>
              <strong>{formatValue(value, spec.valueFormat)}</strong>
            </div>
          );
        })}
      </div>
    </RecipeLayout>
  );
}

function VisitorsStackedArea({ instanceId, rows, spec }: RecipeProps<"visitors-stacked-area"> & { instanceId: string }) {
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}>{spec.summary ? <SummaryStat metric={spec.summary} spec={spec} value={metricValue(rows, spec.summary)} /> : null}</RecipeHeader>}>
      <div className="og-chart-plot og-chart-plot-stacked" data-chart-mark="stacked-area">
        <ClientChartProjection server={<StackedAreaProjection rows={rows} spec={spec} />}>
          <AreaChart data={rows} height={260} margin={{ top: 16, right: 8, bottom: 0, left: 8 }} width={640}>
            <defs>{spec.series.map((series, index) => <linearGradient id={`og-stack-${instanceId}-${index}`} key={series.column} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={COLORS[index % COLORS.length]} stopOpacity="0.78" /><stop offset="100%" stopColor={COLORS[index % COLORS.length]} stopOpacity="0.2" /></linearGradient>)}</defs>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
            <XAxis axisLine={false} dataKey={spec.timeColumn} tick={axisTick} tickFormatter={timeTick} tickLine={false} />
            <YAxis hide />
            <Tooltip content={<ChartTooltipContent />} cursor={{ stroke: MUTED, strokeDasharray: "3 3" }} />
            {spec.series.map((series, index) => <Area dataKey={series.column} fill={`url(#og-stack-${instanceId}-${index})`} isAnimationActive={false} key={series.column} name={series.label ?? columnLabel(spec, series.column)} stackId="visitors" stroke={COLORS[index % COLORS.length]} strokeWidth={2} type="monotone" />)}
          </AreaChart>
        </ClientChartProjection>
      </div>
      <div className="og-inline-legend">{spec.series.map((series, index) => <span key={series.column}><i className={`og-accent-bg-${index % COLORS.length}`} />{series.label ?? columnLabel(spec, series.column)}</span>)}</div>
    </RecipeLayout>
  );
}

function ActivityRings({ rows, spec }: RecipeProps<"activity-rings">) {
  const visible = rows.slice(0, 5);
  return (
    <RecipeLayout header={<RecipeHeader spec={spec}>{spec.summary ? <SummaryStat metric={spec.summary} spec={spec} value={metricValue(rows, spec.summary)} /> : null}</RecipeHeader>}>
      <div className="og-rings-layout">
        <svg aria-label={spec.accessibility.label} className="og-activity-rings" role="img" viewBox="0 0 260 260">
          {visible.map((row, index) => {
            const radius = 108 - index * 18;
            const circumference = 2 * Math.PI * radius;
            const ratio = clamp(numeric(row, spec.valueColumn) / Math.max(numeric(row, spec.targetColumn), 1), 0, 1);
            return (
              <g key={`${text(row, spec.activityColumn)}-${index}`}>
                <circle cx="130" cy="130" fill="none" r={radius} stroke="#E3E3E3" strokeWidth="13" />
                <circle cx="130" cy="130" fill="none" r={radius} stroke={COLORS[index % COLORS.length]} strokeDasharray={`${circumference * ratio} ${circumference}`} strokeLinecap="round" strokeWidth="13" transform="rotate(-90 130 130)"><title>{`${text(row, spec.activityColumn)}: ${formatValue(row[spec.valueColumn], spec.valueFormat)} / ${formatValue(row[spec.targetColumn], spec.valueFormat)}`}</title></circle>
              </g>
            );
          })}
        </svg>
        <div className="og-ring-stats">
          {visible.map((row, index) => {
            const value = row[spec.valueColumn];
            const target = row[spec.targetColumn];
            return <div className="og-ring-stat" key={`${text(row, spec.activityColumn)}-${index}`}><span className={`og-ring-dot og-accent-bg-${index % COLORS.length}`} /><div><span>{text(row, spec.activityColumn)}</span><strong>{formatValue(value, spec.valueFormat)} <small>/ {formatValue(target, spec.valueFormat)}</small></strong></div></div>;
          })}
        </div>
      </div>
    </RecipeLayout>
  );
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
            {target !== undefined ? <rect fill="#DEDEDE" height={targetHeight} rx="4" width={barWidth} x={x} y={plot.bottom - targetHeight}><title>{`Target: ${formatValue(target, format)}`}</title></rect> : null}
            <rect fill={COLORS[0]} height={valueHeight} rx="4" width={target === undefined ? barWidth : barWidth * 0.64} x={target === undefined ? x : x + barWidth * 0.18} y={plot.bottom - valueHeight}><title>{`${text(row, categoryColumn)}: ${formatValue(value, format)}`}</title></rect>
            <text className="og-heatmap-axis" textAnchor="middle" x={x + barWidth / 2} y="226">{text(row, categoryColumn)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function ScatterProjection({ rows, spec }: RecipeProps<"revenue-per-account-scatter">) {
  const visible = rows.slice(0, 40);
  const xs = visible.map((row) => numeric(row, spec.comparisonColumn));
  const ys = visible.map((row) => numeric(row, spec.revenueColumn));
  const sizes = spec.sizeColumn ? visible.map((row) => numeric(row, spec.sizeColumn!)) : visible.map(() => 1);
  const xRange = numericRange(xs);
  const yRange = numericRange(ys);
  const sizeRange = numericRange(sizes);
  return (
    <svg aria-hidden="true" className="og-server-chart" viewBox="0 0 640 264">
      {[0, 1, 2, 3].map((index) => <line key={index} stroke={GRID} strokeDasharray="2 4" x1="54" x2="622" y1={24 + index * 62} y2={24 + index * 62} />)}
      {visible.map((row, index) => {
        const xValue = numeric(row, spec.comparisonColumn);
        const yValue = numeric(row, spec.revenueColumn);
        const sizeValue = sizes[index]!;
        const x = scale(xValue, xRange, [64, 612]);
        const y = scale(yValue, yRange, [218, 26]);
        const radius = scale(sizeValue, sizeRange, [5, 11]);
        return <circle cx={x} cy={y} fill={COLORS[index % COLORS.length]} key={index} opacity="0.84" r={radius}><title>{`${text(row, spec.accountColumn)}: ${formatValue(yValue, spec.revenueFormat)}`}</title></circle>;
      })}
      <text className="og-heatmap-axis" textAnchor="middle" x="320" y="256">{columnLabel(spec, spec.comparisonColumn)}</text>
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
      {spec.comparisonColumn ? <polygon fill={COLORS[1]} fillOpacity="0.09" points={polygon(spec.comparisonColumn)} stroke={COLORS[1]} strokeWidth="2"><title>{columnLabel(spec, spec.comparisonColumn)}</title></polygon> : null}
      <polygon fill={COLORS[0]} fillOpacity="0.24" points={polygon(spec.valueColumn)} stroke={COLORS[0]} strokeWidth="2.5"><title>{columnLabel(spec, spec.valueColumn)}</title></polygon>
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
      <path d={area} fill={COLORS[0]} fillOpacity="0.26"><title>{rows.map((row) => `${text(row, timeColumn)}: ${formatValue(row[valueColumn], format)}`).join(", ")}</title></path>
      <path d={line} fill="none" stroke={COLORS[0]} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
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
        return <rect fill={COLORS[1]} height={height} key={index} rx="4" width={width} x={x} y={212 - height}><title>{`${text(row, spec.timeColumn)}: ${formatValue(row[spec.sessionsColumn], spec.sessionsFormat)}`}</title></rect>;
      })}
      <path d={pathFromPoints(conversionPoints)} fill="none" stroke={COLORS[3]} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3"><title>{columnLabel(spec, spec.conversionColumn)}</title></path>
      {conversionPoints.map((point, index) => <circle cx={point.x} cy={point.y} fill={COLORS[3]} key={index} r="3.5" />)}
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
        return <path d={path} fill={COLORS[seriesIndex % COLORS.length]} fillOpacity={0.56 + seriesIndex * 0.05} key={series.column} stroke={COLORS[seriesIndex % COLORS.length]} strokeWidth="1.5"><title>{series.label ?? series.column}</title></path>;
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
      {payload.map((entry, index) => <div key={`${String(entry.name)}-${index}`}><i className={`og-accent-bg-${index % COLORS.length}`} /><span>{entry.name}</span><b>{formatValue(entry.value, format)}</b></div>)}
    </div>
  );
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

const axisTick = { fill: "#8A8A8A", fontSize: 11 } as const;

type FlowNode = { height: number; name: string; value: number; y: number };
type FlowEdge = { colorIndex: number; path: string; source: string; target: string };

function sankeyLayout(rows: DataRow[], sourceColumn: string, targetColumn: string, valueColumn: string): { edges: FlowEdge[]; left: FlowNode[]; right: FlowNode[] } {
  const edges = rows.map((row) => ({ source: text(row, sourceColumn), target: text(row, targetColumn), value: Math.max(0, numeric(row, valueColumn)) })).filter((edge) => edge.value > 0);
  const total = Math.max(edges.reduce((sum, edge) => sum + edge.value, 0), 1);
  const sourceTotals = totalsBy(edges, "source");
  const targetTotals = totalsBy(edges, "target");
  const left = flowNodes(sourceTotals, total);
  const right = flowNodes(targetTotals, total);
  const leftByName = new Map(left.map((node) => [node.name, node]));
  const rightByName = new Map(right.map((node) => [node.name, node]));
  const sourceOffsets = new Map<string, number>();
  const targetOffsets = new Map<string, number>();
  const flowEdges = edges.map((edge, index) => {
    const source = leftByName.get(edge.source)!;
    const target = rightByName.get(edge.target)!;
    const thickness = edge.value / total * 202;
    const sourceOffset = sourceOffsets.get(edge.source) ?? 0;
    const targetOffset = targetOffsets.get(edge.target) ?? 0;
    const y0 = source.y + sourceOffset;
    const y1 = target.y + targetOffset;
    sourceOffsets.set(edge.source, sourceOffset + thickness);
    targetOffsets.set(edge.target, targetOffset + thickness);
    const path = `M128 ${y0} C250 ${y0},370 ${y1},492 ${y1} L492 ${y1 + thickness} C370 ${y1 + thickness},250 ${y0 + thickness},128 ${y0 + thickness} Z`;
    return { colorIndex: index, path, source: edge.source, target: edge.target };
  });
  return { edges: flowEdges, left, right };
}

function totalsBy(edges: readonly { source: string; target: string; value: number }[], side: "source" | "target"): Map<string, number> {
  const result = new Map<string, number>();
  for (const edge of edges) result.set(edge[side], (result.get(edge[side]) ?? 0) + edge.value);
  return result;
}

function flowNodes(totals: Map<string, number>, grandTotal: number): FlowNode[] {
  let y = 28;
  return [...totals].map(([name, value]) => {
    const height = value / grandTotal * 202;
    const node = { height, name, value, y };
    y += height + 8;
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
    case "pipeline-stage-bars": return "dom";
    case "tracked-time-sankey":
    case "visitors-radial":
    case "activity-calendar":
    case "active-users-heatmap":
    case "sign-up-funnel":
    case "contributions-heatmap":
    case "devices-bars":
    case "activity-rings": return "svg";
  }
}
