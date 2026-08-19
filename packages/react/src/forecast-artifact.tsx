"use client";

import type { ForecastArtifact as ForecastArtifactData } from "@data-elements/schema";
import { ChartSplineIcon } from "lucide-react";
import {
  Area,
  ComposedChart,
  CartesianGrid,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Artifact,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactStatus,
  ArtifactTitle,
} from "./primitives";
import { formatNumber } from "./utils";

export function ForecastArtifact({
  artifact,
  locale = "en-US",
}: {
  artifact: ForecastArtifactData;
  locale?: string;
}) {
  const numberOptions = {
    format: artifact.format,
    currency: artifact.currency,
    locale,
  } as const;
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(
      new Date(value),
    );
  const lastActual = artifact.points.findLast((point) => point.actual != null);
  const finalForecast = artifact.points.at(-1)?.forecast;
  return (
    <Artifact>
      <ArtifactHeader>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ArtifactTitle>{artifact.title}</ArtifactTitle>
            <ArtifactStatus icon={ChartSplineIcon}>Forecast</ArtifactStatus>
          </div>
          <ArtifactDescription>{artifact.description}</ArtifactDescription>
        </div>
      </ArtifactHeader>
      <ArtifactContent className="p-4 sm:p-4">
        <div className="de-stat-grid gap-px sm:grid-cols-3">
          <div className="de-stat-cell">
            <p className="de-metadata">Latest actual</p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
              {lastActual?.actual == null
                ? "-"
                : formatNumber(lastActual.actual, numberOptions)}
            </p>
          </div>
          <div className="de-stat-cell">
            <p className="de-metadata">End forecast</p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
              {finalForecast == null
                ? "-"
                : formatNumber(finalForecast, numberOptions)}
            </p>
          </div>
          <div className="de-stat-cell">
            <p className="de-metadata">Confidence</p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
              {artifact.confidenceLevel}%
            </p>
          </div>
        </div>
        <div
          className="mt-5 h-72 min-w-0"
          role="img"
          aria-label={`${artifact.metricLabel} forecast chart`}
        >
          <ResponsiveContainer
            height="100%"
            initialDimension={{ height: 288, width: 640 }}
            width="100%"
          >
            <ComposedChart
              data={artifact.points}
              margin={{ bottom: 0, left: 0, right: 12, top: 10 }}
            >
              <CartesianGrid
                stroke="var(--border)"
                strokeDasharray="3 4"
                strokeOpacity={0.55}
                vertical={false}
              />
              <XAxis
                axisLine={false}
                dataKey="timestamp"
                minTickGap={34}
                tick={{ fill: "var(--muted-foreground)" }}
                tickFormatter={date}
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
              <Tooltip
                formatter={(value, name) => [
                  formatNumber(Number(value), numberOptions),
                  String(name),
                ]}
                labelFormatter={(value) => date(String(value))}
              />
              <Area
                dataKey="upper"
                fill="var(--chart-1)"
                fillOpacity={0.08}
                name="Upper bound"
                stroke="none"
                type="monotone"
              />
              <Area
                dataKey="lower"
                fill="var(--background)"
                fillOpacity={1}
                name="Lower bound"
                stroke="none"
                type="monotone"
              />
              <Line
                dataKey="actual"
                dot={false}
                name="Actual"
                stroke="var(--foreground)"
                strokeWidth={2}
                type="monotone"
              />
              <Line
                dataKey="forecast"
                dot={false}
                name="Forecast"
                stroke="var(--chart-1)"
                strokeDasharray="5 4"
                strokeWidth={2}
                type="monotone"
              />
              {artifact.target != null && (
                <ReferenceLine
                  stroke="var(--muted-foreground)"
                  strokeDasharray="4 4"
                  y={artifact.target}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 grid gap-3 border-t de-divider pt-4 sm:grid-cols-2">
          <div>
            <p className="de-metadata">Horizon</p>
            <p className="mt-1 text-[13.5px]">{artifact.horizon}</p>
          </div>
          <div>
            <p className="de-metadata">Method</p>
            <p className="mt-1 text-[13.5px]">{artifact.method}</p>
          </div>
        </div>
      </ArtifactContent>
    </Artifact>
  );
}
