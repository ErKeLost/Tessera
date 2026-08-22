"use client";

import type { FunnelArtifact as FunnelArtifactData } from "@open-tessera/schema";
import { ChevronRightIcon, FunnelIcon } from "lucide-react";
import { useArtifactAction } from "./bridge";
import { Artifact, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactStatus, ArtifactTitle } from "./primitives";

export function FunnelArtifact({ artifact, locale = "en-US" }: { artifact: FunnelArtifactData; locale?: string }) {
  const emit = useArtifactAction(artifact);
  const first = artifact.steps[0]?.value ?? 0;
  const final = artifact.steps.at(-1)?.value ?? 0;
  const overallConversion = first > 0 ? (final / first) * 100 : 0;
  return <Artifact>
    <ArtifactHeader><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><ArtifactTitle>{artifact.title}</ArtifactTitle><ArtifactStatus icon={FunnelIcon}>Funnel</ArtifactStatus></div><ArtifactDescription>{artifact.description}</ArtifactDescription></div></ArtifactHeader>
    <ArtifactContent>
      <div className="de-stat-grid grid-cols-3 gap-px">
        <div className="de-stat-cell"><p className="de-metadata">Entered</p><p className="mt-1 font-mono text-[13.5px] font-semibold tabular-nums">{first.toLocaleString(locale)}</p></div>
        <div className="de-stat-cell"><p className="de-metadata">Completed</p><p className="mt-1 font-mono text-[13.5px] font-semibold tabular-nums">{final.toLocaleString(locale)}</p></div>
        <div className="de-stat-cell"><p className="de-metadata">Overall</p><p className="mt-1 font-mono text-[13.5px] font-semibold tabular-nums">{overallConversion.toFixed(1)}%</p></div>
      </div>
      <ol className="de-list">{artifact.steps.map((step, index) => { const previous = artifact.steps[index - 1]?.value; const conversion = step.conversionFromPrevious ?? (previous && previous > 0 ? (step.value / previous) * 100 : index === 0 ? 100 : 0); const width = first > 0 ? Math.max(6, (step.value / first) * 100) : 0; return <li key={step.id}><button className="de-quiet-button de-list-row group grid w-full touch-manipulation grid-cols-[2rem_minmax(0,1fr)_auto_1rem] items-center gap-3 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20 sm:px-4" onClick={() => void emit("funnel-step-select", { stepId: step.id, index })} type="button"><span className="de-metadata">{String(index + 1).padStart(2, "0")}</span><span className="min-w-0"><span className="flex min-w-0 items-baseline gap-2"><span className="truncate text-[13.5px] font-medium">{step.label}</span><span className="de-metadata hidden shrink-0 sm:inline">{index === 0 ? "Entry" : `${conversion.toFixed(1)}% retained`}</span></span><span className="de-progress-track mt-2 block"><span className="de-progress-value block" style={{ width: `${width}%` }} /></span>{step.note && <span className="de-metadata mt-1.5 block truncate">{step.note}</span>}</span><span className="text-right"><span className="block font-mono text-[13.5px] font-semibold tabular-nums">{step.value.toLocaleString(locale)}</span>{index > 0 && previous != null && <span className="de-metadata mt-0.5 block">-{(previous - step.value).toLocaleString(locale)}</span>}</span><ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" /></button></li>; })}</ol>
      {artifact.footnote && <p className="de-list-note text-[11px] leading-5 text-pretty text-muted-foreground">{artifact.footnote}</p>}
    </ArtifactContent>
  </Artifact>;
}
