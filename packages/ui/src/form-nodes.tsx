"use client";

import { CheckIcon } from "lucide-react";
import { useId, type ChangeEvent, type FormEvent } from "react";
import {
  defineArtifactNodeEventPayloadValidators,
  type ArtifactNodeRendererProps,
} from "./node-types";
import { control, ghostButton, typography } from "./tokens";
import { cn } from "./utils";

export function FormRootNode({ nodeId, value, slots, canTrigger, trigger }: ArtifactNodeRendererProps) {
  const title = stringValue(value.title);
  const description = stringValue(value.description);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canTrigger("submit")) void trigger("submit", {});
  };
  const reset = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canTrigger("reset")) void trigger("reset", {});
  };

  return (
    <form className="min-w-0 space-y-4" data-artifact-node-id={nodeId} data-node-type="form.root" onReset={reset} onSubmit={submit} tabIndex={-1}>
      {(title || description) && (
        <header className="min-w-0">
          {title && <h3 className={cn(typography.title, "text-foreground")}>{title}</h3>}
          {description && <p className={cn(typography.body, "mt-1 max-w-[68ch] text-muted-foreground")}>{description}</p>}
        </header>
      )}
      <div className="min-w-0 space-y-4">{slots.fields ?? null}</div>
    </form>
  );
}

export function FormInputNode({ nodeId, value, canTrigger, trigger }: ArtifactNodeRendererProps) {
  const inputId = useId();
  const descriptionId = `${inputId}-description`;
  const inputType = inputTypeValue(value.inputType);
  const current = typeof value.value === "number" || typeof value.value === "string" ? value.value : "";
  const disabled = value.disabled === true || !canTrigger("change");
  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.currentTarget.value;
    const next = inputType === "number" && raw !== "" ? event.currentTarget.valueAsNumber : raw;
    if (typeof next === "number" && !Number.isFinite(next)) return;
    void trigger("change", { value: next });
  };

  return (
    <div className="min-w-0" data-node-type="form.input">
      <label className={cn(typography.label, "mb-1.5 block text-foreground")} htmlFor={inputId}>
        {stringValue(value.label) ?? "Value"}
      </label>
      <input
        aria-describedby={stringValue(value.description) ? descriptionId : undefined}
        aria-required={value.required === true}
        className={cn(control.input, "h-9 w-full min-w-0 px-3 placeholder:text-muted-foreground")}
        data-artifact-node-id={nodeId}
        disabled={disabled}
        id={inputId}
        onChange={change}
        placeholder={stringValue(value.placeholder)}
        required={value.required === true}
        type={inputType}
        value={current}
      />
      {stringValue(value.description) && (
        <p className={cn(typography.body, "mt-1.5 text-muted-foreground")} id={descriptionId}>{stringValue(value.description)}</p>
      )}
    </div>
  );
}

type SelectOption = { value: string; label: string; disabled?: boolean };

export function FormSelectNode({ nodeId, value, canTrigger, trigger }: ArtifactNodeRendererProps) {
  const selectId = useId();
  const descriptionId = `${selectId}-description`;
  const options = selectOptions(value.options);
  const current = stringValue(value.value) ?? "";
  const placeholder = stringValue(value.placeholder);
  const disabled = value.disabled === true || !canTrigger("change");

  return (
    <div className="min-w-0" data-node-type="form.select">
      <label className={cn(typography.label, "mb-1.5 block text-foreground")} htmlFor={selectId}>
        {stringValue(value.label) ?? "Option"}
      </label>
      <select
        aria-describedby={stringValue(value.description) ? descriptionId : undefined}
        aria-required={value.required === true}
        className={cn(control.select, "h-9 w-full min-w-0 px-3")}
        data-artifact-node-id={nodeId}
        disabled={disabled}
        id={selectId}
        onChange={(event) => void trigger("change", { value: event.currentTarget.value })}
        required={value.required === true}
        value={current}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option disabled={option.disabled} key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {stringValue(value.description) && (
        <p className={cn(typography.body, "mt-1.5 text-muted-foreground")} id={descriptionId}>{stringValue(value.description)}</p>
      )}
    </div>
  );
}

