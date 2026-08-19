"use client";

import type { ExperimentArtifact as ExperimentArtifactData } from "@data-elements/schema";
import { AlertTriangleIcon, CheckCircle2Icon, CircleAlertIcon, FlaskConicalIcon } from "lucide-react";
import { Artifact, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactStatus, ArtifactTitle } from "./primitives";
import { shape } from "./tokens";
import { cn, formatNumber } from "./utils";

const guardrailStyles = {
  passed: { icon: CheckCircle2Icon, className: "de-positive", label: "Passed" },
  warning: { icon: CircleAlertIcon, className: "de-warning", label: "Warning" },
  failed: { icon: AlertTriangleIcon, className: "de-negative", label: "Failed" },
} as const;

export function ExperimentArtifact({ artifact, locale = "en-US" }: { artifact: ExperimentArtifactData; locale?: string }) {
  const numberOptions = { format: artifact.format, currency: artifact.currency, locale } as const;
  const intervalMin = Math.min(artifact.effect.ciLower, 0);
  const intervalMax = Math.max(artifact.effect.ciUpper, 0);
  const intervalSpan = Math.max(intervalMax - intervalMin, 0.0001);
  const zeroPosition = ((0 - intervalMin) / intervalSpan) * 100;
  const lowerPosition = ((artifact.effect.ciLower - intervalMin) / intervalSpan) * 100;
  const upperPosition = ((artifact.effect.ciUpper - intervalMin) / intervalSpan) * 100;
  const effectPosition = Math.max(lowerPosition, Math.min(upperPosition, ((artifact.effect.absolute - intervalMin) / intervalSpan) * 100));

  return <Artifact className="de-experiment-artifact">
    <ArtifactHeader><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><ArtifactTitle>{artifact.title}</ArtifactTitle><ArtifactStatus icon={FlaskConicalIcon}>{artifact.effect.significant ? "Significant" : "Inconclusive"}</ArtifactStatus></div><ArtifactDescription>{artifact.description}</ArtifactDescription></div></ArtifactHeader>
    <ArtifactContent>
      <div className="de-stat-grid gap-px sm:grid-cols-2">
        {[{ label: "Control", variant: artifact.control }, { label: "Treatment", variant: artifact.treatment }].map(({ label, variant }) => <div className="de-stat-cell" key={variant.id}><div className="flex items-center justify-between gap-2"><p className="de-metadata">{label}</p><p className="de-metadata">n={variant.sampleSize.toLocaleString(locale)}</p></div><p className="mt-2 text-[13.5px] font-medium">{variant.label}</p><p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{formatNumber(variant.value, numberOptions)}</p></div>)}
      </div>
      <div className="px-4 py-5 sm:px-4">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[13px] text-muted-foreground">Absolute effect</p><p className={artifact.effect.absolute > 0 ? "de-positive mt-1 font-mono text-2xl font-semibold tabular-nums" : artifact.effect.absolute < 0 ? "de-negative mt-1 font-mono text-2xl font-semibold tabular-nums" : "mt-1 font-mono text-2xl font-semibold tabular-nums"}>{artifact.effect.absolute > 0 ? "+" : ""}{formatNumber(artifact.effect.absolute, numberOptions)}</p></div><div className="text-right"><p className="text-[13px] text-muted-foreground">Relative lift</p><p className="mt-1 font-mono text-[13.5px] font-semibold tabular-nums">{artifact.effect.relative > 0 ? "+" : ""}{artifact.effect.relative.toFixed(1)}%</p></div></div>
        <div className="mt-5" role="img" aria-label={`${artifact.effect.confidenceLevel}% confidence interval from ${artifact.effect.ciLower} to ${artifact.effect.ciUpper}`}>
          <div className="relative h-8"><span className="de-data-guide absolute top-4 h-px w-full" /><span className="de-data-guide-strong absolute top-1 h-7 w-px" style={{ left: `${zeroPosition}%` }} /><span className={cn("absolute top-[0.9rem] h-1 bg-foreground", shape.full)} style={{ left: `${lowerPosition}%`, width: `${Math.max(1, upperPosition - lowerPosition)}%` }} /><span className={cn("de-data-marker absolute top-2 size-4 -translate-x-1/2 border-4", shape.full)} style={{ left: `${effectPosition}%` }} /></div>
          <div className="mt-1 flex justify-between text-[11px] tracking-tight text-muted-foreground"><span>{artifact.effect.ciLower > 0 ? "+" : ""}{artifact.effect.ciLower.toFixed(1)}</span><span>{artifact.effect.confidenceLevel}% confidence interval</span><span>{artifact.effect.ciUpper > 0 ? "+" : ""}{artifact.effect.ciUpper.toFixed(1)}</span></div>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t de-divider pt-4 text-[11px] text-muted-foreground"><span>Method <strong className="font-medium text-foreground">{artifact.method}</strong></span>{artifact.effect.pValue != null && <span>p-value <strong className="font-mono font-medium text-foreground">{artifact.effect.pValue < 0.001 ? "<0.001" : artifact.effect.pValue.toFixed(3)}</strong></span>}</div>
      </div>
      {artifact.guardrails.length > 0 && <div className="border-t de-divider px-4 py-4 sm:px-4"><p className="de-metadata mb-2">Guardrails</p><ul className="grid gap-3 sm:grid-cols-2">{artifact.guardrails.map((guardrail) => { const style = guardrailStyles[guardrail.status]; const Icon = style.icon; return <li className="flex items-start gap-2 text-[13px]" key={guardrail.id}><Icon aria-hidden="true" className={`mt-0.5 size-3.5 shrink-0 ${style.className}`} /><span><span className="font-medium">{guardrail.label}</span>{guardrail.detail && <span className="block pt-0.5 text-muted-foreground">{guardrail.detail}</span>}</span><span className="sr-only">{style.label}</span></li>; })}</ul></div>}
      {artifact.conclusion && <p className="de-field px-4 py-3 text-[13px] leading-5 text-muted-foreground sm:px-4">{artifact.conclusion}</p>}
    </ArtifactContent>
  </Artifact>;
}
