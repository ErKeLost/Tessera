"use client";

import type {
  ControlFilterProps,
  ControlGroupProps,
} from "@open-generative/components";
import type { RendererInput } from "@open-generative/react";
import {
  Check,
  RotateCcw,
} from "lucide-react";
import {
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { canEmit, emitEvent, officialRendererEventPorts } from "./events";
import { Button, IconButton, Input, Select, classes } from "./primitives";

type FilterValue = ControlFilterProps["value"];

export function ControlFilterRenderer(input: RendererInput<ControlFilterProps>) {
  const { resolvedProps } = input;
  const canApply = canEmit(input, officialRendererEventPorts.apply);
  const canChange = canEmit(input, officialRendererEventPorts.change);
  const canReset = canEmit(input, officialRendererEventPorts.reset);
  const fieldId = useId();
  const [draft, setDraft] = useState<FilterValue>(resolvedProps.value);

  useEffect(() => {
    setDraft(resolvedProps.value);
  }, [resolvedProps.value]);

  const change = (value: FilterValue) => {
    setDraft(value);
    emitEvent(input, officialRendererEventPorts.change, {
      filterId: resolvedProps.filterId,
      value,
    });
  };
  const applyOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      if (canApply) emitEvent(input, officialRendererEventPorts.apply, {});
    }
  };

  return (
    <div className="og-ui og-filter" data-filter-kind={resolvedProps.kind} data-og-component="control.filter">
      <div className="og-field-heading">
        <label htmlFor={fieldId}>{resolvedProps.label}</label>
        <span className="og-operator">{operatorLabel(resolvedProps.operator)}</span>
      </div>
      <div className="og-filter-control">
        {renderFilterControl({
          draft,
          enabled: canChange,
          fieldId,
          input,
          onChange: change,
          onKeyDown: applyOnEnter,
        })}
        {canReset && !isEmptyValue(draft) ? (
          <IconButton
            icon={RotateCcw}
            label={`Reset ${resolvedProps.label}`}
            onClick={() => {
              setDraft(null);
              emitEvent(input, officialRendererEventPorts.reset, {});
            }}
            size="sm"
            variant="ghost"
          />
        ) : null}
      </div>
    </div>
  );
}

type FilterControlInput = Readonly<{
  draft: FilterValue;
  enabled: boolean;
  fieldId: string;
  input: RendererInput<ControlFilterProps>;
  onChange: (value: FilterValue) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}>;

function renderFilterControl({
  draft,
  enabled,
  fieldId,
  input,
  onChange,
  onKeyDown,
}: FilterControlInput) {
  const props = input.resolvedProps;
  if (props.kind === "select") {
    const selected = props.options?.findIndex((option) => Object.is(option.value, draft)) ?? -1;
    return (
      <Select
        aria-required={props.required}
        disabled={!enabled}
        id={fieldId}
        onChange={(event) => {
          const index = Number(event.currentTarget.value);
          const option = props.options?.[index];
          if (option !== undefined) onChange(option.value);
        }}
        required={props.required}
        value={selected < 0 ? "" : String(selected)}
      >
        <option disabled={props.required} value="">Select...</option>
        {props.options?.map((option, index) => (
          <option disabled={option.disabled} key={`${index}:${option.label}`} value={index}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }
  if (props.kind === "multi-select") {
    const values = Array.isArray(draft) ? draft : [];
    const selected = props.options
      ?.flatMap((option, index) => values.some((value) => Object.is(value, option.value)) ? [String(index)] : [])
      ?? [];
    return (
      <Select
        aria-describedby={`${fieldId}-hint`}
        aria-required={props.required}
        disabled={!enabled}
        id={fieldId}
        multiple
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          const next = Array.from(event.currentTarget.selectedOptions).flatMap((option) => {
            const value = props.options?.[Number(option.value)]?.value;
            return value === undefined ? [] : [value];
          });
          onChange(next);
        }}
        required={props.required}
        value={selected}
      >
        {props.options?.map((option, index) => (
          <option disabled={option.disabled} key={`${index}:${option.label}`} value={index}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }
  if (props.kind === "date-range") {
    const range = isDateRange(draft) ? draft : { start: "", end: "" };
    return (
      <div className="og-date-range" id={fieldId}>
        <Input
          aria-label={`${props.label} start`}
          disabled={!enabled}
          onChange={(event) => onChange({ ...range, start: event.currentTarget.value })}
          required={props.required}
          type="date"
          value={range.start}
        />
        <span aria-hidden="true">to</span>
        <Input
          aria-label={`${props.label} end`}
          disabled={!enabled}
          onChange={(event) => onChange({ ...range, end: event.currentTarget.value })}
          required={props.required}
          type="date"
          value={range.end}
        />
      </div>
    );
  }
  const scalar = typeof draft === "string" || typeof draft === "number" ? draft : "";
  return (
    <Input
      aria-required={props.required}
      disabled={!enabled}
      id={fieldId}
      onChange={(event) => {
        if (props.kind === "number") {
          onChange(event.currentTarget.value === "" ? null : event.currentTarget.valueAsNumber);
        } else {
          onChange(event.currentTarget.value);
        }
      }}
      onKeyDown={onKeyDown}
      required={props.required}
      type={props.kind === "number" ? "number" : props.kind === "date" ? "date" : "text"}
      value={scalar}
    />
  );
}

export function ControlGroupRenderer(input: RendererInput<ControlGroupProps>) {
  const { resolvedProps, slots } = input;
  const canApply = canEmit(input, officialRendererEventPorts.apply);
  const canReset = canEmit(input, officialRendererEventPorts.reset);
  const enabled = canApply || canReset;
  return (
    <fieldset
      className={classes("og-ui og-control-group", `og-control-group-${resolvedProps.orientation}`)}
      data-og-component="control.group"
      disabled={!enabled}
    >
      {resolvedProps.label ? <legend>{resolvedProps.label}</legend> : null}
      <div className="og-control-list">{slots.controls}</div>
      {enabled ? (
        <div className="og-control-actions">
          {canReset ? (
            <IconButton
              icon={RotateCcw}
              label="Reset filters"
              onClick={() => emitEvent(input, officialRendererEventPorts.reset, {})}
              variant="ghost"
            />
          ) : null}
          {resolvedProps.submitMode === "explicit" && canApply ? (
            <Button onClick={() => emitEvent(input, officialRendererEventPorts.apply, {})}>
              <Check aria-hidden="true" size={15} />
              Apply
            </Button>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

function isDateRange(value: FilterValue): value is { start: string; end: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "start" in value && "end" in value;
}

function isEmptyValue(value: FilterValue): boolean {
  if (value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isDateRange(value)) return value.start === "" && value.end === "";
  return false;
}

function operatorLabel(operator: ControlFilterProps["operator"]): string {
  return ({
    equals: "is",
    "not-equals": "is not",
    contains: "contains",
    in: "in",
    "greater-than": "greater than",
    "less-than": "less than",
    between: "between",
  } as const)[operator];
}
