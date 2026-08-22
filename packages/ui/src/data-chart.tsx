"use client";

import type { ChartSpec, QueryArtifact } from "./types";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "./chart";
import { useArtifactUI } from "./bridge";
import { ArtifactEmpty } from "./primitives";
import { formatDataValue } from "./utils";

const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function DataChart({
  rows,
  chart,
  locale = "en-US",
  height = 320,
}: {
  rows: QueryArtifact["rows"];
  chart?: ChartSpec;
  locale?: string;
  height?: number;
}) {
  const { themeVariables } = useArtifactUI();
  if (!chart || rows.length === 0)
    return (
      <ArtifactEmpty
        title="No chart available"
        description="This result is better inspected as a table."
      />
    );

  const config = Object.fromEntries(
    chart.yKeys.map((key, index) => [
      key,
      { label: key, color: SERIES_COLORS[index % SERIES_COLORS.length] },
    ]),
  ) satisfies ChartConfig;
  const common = {
    data: rows,
    margin: { top: 16, right: 12, left: -4, bottom: 2 },
  };
  const axes = (
    <>
      <CartesianGrid
        stroke="var(--border)"
        strokeDasharray="2 6"
        strokeOpacity={0.55}
        vertical={false}
      />
      <XAxis
        axisLine={false}
        dataKey={chart.xKey}
        minTickGap={24}
        tick={{ fill: "var(--muted-foreground)" }}
        tickFormatter={(value) => formatDataValue(value, locale)}
        tickLine={false}
      />
      <YAxis
        axisLine={false}
        tick={{ fill: "var(--muted-foreground)" }}
        tickFormatter={(value) =>
          new Intl.NumberFormat(locale, { notation: "compact" }).format(
            Number(value),
          )
        }
        tickLine={false}
        width={50}
      />
      <ChartTooltip
        content={
          <ChartTooltipContent
            labelFormatter={(value) => formatDataValue(value, locale)}
          />
        }
      />
    </>
  );

  return (
    <ChartContainer
      aria-label={`${chart.kind} chart`}
      className="de-data-chart de-theme-root min-w-0 w-full"
      config={config}
      role="img"
      style={{ ...themeVariables, height }}
    >
      {chart.kind === "bar" ? (
        <BarChart {...common}>
          {axes}
          {chart.yKeys.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              fill={SERIES_COLORS[index % SERIES_COLORS.length]}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </BarChart>
      ) : chart.kind === "area" ? (
        <AreaChart {...common}>
          {axes}
          {chart.yKeys.map((key, index) => (
            <Area
              activeDot={{ fill: "var(--background)", r: 4, strokeWidth: 2 }}
              key={key}
              dataKey={key}
              fill={SERIES_COLORS[index % SERIES_COLORS.length]}
              fillOpacity={0.12}
              stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
              strokeWidth={2}
              type="monotone"
            />
          ))}
        </AreaChart>
      ) : (
        <LineChart {...common}>
          {axes}
          {chart.yKeys.map((key, index) => (
            <Line
              key={key}
              activeDot={{ fill: "var(--background)", r: 4, strokeWidth: 2 }}
              dataKey={key}
              dot={false}
              stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
              strokeWidth={2}
              type="monotone"
            />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  );
}