export function FormToggleNode({ nodeId, value, canTrigger, trigger }: ArtifactNodeRendererProps) {
  const toggleId = useId();
  const descriptionId = `${toggleId}-description`;
  const checked = value.checked === true;
  const disabled = value.disabled === true || !canTrigger("change");

  return (
    <div className="flex min-w-0 items-start gap-3" data-node-type="form.toggle">
      <button
        aria-checked={checked}
        aria-describedby={stringValue(value.description) ? descriptionId : undefined}
        className={cn(
          control.toggle,
          "mt-0.5 flex size-5 shrink-0 items-center justify-center",
          checked ? "bg-foreground text-background" : "text-transparent",
        )}
        data-artifact-node-id={nodeId}
        disabled={disabled}
        id={toggleId}
        onClick={() => void trigger("change", { checked: !checked })}
        role="checkbox"
        type="button"
      >
        <CheckIcon aria-hidden="true" className="size-3.5" />
      </button>
      <div className="min-w-0">
        <label className={cn(typography.label, "block cursor-pointer text-foreground")} htmlFor={toggleId}>
          {stringValue(value.label) ?? "Enabled"}
        </label>
        {stringValue(value.description) && (
          <p className={cn(typography.body, "mt-0.5 text-muted-foreground")} id={descriptionId}>{stringValue(value.description)}</p>
        )}
      </div>
    </div>
  );
}

const buttonClasses = {
  default: "de-button-primary",
  secondary: ghostButton,
  destructive: "de-button-danger",
} as const;

export function FormButtonNode({ nodeId, value, canTrigger, trigger }: ArtifactNodeRendererProps) {
  const variant = enumValue(value.variant, buttonClasses, "default");
  const type = value.type === "submit" || value.type === "reset" ? value.type : "button";
  const hasPress = canTrigger("press");
  return (
    <button
      className={cn(
        control.button,
        "inline-flex h-9 max-w-full items-center justify-center px-3.5",
        buttonClasses[variant],
      )}
      data-artifact-node-id={nodeId}
      data-node-type="form.button"
      disabled={value.disabled === true || (type === "button" && !hasPress)}
      onClick={() => {
        if (hasPress) void trigger("press", {});
      }}
      type={type}
    >
      <span className="truncate">{stringValue(value.label) ?? "Continue"}</span>
    </button>
  );
}

export const officialFormNodeRenderers = Object.freeze({
  "form.root": FormRootNode,
  "form.input": FormInputNode,
  "form.select": FormSelectNode,
  "form.toggle": FormToggleNode,
  "form.button": FormButtonNode,
});

export const officialFormNodeEventPayloadValidators = defineArtifactNodeEventPayloadValidators({
  "form.root": {
    submit: emptyPayload,
    reset: emptyPayload,
  },
  "form.input": {
    change: (payload) => exactPayload(payload, "value", (value) => typeof value === "string" || typeof value === "number"),
  },
  "form.select": {
    change: (payload) => exactPayload(payload, "value", (value) => typeof value === "string"),
  },
  "form.toggle": {
    change: (payload) => exactPayload(payload, "checked", (value) => typeof value === "boolean"),
  },
  "form.button": {
    press: emptyPayload,
  },
});

function emptyPayload(payload: unknown) {
  return isRecord(payload) && Object.keys(payload).length === 0
    ? { success: true as const }
    : { success: false as const, message: "This event requires an empty object payload." };
}

function exactPayload(
  payload: unknown,
  key: string,
  accepts: (value: unknown) => boolean,
) {
  return isRecord(payload) && Object.keys(payload).length === 1 && accepts(payload[key])
    ? { success: true as const }
    : { success: false as const, message: `This event requires exactly one valid ${key} field.` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function inputTypeValue(value: unknown): "text" | "email" | "number" | "date" {
  return value === "email" || value === "number" || value === "date" ? value : "text";
}

function selectOptions(value: unknown): SelectOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) return [];
    const record = option as Record<string, unknown>;
    return typeof record.value === "string" && typeof record.label === "string"
      ? [{ value: record.value, label: record.label, ...(record.disabled === true ? { disabled: true } : {}) }]
      : [];
  });
}

function enumValue<TValues extends Readonly<Record<string, unknown>>>(
  value: unknown,
  values: TValues,
  fallback: Extract<keyof TValues, string>,
): Extract<keyof TValues, string> {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(values, value)
    ? value as Extract<keyof TValues, string>
    : fallback;
}
