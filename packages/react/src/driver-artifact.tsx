"use client";

import type { DriverArtifact as DriverArtifactData } from "@data-elements/schema";
import { BetweenHorizontalStartIcon } from "lucide-react";
import { useArtifactAction } from "./bridge";
import { Artifact, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactStatus, ArtifactTitle } from "./primitives";
import { shape } from "./tokens";
import { cn, formatNumber } from "./utils";

type DriverBar = { id: string; label: string; value: number; start: number; end: number; kind: "total" | "positive" | "negative" };

export function DriverArtifact({ artifact, locale = "en-US" }: { artifact: DriverArtifactData; locale?: string }) {
  const emit = useArtifactAction(artifact);
  const numberOptions = { format: artifact.format, currency: artifact.currency, locale } as const;
  let running = artifact.startValue;
  const bars: DriverBar[] = [{ id: "start", label: artifact.startLabel, value: artifact.startValue, start: 0, end: artifact.startValue, kind: "total" }];
  for (const driver of artifact.drivers) {
    const start = running;
    running += driver.value;
    bars.push({ id: driver.id, label: driver.label, value: driver.value, start: Math.min(start, running), end: Math.max(start, running), kind: driver.value >= 0 ? "positive" : "negative" });
  }
  bars.push({ id: "end", label: artifact.endLabel, value: artifact.endValue, start: 0, end: artifact.endValue, kind: "total" });
  const extentMin = Math.min(0, ...bars.map((bar) => bar.start));
  const extentMax = Math.max(...bars.map((bar) => bar.end));
  const extent = Math.max(extentMax - extentMin, 1);
  const change = artifact.endValue - artifact.startValue;
  const reconciliation = artifact.endValue - running;

  return <Artifact className="de-driver-artifact">
    <ArtifactHeader><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><ArtifactTitle>{artifact.title}</ArtifactTitle><ArtifactStatus icon={BetweenHorizontalStartIcon}>Drivers</ArtifactStatus></div><ArtifactDescription>{artifact.description}</ArtifactDescription></div></ArtifactHeader>
    <ArtifactContent className="p-4 sm:p-4">
      <div className={cn("de-field flex flex-wrap items-end justify-between gap-4 px-4 py-3", shape.field)}><div><p className="text-[13px] text-muted-foreground">{artifact.metricLabel}</p><p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{formatNumber(artifact.endValue, numberOptions)}</p></div><div className="text-right"><p className="de-metadata">Net change</p><p className={change > 0 ? "de-positive mt-1 font-mono text-[13.5px] font-semibold" : change < 0 ? "de-negative mt-1 font-mono text-[13.5px] font-semibold" : "mt-1 font-mono text-[13.5px] font-semibold"}>{change > 0 ? "+" : ""}{formatNumber(change, numberOptions)}</p></div></div>
      <div className="mt-4 grid gap-3">
        {bars.map((bar, index) => {
          const left = ((bar.start - extentMin) / extent) * 100;
          const width = Math.max(1.5, ((bar.end - bar.start) / extent) * 100);
          const source = artifact.drivers.find((driver) => driver.id === bar.id);
          const content = <><span className="w-24 shrink-0 truncate text-[13px] font-medium sm:w-32">{bar.label}</span><span className={cn("de-field relative h-7 min-w-0 flex-1", shape.indicator)}><span className={cn("absolute inset-y-1", shape.indicator, bar.kind === "total" ? "bg-foreground" : bar.kind === "positive" ? "de-positive-fill" : "de-negative-fill")} style={{ left: `${left}%`, width: `${width}%` }} /></span><span className="w-24 shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums">{bar.kind === "total" ? formatNumber(bar.value, numberOptions) : `${bar.value > 0 ? "+" : ""}${formatNumber(bar.value, numberOptions)}`}</span></>;
          return source ? <button className={cn("de-quiet-button flex w-full touch-manipulation items-center gap-3 px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20", shape.field)} key={bar.id} onClick={() => void emit("driver-select", { driverId: bar.id, index: index - 1 })} title={source.note} type="button">{content}</button> : <div className="flex items-center gap-3 px-2 py-1.5" key={bar.id}>{content}</div>;
        })}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4 border-t de-divider pt-3 text-[11px] tracking-tight text-muted-foreground"><span>Positive</span><span>Negative</span><span>Total</span>{Math.abs(reconciliation) > 0.01 && <span className="de-warning ml-auto">Unexplained {formatNumber(reconciliation, numberOptions)}</span>}</div>
      {artifact.footnote && <p className="mt-3 text-[13px] leading-5 text-muted-foreground">{artifact.footnote}</p>}
    </ArtifactContent>
  </Artifact>;
}
