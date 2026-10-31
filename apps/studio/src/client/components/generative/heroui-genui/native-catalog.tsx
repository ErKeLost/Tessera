"use client";

import * as Hero from "@heroui/react";
import { parseDate, parseTime } from "@internationalized/date";
import { action, defineComponent, reactive, useFormName, useFormValidation, useIsStreaming, useStateField, useTriggerAction, type ActionPlan } from "@openuidev/react-lang";
import { Children, createElement, type ElementType, type ReactNode } from "react";
import { z } from "zod";

/** Official open-source component inventory, verified against HeroUI 3.2.6. */
export const HEROUI_COMPONENTS = [
  "Accordion", "Alert", "AlertDialog", "Autocomplete", "Avatar", "AvatarGroup", "Badge", "Breadcrumbs", "Button", "ButtonGroup", "Calendar", "Card", "Checkbox", "CheckboxGroup", "Chip", "CloseButton", "ColorArea", "ColorField", "ColorPicker", "ColorSlider", "ColorSwatch", "ColorSwatchPicker", "ComboBox", "DateField", "DatePicker", "DateRangePicker", "Description", "Disclosure", "DisclosureGroup", "Drawer", "Dropdown", "ErrorMessage", "FieldError", "Fieldset", "Form", "Input", "InputGroup", "InputOTP", "Kbd", "Label", "Link", "ListBox", "Meter", "Modal", "NumberField", "Pagination", "Popover", "ProgressBar", "ProgressCircle", "RadioGroup", "RangeCalendar", "ScrollShadow", "SearchField", "Select", "Separator", "Skeleton", "Slider", "Spinner", "Surface", "Switch", "Table", "Tabs", "TagGroup", "TextArea", "TextField", "TimeField", "Toast", "ToggleButton", "ToggleButtonGroup", "Toolbar", "Tooltip", "Typography",
] as const;

const exports = Hero as unknown as Record<string, unknown>;
function isComponent(value: unknown): boolean {
  return typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value);
}
const nativeComponents: Record<string, ElementType> = {};
for (const name of [...HEROUI_COMPONENTS, "Radio", "Tag", "Header"]) {
  const root = exports[name];
  if (!isComponent(root)) throw new Error(`HeroUI component ${name} is missing from the installed package.`);
  nativeComponents[name] = root as ElementType;
  for (const [part, component] of Object.entries(root as object)) {
    if (part !== "Root" && part !== "Queue" && part !== "toast" && isComponent(component)) nativeComponents[`${name}.${part}`] = component as ElementType;
  }
}
export const HEROUI_NATIVE_COMPONENT_NAMES = Object.keys(nativeComponents).sort();

/** Functions, HTML injection, custom renderers, and executable props cannot cross the DSL. */
export function safeHeroOptions(raw: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([key, value]) => {
    if (/^on/iu.test(key) || ["children", "render", "as", "style", "dangerouslySetInnerHTML", "ref", "__proto__", "constructor", "prototype", "formAction", "action"].includes(key)) return false;
    if (["href", "src"].includes(key)) return typeof value === "string" && /^(?:https?:\/\/|\/[^/]|#)/iu.test(value);
    return /^[a-z][a-zA-Z0-9-]*$/u.test(key);
  }));
}

function serializableValue(value: unknown): unknown {
  if (value instanceof Set) return Array.from(value);
  if (value !== null && typeof value === "object") {
    if ("start" in value && "end" in value) return { start: String(value.start), end: String(value.end) };
    if ("toDate" in value || "toHexString" in value) return String(value);
  }
  return value;
}

function calendarChildren(component: string): ReactNode | undefined {
  const calendar = component.startsWith("RangeCalendar") ? Hero.RangeCalendar : Hero.Calendar;
  if (component.endsWith(".GridHeader")) return ((day: string) => createElement(calendar.HeaderCell, null, day)) as unknown as ReactNode;
  if (component.endsWith(".GridBody")) return ((date: Parameters<typeof parseDate>[0]) => createElement(calendar.Cell, { date } as never)) as unknown as ReactNode;
  if (component.endsWith(".YearPickerGridBody")) return (({ year }: { year: number }) => createElement(calendar.YearPickerCell, { year })) as unknown as ReactNode;
  return undefined;
}

/**
 * Complete native composition escape hatch. Common analysis components have
 * compact signatures; this node exposes all 72 native components and their
 * actual compound parts without accepting JavaScript or arbitrary imports.
 */
