"use client";

import type { InsightArtifact as InsightArtifactData } from "@data-elements/schema";
import { ArrowRightIcon, ArrowUpRightIcon, LightbulbIcon } from "lucide-react";
import { useArtifactAction, useArtifactActionAvailability } from "./bridge";
import { Artifact, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactStatus, ArtifactTitle } from "./primitives";
import { shape } from "./tokens";
import { cn } from "./utils";

export function InsightArtifact({ artifact }: { artifact: InsightArtifactData }) {
  const emit = useArtifactAction(artifact);
  const canRunRecommendedAction = useArtifactActionAvailability(artifact, "insight-action", { brokered: true });
  const recommendedAction = artifact.recommendedAction;
  return <Artifact className="de-insight-artifact">
    <ArtifactHeader><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><ArtifactTitle>{artifact.title}</ArtifactTitle><ArtifactStatus icon={LightbulbIcon}>Insights</ArtifactStatus></div><ArtifactDescription>{artifact.description}</ArtifactDescription></div></ArtifactHeader>
    <ArtifactContent><div className="de-list">{artifact.insights.map((insight, index) => <button className="de-quiet-button de-list-row group flex w-full touch-manipulation items-start gap-3 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20 sm:px-4" key={insight.id} onClick={() => void emit("insight-select", { insightId: insight.id })} type="button"><span className={cn("de-field grid size-7 shrink-0 place-items-center text-muted-foreground", shape.inner)}><LightbulbIcon aria-hidden="true" className="size-3.5" /></span><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="de-metadata">{String(index + 1).padStart(2, "0")}</span><strong className="text-[13.5px] font-medium">{insight.headline}</strong></span><span className="mt-1.5 block text-[13.5px] leading-6 text-muted-foreground">{insight.detail}</span>{insight.evidence && <span className="mt-2 block border-l de-divider pl-3 text-[13px] leading-5 text-muted-foreground">{insight.evidence}</span>}</span><ArrowUpRightIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" /></button>)}</div>{recommendedAction && canRunRecommendedAction && <div className="de-list-footer"><button className={cn("de-quiet-button inline-flex min-h-8 touch-manipulation items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium", shape.full)} onClick={() => void emit("insight-action", { action: recommendedAction }, { brokered: true })} type="button">{recommendedAction}<ArrowRightIcon aria-hidden="true" className="size-3.5" /></button></div>}</ArtifactContent>
  </Artifact>;
}
