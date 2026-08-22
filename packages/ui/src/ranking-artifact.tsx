"use client";

import type { RankingArtifact as RankingArtifactData } from "@open-tessera/schema";
import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon, TrophyIcon } from "lucide-react";
import { useArtifactAction } from "./bridge";
import { Artifact, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactStatus, ArtifactTitle } from "./primitives";
import { shape } from "./tokens";
import { cn, formatNumber } from "./utils";

export function RankingArtifact({ artifact, locale = "en-US" }: { artifact: RankingArtifactData; locale?: string }) {
  const emit = useArtifactAction(artifact);
  const numberOptions = { format: artifact.format, currency: artifact.currency, locale } as const;
  const items = [...artifact.items].sort((left, right) => left.rank - right.rank);

  return <Artifact className="de-ranking-artifact">
    <ArtifactHeader>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><ArtifactTitle>{artifact.title}</ArtifactTitle><ArtifactStatus icon={TrophyIcon}>Ranking</ArtifactStatus></div>
        <ArtifactDescription>{artifact.description}</ArtifactDescription>
      </div>
    </ArtifactHeader>
    <ArtifactContent>
      <div className="de-field flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-[13px] sm:px-4">
        <span className="font-medium text-foreground">{artifact.metricLabel}</span>
        <span className="text-muted-foreground">{items.length.toLocaleString(locale)} ranked {items.length === 1 ? "item" : "items"}</span>
      </div>
      <ol className="de-list">
        {items.map((item) => {
          const highlighted = item.id === artifact.highlightId;
          const change = item.change ?? 0;
          return <li key={item.id}>
            <button
              aria-current={highlighted ? "true" : undefined}
              className={highlighted
                ? "de-field-interactive de-list-row group grid w-full touch-manipulation grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-3 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:px-4"
                : "de-quiet-button de-list-row group grid w-full touch-manipulation grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-3 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:px-4"}
              data-highlighted={highlighted || undefined}
              onClick={() => void emit("ranking-item-select", { itemId: item.id, rank: item.rank })}
              type="button"
            >
              <span className={cn("grid size-9 place-items-center text-[13px] font-semibold tabular-nums", shape.inner, highlighted ? "bg-foreground text-background" : "de-field font-mono text-muted-foreground")}>{item.rank}</span>
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-semibold">{item.label}</span>
                {item.note && <span className="mt-1 block truncate text-[11px] text-muted-foreground">{item.note}</span>}
              </span>
              <span className="col-start-2 mt-1 flex min-w-0 flex-wrap items-center justify-between gap-x-3 text-right sm:col-start-3 sm:row-start-1 sm:mt-0 sm:block sm:min-w-24">
                <span className="block font-mono text-[13.5px] font-semibold tabular-nums">{formatNumber(item.value, numberOptions)}</span>
                {item.change != null && <span className={change > 0 ? "de-positive mt-1 inline-flex items-center gap-0.5 text-[11px]" : change < 0 ? "de-negative mt-1 inline-flex items-center gap-0.5 text-[11px]" : "mt-1 inline-flex items-center gap-0.5 text-[11px] text-muted-foreground"}>{change > 0 ? <ArrowUpRightIcon aria-hidden="true" className="size-3" /> : change < 0 ? <ArrowDownRightIcon aria-hidden="true" className="size-3" /> : <MinusIcon aria-hidden="true" className="size-3" />}{change > 0 ? "+" : ""}{change.toFixed(1)}%</span>}
              </span>
            </button>
          </li>;
        })}
      </ol>
      {artifact.insight && <p className="de-list-note text-[13px] leading-5 text-muted-foreground">{artifact.insight}</p>}
    </ArtifactContent>
  </Artifact>;
}