export const HeroNative = defineComponent({
  name: "HeroUI",
  props: z.object({
    component: z.enum(HEROUI_NATIVE_COMPONENT_NAMES as [string, ...string[]]),
    children: z.array(z.any()).default([]),
    options: z.record(z.string(), z.json()).optional(),
    name: z.string().optional(),
    value: reactive(z.any().optional()),
    action: action().optional(),
  }),
  description: "Native HeroUI v3 component or compound part. children are text or HeroUI references; options are native JSON props (variant, size, aria-label, id, slot, etc.). For two-way state pass a unique name and $variable as value. action runs on press. Calendar grid/segment render functions are supplied by the host. Toast is a user-triggered notification button with options {title, description, variant}.",
  component: ({ props, renderNode }) => {
    const component = props.component;
    const type = nativeComponents[component];
    const options = safeHeroOptions(props.options);
    const field = useStateField(props.name ?? component, props.value);
    const streaming = useIsStreaming();
    const trigger = useTriggerAction();
    const formName = useFormName();
    const validation = useFormValidation();
    // Native compound parts may arrive independently. Mount their collection
    // only once the whole Tabs subtree is available. Compact Tabs supports
    // progressive display via inert in index.tsx.
    if (component === "Tabs" && streaming) return <div aria-busy="true" data-slot="native-tabs-pending" className="h-8 w-full rounded-md bg-muted/25" />;
    const isBound = props.name !== undefined || props.value !== undefined;
    const binding: Record<string, unknown> = {};
    if (isBound) {
      let value = field.value;
      try {
        if (["Calendar", "DateField", "DatePicker"].includes(component)) value = typeof value === "string" && value ? parseDate(value.slice(0, 10)) : null;
        if (["RangeCalendar", "DateRangePicker"].includes(component)) {
          const range = value as { start?: string; end?: string } | undefined;
          value = range?.start && range?.end ? { start: parseDate(range.start), end: parseDate(range.end) } : null;
        }
        if (component === "TimeField") value = typeof value === "string" && value ? parseTime(value) : null;
        if (["ColorArea", "ColorField", "ColorPicker", "ColorSlider", "ColorSwatchPicker"].includes(component)) value = typeof value === "string" && value ? Hero.parseColor(value) : undefined;
      } catch { value = null; }
      if (["Checkbox", "Switch", "ToggleButton"].includes(component)) {
        binding.isSelected = Boolean(value); binding.onChange = field.setValue;
      } else if (["ListBox", "TagGroup", "ToggleButtonGroup"].includes(component)) {
        binding.selectedKeys = new Set(Array.isArray(value) ? value : value == null ? [] : [value]);
        binding.onSelectionChange = (next: unknown) => field.setValue(serializableValue(next));
      } else if (component === "Tabs") {
        binding.selectedKey = value ?? null;
        binding.onSelectionChange = (key: unknown) => {
          if (!streaming && key !== value) field.setValue(key);
        };
      } else if (["Disclosure", "DisclosureGroup", "Accordion"].includes(component)) {
        if (component === "Disclosure") { binding.isExpanded = Boolean(value); binding.onExpandedChange = field.setValue; }
        else { binding.expandedKeys = new Set(Array.isArray(value) ? value : []); binding.onExpandedChange = (next: unknown) => field.setValue(serializableValue(next)); }
      } else {
        binding.value = value;
        binding.onChange = (next: unknown) => field.setValue(serializableValue(next));
      }
    }
    if (props.name !== undefined) binding.name = props.name;
    // Every actionable root is disabled until the model finishes emitting it.
    if (streaming && !component.includes(".") && component !== "Tabs") binding.isDisabled = true;
    if (/\.Popover$|^(?:Popover|Tooltip)\.Content$|\.(?:Backdrop|Dialog)$/u.test(component)) options.className = "tessera-heroui";
    if (component === "Form") binding.onSubmit = (event: { preventDefault(): void }) => event.preventDefault();
    if (component === "Link") { options.target = "_blank"; options.rel = "noopener noreferrer"; }

    const children = Children.toArray((props.children ?? []).map((child: unknown) =>
      typeof child === "string" || typeof child === "number" ? child : renderNode(child)));
    const segmentGroup = component === "TimeField.Input" ? Hero.TimeField : Hero.DateField;
    let content: unknown = children.length > 0 ? children : undefined;
    if (["DateField.Input", "TimeField.Input"].includes(component)) content = (segment: unknown) => createElement(segmentGroup.Segment, { segment } as never);
    if (/^(?:Calendar|RangeCalendar)\.(?:GridHeader|GridBody|YearPickerGridBody)$/u.test(component)) content = calendarChildren(component);
    if (component === "Toast") {
      return <Hero.Button isDisabled={streaming} onPress={() => Hero.toast(String(options.title ?? "Notification"), { description: typeof options.description === "string" ? options.description : undefined })}>{children.length ? children : "Show notification"}</Hero.Button>;
    }
    if (props.action) {
      binding.onPress = () => {
        if (streaming || (validation && !validation.validateForm())) return;
        trigger(typeof props.options?.["aria-label"] === "string" ? props.options["aria-label"] : component, formName, props.action as unknown as ActionPlan);
      };
    }
    const element = type ? createElement(type, { ...options, ...binding }, content as ReactNode) : null;
    // A selected-but-disabled React Aria tab fights the collection's focus
    // effects while its streamed children change. Block interaction via inert.
    return component === "Tabs" ? <div inert={streaming || undefined} aria-busy={streaming || undefined}>{element}</div> : element;
  },
});

export function HeroToastHost() { return <Hero.Toast.Provider className="tessera-heroui" />; }
