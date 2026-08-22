"use client";

import type { ComparisonArtifact as ComparisonArtifactData } from "@open-tessera/schema";
import { ArrowRightIcon, CheckIcon, GitCompareArrowsIcon } from "lucide-react";
import { useArtifactAction, useArtifactActionAvailability } from "./bridge";
import { Artifact, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactStatus, ArtifactTitle } from "./primitives";
import { shape } from "./tokens";
import { cn } from "./utils";

export function ComparisonArtifact({ artifact }: { artifact: ComparisonArtifactData }) {
  const emit = useArtifactAction(artifact);
  const canSelectRecommendation = useArtifactActionAvailability(artifact, "recommendation-select", { brokered: true });
  const recommendation = artifact.recommendation;

  return <Artifact>
    <ArtifactHeader>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><ArtifactTitle>{artifact.title}</ArtifactTitle><ArtifactStatus icon={GitCompareArrowsIcon}>Comparison</ArtifactStatus></div>
        <ArtifactDescription>{artifact.description}</ArtifactDescription>
      </div>
    </ArtifactHeader>
    <ArtifactContent className="overflow-x-auto p-4 sm:p-4">
      <div className="de-table-shell min-w-[520px]">
        <table className="w-full text-[13.5px]">
          <thead className="de-field">
            <tr>
              <th className="w-40 border-b de-divider px-3 py-3 text-left font-mono text-[11px] tracking-tight text-muted-foreground">{artifact.subjectLabel}</th>
              {artifact.subjects.map((subject) => <th className="border-b de-divider px-3 py-3 text-left text-[13.5px] font-medium" key={subject.id}>{subject.label}</th>)}
            </tr>
          </thead>
          <tbody>{artifact.criteria.map((criterion) => <tr className="de-table-row border-b last:border-0" key={criterion.id}>
            <th className="px-3 py-3 text-left text-[13px] font-medium text-muted-foreground">{criterion.label}</th>
            {artifact.subjects.map((subject) => <td className="px-3 py-3 text-[13px] tabular-nums" key={subject.id}>{criterion.winnerId === subject.id ? <span className="de-positive inline-flex items-center gap-1.5 font-medium"><CheckIcon aria-hidden="true" className="size-3.5" />{String(criterion.values[subject.id] ?? "-")}</span> : String(criterion.values[subject.id] ?? "-")}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      {recommendation && canSelectRecommendation && <button className={cn("de-field-interactive group mt-4 flex w-full touch-manipulation items-start justify-between gap-3 p-4 text-left text-[13.5px] leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20", shape.field)} onClick={() => void emit("recommendation-select", { recommendation }, { brokered: true })} type="button"><span><span className="de-metadata block">Recommendation</span><span className="mt-1.5 block text-pretty text-foreground">{recommendation}</span></span><ArrowRightIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" /></button>}
    </ArtifactContent>
  </Artifact>;
}
