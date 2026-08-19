"use client";

import type { BreakdownArtifact as BreakdownArtifactData } from "@data-elements/schema";
import { ArrowDownRightIcon, ArrowUpRightIcon, ListTreeIcon, MinusIcon } from "lucide-react";
import { useArtifactAction } from "./bridge";
import { Artifact, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactStatus, ArtifactTitle } from "./primitives";
import { formatNumber } from "./utils";

export function BreakdownArtifact({ artifact, locale = "en-US" }: { artifact: BreakdownArtifactData; locale?: string }) {
  const emit = useArtifactAction(artifact);
  const total = artifact.total ?? artifact.items.reduce((sum, item) => sum + item.value, 0);
  const maxValue = Math.max(...artifact.items.map((item) => Math.abs(item.value)), 1);
  const numberOptions = { format: artifact.format, currency: artifact.currency, locale } as const;

  return <Artifact className="de-breakdown-artifact">
    <ArtifactHeader><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><ArtifactTitle>{artifact.title}</ArtifactTitle><ArtifactStatus icon={ListTreeIcon}>Breakdown</ArtifactStatus></div><ArtifactDescription>{artifact.description}</ArtifactDescription></div></ArtifactHeader>
    <ArtifactContent>
      <div className="de-field flex flex-wrap items-end justify-between gap-3 px-4 py-3 sm:px-4"><div><p className="text-[13px] text-muted-foreground">{artifact.metricLabel}</p><p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{formatNumber(total, numberOptions)}</p></div><p className="de-metadata">Ranked by {artifact.dimensionLabel.toLocaleLowerCase(locale)}</p></div>
      <ol className="de-list">
        {artifact.items.map((item, index) => {
          const share = item.share ?? (total === 0 ? 0 : (item.value / total) * 100);
          const change = item.change ?? 0;
          return <li key={item.id}><button className="de-quiet-button de-list-row group grid w-full touch-manipulation grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20 sm:px-4" onClick={() => void emit("breakdown-item-select", { itemId: item.id, rank: index + 1 })} type="button"><span className="de-metadata">{String(index + 1).padStart(2, "0")}</span><span className="min-w-0"><span className="flex min-w-0 items-baseline justify-between gap-3"><span className="truncate text-[13.5px] font-medium">{item.label}</span><span className="font-mono text-[11px] tracking-tight text-muted-foreground tabular-nums">{share.toFixed(1)}%</span></span><span className="de-progress-track mt-2 block"><span className="de-progress-value block" style={{ width: `${Math.max(2, (Math.abs(item.value) / maxValue) * 100)}%` }} /></span>{item.note && <span className="de-metadata mt-1.5 block truncate">{item.note}</span>}</span><span className="min-w-24 text-right"><span className="block font-mono text-[13.5px] font-semibold tabular-nums">{formatNumber(item.value, numberOptions)}</span>{item.change != null && <span className={change > 0 ? "de-positive mt-1 inline-flex items-center gap-0.5 text-[11px]" : change < 0 ? "de-negative mt-1 inline-flex items-center gap-0.5 text-[11px]" : "mt-1 inline-flex items-center gap-0.5 text-[11px] text-muted-foreground"}>{change > 0 ? <ArrowUpRightIcon aria-hidden="true" className="size-3" /> : change < 0 ? <ArrowDownRightIcon aria-hidden="true" className="size-3" /> : <MinusIcon aria-hidden="true" className="size-3" />}{change > 0 ? "+" : ""}{change.toFixed(1)}%</span>}</span></button></li>;
        })}
      </ol>
      {artifact.insight && <p className="de-list-note text-[13px] leading-5 text-muted-foreground">{artifact.insight}</p>}
    </ArtifactContent>
  </Artifact>;
}
