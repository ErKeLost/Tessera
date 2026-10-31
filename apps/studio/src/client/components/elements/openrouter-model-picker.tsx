"use client";

import {
  CheckIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { type CSSProperties, type WheelEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import { cn } from "../../lib/utils";
import { StudioIcon } from "../studio-icon";
import { Skeleton } from "../ui/skeleton";
import { StudioModelBrandIcon } from "./model-brand-icon";
import { EffortSlider } from "./effort-slider";

export { StudioModelBrandIcon };

export type ProviderModelPickerOption = Readonly<{
  id: string;
  name: string;
  family: string;
  contextWindow?: number;
  reasoning?: Readonly<{
    defaultEffort?: string;
    supportedEfforts: readonly string[];
  }>;
}>;

export type ProviderModelPickerEffort = Readonly<{
  value: string;
  options: readonly string[];
  disabled?: boolean;
  onValueChange(value: string): void;
}>;

export type ProviderModelPickerProps = Readonly<{
  models: readonly ProviderModelPickerOption[];
  value?: string;
  onValueChange(value: string): void;
  variant: "composer" | "field";
  ariaLabel?: string;
  busyValue?: string;
  disabled?: boolean;
  error?: string;
  id?: string;
  loading?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  effort?: ProviderModelPickerEffort;
}>;

const compactContextWindow = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" });

export function groupProviderModelOptions(models: readonly ProviderModelPickerOption[]) {
  const byFamily = new Map<string, ProviderModelPickerOption[]>();
  for (const model of models) {
    const group = byFamily.get(model.family) ?? [];
    group.push(model);
    byFamily.set(model.family, group);
  }
  return [...byFamily.entries()].map(([family, items]) => ({ family, items }));
}

export function formatProviderModelContextWindow(contextWindow: number): string {
  return `${compactContextWindow.format(contextWindow)} context`;
}

export function ProviderModelPicker({
  models,
  value,
  onValueChange,
  variant,
  ariaLabel = "Choose a text model",
  busyValue,
  disabled = false,
  error,
  id,
  loading = false,
  open: controlledOpen,
  onOpenChange,
  effort,
}: ProviderModelPickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pickerWidths, setPickerWidths] = useState<{ menu: number; trigger: number }>();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const selected = models.find((model) => model.id === value);
  const selectedLabel = selected?.name ?? value ?? "Select a model";
  const groups = useMemo(() => groupProviderModelOptions(models), [models]);

  useLayoutEffect(() => {
    if (variant !== "composer") return;
    let cancelled = false;
    const measure = () => {
      const probe = document.createElement("span");
      probe.className = "studio-model-picker-option-name studio-model-picker-measure";
      probe.style.position = "fixed";
      probe.style.left = "-10000px";
      probe.style.top = "-10000px";
      probe.style.display = "block";
      probe.style.width = "max-content";
      probe.style.maxWidth = "none";
      probe.style.overflow = "visible";
      probe.style.whiteSpace = "nowrap";
      probe.style.textOverflow = "clip";
      document.body.append(probe);
      const measureLabel = (label: string) => {
        probe.textContent = label;
        return probe.getBoundingClientRect().width;
      };
      const widestLabel = models.reduce((widest, model) => Math.max(
        widest,
        measureLabel(model.name),
        model.contextWindow ? measureLabel(formatProviderModelContextWindow(model.contextWindow)) : 0,
      ), measureLabel(selectedLabel));
      const nextWidths = {
        menu: Math.ceil(widestLabel + 92),
        trigger: Math.ceil(measureLabel(selectedLabel) + 52),
      };
      probe.remove();
      if (!cancelled) setPickerWidths((current) => (
        current?.menu === nextWidths.menu && current.trigger === nextWidths.trigger ? current : nextWidths
      ));
    };
    measure();
    void document.fonts?.ready.then(measure);
    return () => { cancelled = true; };
  }, [models, selectedLabel, variant]);

  const responsiveWidth = pickerWidths === undefined
    ? undefined
    : {
      "--studio-model-picker-width": `${pickerWidths.menu}px`,
      "--studio-model-picker-trigger-width": `${pickerWidths.trigger}px`,
    } as CSSProperties;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-busy={loading || undefined}
          aria-label={loading ? "Loading models" : ariaLabel}
          className={cn(
            variant === "composer"
              ? "studio-composer-setting studio-model-picker-trigger"
              : "studio-model-picker-field-trigger",
          )}
          disabled={disabled || loading}
          id={id}
          ref={triggerRef}
          style={responsiveWidth}
          type="button"
        >
          <span
            className={cn("studio-model-picker-current t-skel", !loading && "is-revealed")}
            title={loading ? undefined : selectedLabel}
          >
            <span aria-hidden="true" className="studio-model-picker-skeleton t-skel-skeleton">
              <Skeleton className="studio-model-picker-skeleton-icon" />
              <Skeleton className="studio-model-picker-skeleton-label" />
            </span>
            <span className="studio-model-picker-content t-skel-content">
              <StudioModelBrandIcon model={selected} size={variant === "composer" ? 16 : 18} />
              <span className="studio-model-picker-label">{selectedLabel}</span>
            </span>
          </span>
          <StudioIcon className="studio-model-picker-chevron" icon="solar:alt-arrow-down-linear" size={15} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("studio-model-picker-popover", `studio-model-picker-popover-${variant}`)}
        side={variant === "composer" ? "top" : "bottom"}
        sideOffset={6}
        style={responsiveWidth}
      >
        <Command filter={filterProviderModel}>
          <CommandInput autoFocus placeholder="Search text models..." />
          <CommandList className="studio-model-picker-list" onWheel={scrollModelList}>
            <CommandEmpty>
              {loading ? "Loading models..." : "No matching text models."}
            </CommandEmpty>
            {groups.map((group) => (
              <CommandGroup
                heading={<span className="studio-model-picker-group-heading"><span>{group.family}</span><span>{group.items.length}</span></span>}
                key={group.family}
              >
              {group.items.map((model) => {
                const busy = busyValue === model.id;
                return (
                  <CommandItem
                    className="studio-model-picker-option"
                    disabled={Boolean(busyValue)}
                    key={model.id}
                    keywords={[model.name, model.family]}
                    onSelect={() => {
                      onValueChange(model.id);
                      setOpen(false);
                    }}
                    value={model.id}
                  >
                    <span aria-hidden="true" className="studio-model-picker-option-icon">
                      <StudioModelBrandIcon model={model} size={19} />
                    </span>
                    <span className="studio-model-picker-option-copy">
                      <span className="studio-model-picker-option-name" title={model.name}>{model.name}</span>
                      {model.contextWindow ? <span className="studio-model-picker-option-context">{formatProviderModelContextWindow(model.contextWindow)}</span> : null}
                    </span>
                    {busy
                      ? <LoaderCircleIcon aria-label="Saving model" className="spin" size={15} />
                      : value === model.id ? <CheckIcon aria-hidden="true" size={15} /> : null}
                  </CommandItem>
                );
              })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        {variant === "composer" && effort && effort.options.length > 1 ? (
          <div className="studio-model-picker-effort">
            <EffortSlider
              key={`${value ?? "no-model"}/${effort.options.join(",")}`}
              levels={effort.options}
              value={effort.value}
              disabled={effort.disabled || disabled || loading}
              onChange={effort.onValueChange}
            />
          </div>
        ) : null}
        {error ? <p className="studio-model-picker-error" role="status">{error}</p> : null}
      </PopoverContent>
    </Popover>
  );
}

function filterProviderModel(value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLocaleLowerCase("en-US");
  if (!query) return 1;
  const haystack = [value, ...(keywords ?? [])].join(" ").toLocaleLowerCase("en-US");
  return haystack.includes(query) ? 1 : 0;
}

function scrollModelList(event: WheelEvent<HTMLDivElement>) {
  const list = event.currentTarget;
  const maximum = list.scrollHeight - list.clientHeight;
  if (maximum <= 0) return;
  const next = Math.max(0, Math.min(maximum, list.scrollTop + event.deltaY));
  if (next === list.scrollTop) return;
  list.scrollTop = next;
  event.preventDefault();
  event.stopPropagation();
}

