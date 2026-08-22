"use client";

import {
  getCalculator,
  normalizeCalculatorValues,
  type CalculatorDefinition,
} from "@open-tessera/core";
import type { CalculatorArtifact as CalculatorArtifactData } from "@open-tessera/schema";
import { CalculatorIcon, CopyIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useArtifactAction } from "./bridge";
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactStatus,
  ArtifactTitle,
} from "./primitives";
import { cn, formatNumber } from "./utils";

function formatInputValue(
  definition: CalculatorDefinition["inputs"][number],
  value: number,
) {
  const formatted = value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
  if (definition.unit === "$") return `$${formatted}`;
  return definition.unit ? `${formatted} ${definition.unit}` : formatted;
}

function SliderInput({
  definition,
  value,
  onChange,
}: {
  definition: CalculatorDefinition["inputs"][number];
  value: number;
  onChange: (value: number) => void;
}) {
  const progress = `${((value - definition.min) / (definition.max - definition.min)) * 100}%`;

  return (
    <label className="de-calculator-input flex min-w-0 flex-col gap-1">
      <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <span className="text-[13px] font-medium text-foreground">
          {definition.label}
        </span>
        <span className="de-calculator-input-value de-field inline-flex w-fit max-w-full whitespace-nowrap rounded-xl px-2.5 py-1 text-right font-mono text-[11px] font-medium tabular-nums">
          {formatInputValue(definition, value)}
        </span>
      </span>
      <input
        aria-label={definition.label}
        className="de-slider w-full touch-manipulation [--de-progress:var(--de-slider-progress)] focus-visible:outline-none"
        max={definition.max}
        min={definition.min}
        name={definition.key}
        onInput={(event) => onChange(Number(event.currentTarget.value))}
        step={definition.step}
        style={{ "--de-slider-progress": progress } as React.CSSProperties}
        type="range"
        value={value}
      />
      <span className="flex justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
        <span>{formatInputValue(definition, definition.min)}</span>
        <span>{formatInputValue(definition, definition.max)}</span>
      </span>
    </label>
  );
}

