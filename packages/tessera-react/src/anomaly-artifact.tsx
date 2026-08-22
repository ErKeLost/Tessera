"use client";

import type { AnomalyArtifact as AnomalyArtifactData } from "@open-tessera/schema";
import { AlertTriangleIcon, ArrowRightIcon, CheckCircle2Icon, CircleAlertIcon } from "lucide-react";
import { useArtifactAction, useArtifactActionAvailability } from "./bridge";
import { Artifact, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactStatus, ArtifactTitle } from "./primitives";
import { shape } from "./tokens";
import { cn, formatNumber } from "./utils";

const severityStyle = {
  low: { icon: CheckCircle2Icon, text: "de-positive", label: "Low" },
  medium: { icon: CircleAlertIcon, text: "de-warning", label: "Medium" },
  high: { icon: AlertTriangleIcon, text: "de-negative", label: "High" },
} as const;

export function AnomalyArtifact({ artifact, locale = "en-US" }: { artifact: AnomalyArtifactData; locale?: string }) {
  const emit = useArtifactAction(artifact);
  const canRunNextStep = useArtifactActionAvailability(artifact, "anomaly-next-step", { brokered: true });
  const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const nextStep = artifact.nextStep;

  return <Artifact className="de-anomaly-artifact">
    <ArtifactHeader><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><ArtifactTitle>{artifact.title}</ArtifactTitle><ArtifactStatus icon={CircleAlertIcon}>{artifact.anomalies.length} detected</ArtifactStatus></div><ArtifactDescription>{artifact.description}</ArtifactDescription></div></ArtifactHeader>
    <ArtifactContent>
      {artifact.summary && <p className="de-field px-4 py-3 text-[13px] leading-5 text-pretty text-muted-foreground sm:px-4">{artifact.summary}</p>}
      <div className="de-list">
        {artifact.anomalies.map((item) => {
          const style = severityStyle[item.severity];
          const Icon = style.icon;
          return <button className="de-quiet-button de-list-row group grid w-full touch-manipulation grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto] sm:px-4" key={item.id} onClick={() => void emit("anomaly-select", { anomalyId: item.id })} type="button">
            <span className={`mt-0.5 grid size-5 place-items-center ${style.text}`}><Icon aria-hidden="true" className="size-3.5" /></span>
            <span className="min-w-0"><span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-[13.5px] font-medium">{item.label}</span><span className={`font-mono text-[11px] tracking-tight ${style.text}`}>{style.label}</span></span><span className="de-metadata mt-1 block">{date(item.timestamp)}</span>{item.explanation && <span className="mt-2 block text-[13px] leading-5 text-pretty text-muted-foreground">{item.explanation}</span>}</span>
            <span className="col-start-2 mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 sm:col-start-3 sm:row-start-1 sm:mt-0 sm:min-w-36 sm:justify-end sm:text-right"><strong className="font-mono text-base font-semibold tabular-nums">{formatNumber(item.actual, { format: artifact.format, currency: artifact.currency, locale })}</strong><span className={`font-mono text-[11px] tracking-tight font-medium tabular-nums ${style.text}`}>{item.deviation > 0 ? "+" : ""}{item.deviation.toFixed(1)}%</span><span className="de-metadata w-full sm:text-right">Expected {formatNumber(item.expected, { format: artifact.format, currency: artifact.currency, locale })}</span></span>
          </button>;
        })}
      </div>
      {nextStep && canRunNextStep && <div className="de-list-footer"><button className={cn("de-quiet-button inline-flex min-h-8 touch-manipulation items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium", shape.full)} onClick={() => void emit("anomaly-next-step", { nextStep }, { brokered: true })} type="button">{nextStep}<ArrowRightIcon aria-hidden="true" className="size-3.5" /></button></div>}
    </ArtifactContent>
  </Artifact>;
}
