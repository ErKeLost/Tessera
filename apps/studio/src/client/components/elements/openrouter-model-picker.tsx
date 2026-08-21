"use client";

import {
  Alibaba,
  Anthropic,
  Baichuan,
  Bedrock,
  Cohere,
  DeepSeek,
  Gemini,
  Grok,
  InternLM,
  Kimi,
  Meta,
  Microsoft,
  Minimax,
  Mistral,
  NousResearch,
  Nvidia,
  OpenAI,
  Perplexity,
  Qwen,
  Stepfun,
  Tencent,
  Yi,
  ZAI,
} from "@lobehub/icons";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { type WheelEvent, useState } from "react";
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

export type OpenRouterModelPickerOption = Readonly<{
  id: string;
  name: string;
  family: string;
}>;

export type OpenRouterModelPickerProps = Readonly<{
  models: readonly OpenRouterModelPickerOption[];
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
}>;

export function OpenRouterModelPicker({
  models,
  value,
  onValueChange,
  variant,
  ariaLabel = "Choose an OpenRouter text model",
  busyValue,
  disabled = false,
  error,
  id,
  loading = false,
  open: controlledOpen,
  onOpenChange,
}: OpenRouterModelPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const selected = models.find((model) => model.id === value);
  const selectedLabel = selected?.name ?? value ?? "Select a model";

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={ariaLabel}
          className={cn(
            variant === "composer"
              ? "studio-composer-setting studio-model-picker-trigger"
              : "studio-model-picker-field-trigger",
          )}
          disabled={disabled}
          id={id}
          type="button"
        >
          <span className="studio-model-picker-current" title={selectedLabel}>
            <StudioModelBrandIcon model={selected} size={variant === "composer" ? 16 : 18} />
            <span className="studio-model-picker-label">{selectedLabel}</span>
            {loading ? <LoaderCircleIcon aria-label="Loading models" className="spin" size={13} /> : null}
          </span>
          <ChevronDownIcon aria-hidden="true" className="studio-model-picker-chevron" size={15} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="studio-model-picker-popover"
        side={variant === "composer" ? "top" : "bottom"}
        sideOffset={6}
      >
        <Command filter={filterOpenRouterModel}>
          <CommandInput autoFocus placeholder="Search text models..." />
          <CommandList className="studio-model-picker-list" onWheel={scrollModelList}>
            <CommandEmpty>
              {loading ? "Loading OpenRouter models..." : "No matching text models."}
            </CommandEmpty>
            <CommandGroup>
              {models.map((model) => {
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
                    <span className="studio-model-picker-option-name" title={model.name}>{model.name}</span>
                    {busy
                      ? <LoaderCircleIcon aria-label="Saving model" className="spin" size={15} />
                      : value === model.id ? <CheckIcon aria-hidden="true" size={15} /> : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        {error ? <p className="studio-model-picker-error" role="status">{error}</p> : null}
      </PopoverContent>
    </Popover>
  );
}

function filterOpenRouterModel(value: string, search: string, keywords?: string[]): number {
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

export function StudioModelBrandIcon({
  model,
  size,
}: {
  model?: OpenRouterModelPickerOption;
  size: number;
}) {
  const provider = model?.id.split("/", 1)[0]?.replace(/^~/u, "").toLocaleLowerCase("en-US") ?? "";
  if (provider === "openai") return <OpenAI size={size} />;
  if (provider === "anthropic") return <Anthropic size={size} />;
  if (provider === "google") return <Gemini.Color size={size} />;
  if (provider === "meta-llama" || provider === "meta") return <Meta.Color size={size} />;
  if (provider === "mistralai" || provider === "mistral") return <Mistral.Color size={size} />;
  if (provider === "deepseek") return <DeepSeek.Color size={size} />;
  if (provider === "qwen") return <Qwen.Color size={size} />;
  if (provider === "moonshotai") return <Kimi.Color size={size} />;
  if (provider === "x-ai") return <Grok size={size} />;
  if (provider === "z-ai") return <ZAI size={size} />;
  if (provider === "cohere") return <Cohere.Color size={size} />;
  if (provider === "nvidia") return <Nvidia.Color size={size} />;
  if (provider === "perplexity") return <Perplexity.Color size={size} />;
  if (provider === "microsoft") return <Microsoft.Color size={size} />;
  if (provider === "amazon" || provider === "amazon-bedrock") return <Bedrock.Color size={size} />;
  if (provider === "minimax") return <Minimax.Color size={size} />;
  if (provider === "01-ai") return <Yi.Color size={size} />;
  if (provider === "baichuan") return <Baichuan.Color size={size} />;
  if (provider === "stepfun") return <Stepfun size={size} />;
  if (provider === "internlm") return <InternLM.Color size={size} />;
  if (provider === "nousresearch") return <NousResearch size={size} />;
  if (provider === "alibaba") return <Alibaba.Color size={size} />;
  if (provider === "tencent") return <Tencent.Color size={size} />;
  return <BotIcon size={size} strokeWidth={1.8} />;
}