export function CalculatorArtifact({
  artifact,
  onClose,
  locale,
}: {
  artifact: CalculatorArtifactData;
  onClose?: () => void;
  locale?: string;
}) {
  const definition = getCalculator(artifact.calculatorId);
  const [values, setValues] = useState<Record<string, number>>(() =>
    definition
      ? normalizeCalculatorValues(definition, artifact.initialValues)
      : artifact.initialValues,
  );
  const emit = useArtifactAction(artifact);

  useEffect(() => {
    if (definition)
      setValues(normalizeCalculatorValues(definition, artifact.initialValues));
  }, [artifact.id, artifact.initialValues, definition]);

  const result = useMemo(
    () => definition?.calculate(values),
    [definition, values],
  );
  if (!definition || !result) {
    return (
      <Artifact>
        <ArtifactHeader>
          <ArtifactTitle>{artifact.title}</ArtifactTitle>
          <ArtifactActions>
            {onClose && (
              <ArtifactAction icon={XIcon} label="Close" onClick={onClose} />
            )}
          </ArtifactActions>
        </ArtifactHeader>
        <ArtifactContent>
          <div className="p-6 text-[13.5px] text-muted-foreground">
            This calculator is not registered in the trusted catalog.
          </div>
        </ArtifactContent>
      </Artifact>
    );
  }

  const update = (key: string, value: number) => {
    const next = normalizeCalculatorValues(definition, {
      ...values,
      [key]: value,
    });
    setValues(next);
    void emit("calculator-change", { values: next });
  };
  const copyFormula = async () => {
    await navigator.clipboard.writeText(
      `${result.formula}\n${result.substitutedFormula}`,
    );
    void emit("copy-formula", { values });
  };
  const numberOptions = {
    format: "currency" as const,
    currency: artifact.currency,
    locale: locale ?? artifact.locale,
  };

  return (
    <Artifact className="de-calculator-artifact">
      <ArtifactHeader>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <ArtifactTitle>{artifact.title}</ArtifactTitle>
            <ArtifactStatus icon={CalculatorIcon}>Interactive</ArtifactStatus>
          </div>
          <ArtifactDescription>{artifact.description}</ArtifactDescription>
        </div>
        <ArtifactActions>
          <ArtifactAction
            icon={CopyIcon}
            label="Copy formula"
            onClick={copyFormula}
          />
          {onClose && (
            <ArtifactAction icon={XIcon} label="Close" onClick={onClose} />
          )}
        </ArtifactActions>
      </ArtifactHeader>
      <ArtifactContent className="p-4">
        <div
          className="de-calculator-layout grid min-w-0 items-start gap-4"
          data-slot="calculator-layout"
        >
          <section
            aria-label="Calculator controls"
            className="de-calculator-controls flex min-w-0 flex-col gap-3"
            data-slot="calculator-controls"
          >
            <div
              className="de-calculator-formula de-field rounded-xl px-3.5 py-2.5"
              data-slot="calculator-formula"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="de-metadata font-medium">Formula</p>
                <span className="de-metadata">{definition.name}</span>
              </div>
              <p className="mt-1.5 overflow-x-auto font-mono text-[13.5px] font-semibold text-foreground">
                {result.formula}
              </p>
              <p className="mt-1 overflow-x-auto font-mono text-[11px] leading-5 text-muted-foreground">
                {result.substitutedFormula}
              </p>
            </div>
            <div className="grid gap-3">
              {definition.inputs.map((input) => (
                <SliderInput
                  definition={input}
                  key={input.key}
                  onChange={(value) => update(input.key, value)}
                  value={values[input.key] ?? input.defaultValue}
                />
              ))}
            </div>
          </section>
          <section
            aria-label="Projected value"
            className="de-calculator-output flex min-w-0 flex-col gap-3"
            data-slot="calculator-output"
          >
            <div
              className="de-calculator-chart de-field min-w-0 rounded-xl p-3"
              data-slot="calculator-chart"
            >
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <p className="de-metadata text-muted-foreground">
                  Projected value
                </p>
                <p className="de-metadata">
                  0-{Math.round(values.years ?? 0)} years
                </p>
              </div>
              <div className="de-calculator-chart-canvas">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={result.series}
                    margin={{ bottom: 4, left: -4, right: 10, top: 12 }}
                  >
                    <CartesianGrid
                      stroke="var(--border)"
                      strokeDasharray="2 5"
                      strokeOpacity={0.55}
                      vertical={false}
                    />
                    <XAxis
                      axisLine={false}
                      dataKey="x"
                      tick={{ fill: "var(--muted-foreground)" }}
                      tickLine={false}
                    />
                    <YAxis
                      axisLine={false}
                      tick={{ fill: "var(--muted-foreground)" }}
                      tickFormatter={(value) =>
                        new Intl.NumberFormat(locale ?? artifact.locale, {
                          notation: "compact",
                        }).format(Number(value))
                      }
                      tickLine={false}
                      width={48}
                    />
                    <Tooltip
                      formatter={(value) => [
                        formatNumber(Number(value), numberOptions),
                        "Value",
                      ]}
                    />
                    <Line
                      activeDot={{
                        fill: "var(--background)",
                        r: 4,
                        strokeWidth: 2,
                      }}
                      dataKey="value"
                      dot={false}
                      stroke="var(--primary)"
                      strokeWidth={2.25}
                      type="monotone"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div
              aria-live="polite"
              className="de-calculator-result de-field rounded-xl px-3.5 py-2.5"
              data-slot="calculator-result"
            >
              <p className="de-metadata font-medium">Future value</p>
              <p className="mt-1 text-2xl font-medium tabular-nums">
                {formatNumber(result.value, numberOptions)}
              </p>
            </div>
          </section>
        </div>
      </ArtifactContent>
    </Artifact>
  );
}
