"use client";

import type { TrendArtifact as TrendArtifactData } from "@data-elements/schema";
import {
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  ChartNoAxesCombinedIcon,
  MinusIcon,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useArtifactAction } from "./bridge";
import {
  Artifact,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactStatus,
  ArtifactTitle,
} from "./primitives";
import { shape } from "./tokens";
import { cn, formatNumber } from "./utils";

export function TrendArtifact({
  artifact,
  locale = "en-US",
}: {
  artifact: TrendArtifactData;
  locale?: string;
}) {
  const emit = useArtifactAction(artifact);
  const latest = artifact.points.at(-1)?.value ?? 0;
  const baseline = artifact.points[0]?.value ?? latest;
  const change =
    artifact.change ??
    (baseline === 0 ? 0 : ((latest - baseline) / Math.abs(baseline)) * 100);
  const up = change > 0;
  const down = change < 0;
  const numberOptions = {
    format: artifact.format,
    currency: artifact.currency,
    locale,
  } as const;
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(
      new Date(value),
    );

  return (
    <Artifact className="de-trend-artifact">
      <ArtifactHeader>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ArtifactTitle>{artifact.title}</ArtifactTitle>
            <ArtifactStatus icon={ChartNoAxesCombinedIcon}>
              Trend
            </ArtifactStatus>
          </div>
          <ArtifactDescription>{artifact.description}</ArtifactDescription>
        </div>
      </ArtifactHeader>
      <ArtifactContent className="p-4 sm:p-4">
        <div className={cn("de-field flex flex-wrap items-end justify-between gap-4 px-4 py-3", shape.field)}>
          <div>
            <p className="text-[13px] text-muted-foreground">
              {artifact.metricLabel}
            </p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">
              {formatNumber(latest, numberOptions)}
            </p>
          </div>
          <div
            className={
              up
                ? "de-positive inline-flex items-center gap-1 text-[13.5px] font-medium"
                : down
                  ? "de-negative inline-flex items-center gap-1 text-[13.5px] font-medium"
                  : "inline-flex items-center gap-1 text-[13.5px] text-muted-foreground"
            }
          >
            {up ? (
              <ArrowUpRightIcon aria-hidden="true" className="size-4" />
            ) : down ? (
              <ArrowDownRightIcon aria-hidden="true" className="size-4" />
            ) : (
              <MinusIcon aria-hidden="true" className="size-4" />
            )}
            {change > 0 ? "+" : ""}
            {change.toFixed(1)}%{" "}
            <span className="font-normal text-muted-foreground">
              {artifact.changeLabel ?? "over period"}
            </span>
          </div>
        </div>
        <div
          className="mt-4 h-64 min-w-0"
          role="img"
          aria-label={`${artifact.metricLabel} trend chart`}
        >
          <ResponsiveContainer
            height="100%"
            initialDimension={{ height: 256, width: 640 }}
            width="100%"
          >
            <AreaChart
              data={artifact.points}
              margin={{ bottom: 0, left: 0, right: 12, top: 10 }}
              onClick={(state) => {
                const point = artifact.points.find(
                  (candidate) =>
                    candidate.timestamp === String(state?.activeLabel),
                );
                if (point) void emit("trend-point-select", point);
              }}
            >
              <defs>
                <linearGradient
                  id={`de-trend-${artifact.id}`}
                  x1="0"
                  x2="0"
                  y1="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor="var(--chart-1)"
                    stopOpacity={0.18}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--chart-1)"
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid
                stroke="var(--border)"
                strokeDasharray="3 4"
                strokeOpacity={0.55}
                vertical={false}
              />
              <XAxis
                axisLine={false}
                dataKey="timestamp"
                minTickGap={36}
                tick={{ fill: "var(--muted-foreground)" }}
                tickFormatter={formatDate}
                tickLine={false}
              />
              <YAxis
                axisLine={false}
                tick={{ fill: "var(--muted-foreground)" }}
                tickFormatter={(value) =>
                  formatNumber(Number(value), {
                    ...numberOptions,
                    format:
                      artifact.format === "currency"
                        ? "compact"
                        : artifact.format,
                  })
                }
                tickLine={false}
                width={52}
              />
              {artifact.target != null && (
                <ReferenceLine
                  stroke="var(--muted-foreground)"
                  strokeDasharray="4 4"
                  y={artifact.target}
                />
              )}
              <Tooltip
                formatter={(value) => [
                  formatNumber(Number(value), numberOptions),
                  artifact.metricLabel,
                ]}
                labelFormatter={(value) => formatDate(String(value))}
              />
              <Area
                dataKey="value"
                fill={`url(#de-trend-${artifact.id})`}
                stroke="var(--chart-1)"
                strokeWidth={2}
                type="monotone"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        {artifact.insight && (
          <p className="mt-4 border-t de-divider pt-4 text-[13.5px] leading-6 text-muted-foreground">
            {artifact.insight}
          </p>
        )}
      </ArtifactContent>
    </Artifact>
  );
}
