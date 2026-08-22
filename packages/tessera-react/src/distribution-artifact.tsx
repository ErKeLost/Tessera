"use client";

import type { DistributionArtifact as DistributionArtifactData } from "@open-tessera/schema";
import { ChartNoAxesColumnIncreasingIcon } from "lucide-react";
import {
  Bar,
  BarChart,
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

export function DistributionArtifact({
  artifact,
  locale = "en-US",
}: {
  artifact: DistributionArtifactData;
  locale?: string;
}) {
  const emit = useArtifactAction(artifact);
  const numberOptions = {
    format: artifact.format,
    currency: artifact.currency,
    locale,
  } as const;
  const span = Math.max(artifact.summary.max - artifact.summary.min, 1);
  const meanPosition =
    ((artifact.summary.mean - artifact.summary.min) / span) * 100;
  const medianPosition =
    ((artifact.summary.median - artifact.summary.min) / span) * 100;

  return (
    <Artifact className="de-distribution-artifact">
      <ArtifactHeader>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ArtifactTitle>{artifact.title}</ArtifactTitle>
            <ArtifactStatus icon={ChartNoAxesColumnIncreasingIcon}>
              Distribution
            </ArtifactStatus>
          </div>
          <ArtifactDescription>{artifact.description}</ArtifactDescription>
        </div>
      </ArtifactHeader>
      <ArtifactContent className="p-4 sm:p-4">
        <div className="de-stat-grid grid-cols-2 gap-px sm:grid-cols-4">
          {[
            {
              label: "Observations",
              value: artifact.summary.count.toLocaleString(locale),
            },
            {
              label: "Median",
              value: formatNumber(artifact.summary.median, numberOptions),
            },
            {
              label: "Mean",
              value: formatNumber(artifact.summary.mean, numberOptions),
            },
            {
              label: "Outliers",
              value: artifact.outlierCount.toLocaleString(locale),
            },
          ].map((item) => (
            <div className="de-stat-cell" key={item.label}>
              <p className="de-metadata">{item.label}</p>
              <p className="mt-1 font-mono text-base font-semibold tabular-nums">
                {item.value}
              </p>
            </div>
          ))}
        </div>
        <div
          className="mt-5 h-64 min-w-0"
          role="img"
          aria-label={`${artifact.metricLabel} histogram`}
        >
          <ResponsiveContainer
            height="100%"
            initialDimension={{ height: 256, width: 640 }}
            width="100%"
          >
            <BarChart
              data={artifact.bins}
              margin={{ bottom: 0, left: 0, right: 8, top: 12 }}
              onClick={(state) => {
                const bin = artifact.bins.find(
                  (candidate) => candidate.label === String(state?.activeLabel),
                );
                if (bin)
                  void emit("distribution-bin-select", {
                    binId: bin.id,
                    min: bin.min,
                    max: bin.max,
                  });
              }}
            >
              <CartesianGrid
                stroke="var(--border)"
                strokeDasharray="3 4"
                strokeOpacity={0.55}
                vertical={false}
              />
              <XAxis
                axisLine={false}
                dataKey="label"
                interval="preserveStartEnd"
                minTickGap={18}
                tick={{ fill: "var(--muted-foreground)" }}
                tickLine={false}
              />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tick={{ fill: "var(--muted-foreground)" }}
                tickLine={false}
                width={44}
              />
              <Tooltip
                formatter={(value) => [
                  Number(value).toLocaleString(locale),
                  "Observations",
                ]}
              />
              <Bar
                dataKey="count"
                fill="var(--chart-1)"
                maxBarSize={54}
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 border-t de-divider pt-4">
          <div
            className="relative h-5"
            aria-label={`Quartile range from ${formatNumber(artifact.summary.p25, numberOptions)} to ${formatNumber(artifact.summary.p75, numberOptions)}`}
            role="img"
          >
            <span
              className="de-data-guide absolute top-2 h-px"
              style={{ left: "0%", right: "0%" }}
            />
            <span
              className={cn(
                "de-data-guide absolute top-1 h-2",
                shape.indicator,
              )}
              style={{
                left: `${((artifact.summary.p25 - artifact.summary.min) / span) * 100}%`,
                right: `${100 - ((artifact.summary.p75 - artifact.summary.min) / span) * 100}%`,
              }}
            />
            <span
              className="absolute top-0 h-4 w-px bg-foreground"
              style={{ left: `${medianPosition}%` }}
              title="Median"
            />
            <span
              className={cn(
                "de-warning-marker absolute top-0 size-2 -translate-x-1/2 border-2 border-background",
                shape.full,
              )}
              style={{ left: `${meanPosition}%` }}
              title="Mean"
            />
          </div>
          <div className="flex justify-between text-[11px] tracking-tight text-muted-foreground">
            <span>{formatNumber(artifact.summary.min, numberOptions)}</span>
            <span>IQR</span>
            <span>{formatNumber(artifact.summary.max, numberOptions)}</span>
          </div>
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
