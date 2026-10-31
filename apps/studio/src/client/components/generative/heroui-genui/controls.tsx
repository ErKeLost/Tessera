"use client";

import { Button, Input, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import {
  BuiltinActionType,
  defineComponent,
  parseStructuredRules,
  reactive,
  useFormName,
  useFormValidation,
  useIsStreaming,
  useStateField,
  useTriggerAction,
  type ActionPlan,
} from "@openuidev/react-lang";
import { useEffect, useMemo } from "react";
import { z } from "zod";
import { heroSchemas } from "./schemas";
const { Button: BaseButton, Input: BaseInput, Select: BaseSelect, TextArea: BaseTextArea, FormControl: BaseFormControl } = heroSchemas;
import type { ActionSchema } from "../shadcn-genui/action";
import type { rulesSchema } from "../shadcn-genui/rules";

/** Keep the stored language stable while mapping its semantic variants to HeroUI. */
export function buttonVariant(variant?: string) {
  switch (variant) {
    case "destructive": return "danger";
    case "secondary": return "secondary";
    case "outline": return "outline";
    case "ghost":
    case "link": return "ghost";
    default: return "primary";
  }
}

function isActionPlan(value: unknown): value is ActionPlan {
  return typeof value === "object" && value !== null && Array.isArray((value as ActionPlan).steps);
}

export const HeroButton = defineComponent({
  ...BaseButton,
  component: ({ props }) => {
    const trigger = useTriggerAction();
    const formName = useFormName();
    const validation = useFormValidation();
    const streaming = useIsStreaming();
    const action = props.action as ActionSchema | ActionPlan | undefined;
    const label = String(props.label ?? "");
    return (
      <Button
        isDisabled={streaming}
        aria-label={label}
        variant={buttonVariant(props.variant)}
        size={props.size === "lg" ? "lg" : props.size === "sm" || props.size === "xs" ? "sm" : "md"}
        onPress={() => {
          const conversation = isActionPlan(action)
            ? action.steps.some((step) => step.type === BuiltinActionType.ContinueConversation)
            : (action?.type ?? BuiltinActionType.ContinueConversation) === BuiltinActionType.ContinueConversation;
          // Validate every conversation submission, regardless of button styling.
          if (conversation && validation && !validation.validateForm()) return;
          if (isActionPlan(action)) return trigger(label, formName, action);
          trigger(label, formName, {
            type: action?.type ?? BuiltinActionType.ContinueConversation,
            params: action?.type === BuiltinActionType.OpenUrl
              ? { url: (action as { url: string }).url }
              : (action as { params?: Record<string, unknown> })?.params,
          });
        }}
      >{label}</Button>
    );
  },
});

/** Reactive fields share OpenUI's form store and validation, including @Set/@Reset. */
function useAnswerField(name: string, binding: unknown, structuredRules?: z.infer<typeof rulesSchema>) {
  const field = useStateField(name, binding);
  const formName = useFormName();
  const validation = useFormValidation();
  const streaming = useIsStreaming();
  const rules = useMemo(() => parseStructuredRules(structuredRules), [structuredRules]);
  useEffect(() => {
    if (streaming || !validation || rules.length === 0) return;
    validation.registerField(name, rules, () => field.value);
    return () => validation.unregisterField(name);
  }, [streaming, validation?.registerField, validation?.unregisterField, name, rules, field.value]);
  return {
    value: typeof field.value === "string" ? field.value : "",
    streaming,
    error: validation?.errors[name],
    change(value: string) {
      field.setValue(value);
    },
    blur() { if (validation && rules.length > 0) validation.validateField(name, field.value, rules); },
    formName,
  };
}

export const HeroInput = defineComponent({
  ...BaseInput,
  props: BaseInput.props.extend({ value: reactive(z.string().optional()) }),
  description: BaseInput.description + " Optional value binds to a $variable and updates on each keystroke.",
  component: ({ props }) => {
    const field = useAnswerField(props.name, props.value, props.rules);
    return (
      <TextField aria-label={props.name} name={props.name} isDisabled={field.streaming} isInvalid={Boolean(field.error)} value={field.value} onChange={field.change} type={props.type ?? "text"}>
        <Input className="w-full" placeholder={props.placeholder} onBlur={field.blur} />
      </TextField>
    );
  },
});

export const HeroTextArea = defineComponent({
  ...BaseTextArea,
  props: BaseTextArea.props.extend({ value: reactive(z.string().optional()) }),
  description: BaseTextArea.description + " Optional value binds to a $variable.",
  component: ({ props }) => {
    const field = useAnswerField(props.name, props.value, props.rules);
    return (
      <TextField aria-label={props.name} name={props.name} isDisabled={field.streaming} isInvalid={Boolean(field.error)} value={field.value} onChange={field.change}>
        <TextArea className="w-full" rows={props.rows ?? 3} placeholder={props.placeholder} onBlur={field.blur} />
      </TextField>
    );
  },
});

export const HeroSelect = defineComponent({
  ...BaseSelect,
  props: BaseSelect.props.extend({ value: reactive(z.string().optional()) }),
  description: BaseSelect.description + " Optional value binds to a $variable; dependent queries refresh automatically.",
  component: ({ props }) => {
    const field = useAnswerField(props.name, props.value, props.rules);
    const items = (props.items ?? []).filter((item) => item?.props?.value);
    return (
      <Select
        aria-label={props.name}
        name={props.name}
        placeholder={props.placeholder ?? "Select…"}
        isDisabled={field.streaming}
        isInvalid={Boolean(field.error)}
        value={field.value || null}
        onChange={(value) => { field.change(String(value ?? "")); }}
        onBlur={field.blur}
      >
        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover className="tessera-heroui">
          <ListBox>{items.map((item) => (
            <ListBox.Item key={item.props.value} id={item.props.value} textValue={item.props.label || item.props.value}>
              {item.props.label || item.props.value}<ListBox.ItemIndicator />
            </ListBox.Item>
          ))}</ListBox>
        </Select.Popover>
      </Select>
    );
  },
});

export const HeroFormControl = defineComponent({
  ...BaseFormControl,
  component: ({ props, renderNode }) => {
    const validation = useFormValidation();
    const field = props.field as { props?: { name?: string } } | undefined;
    const error = field?.props?.name ? validation?.errors[field.props.name] : undefined;
    return (
      <div className="space-y-2">
        <Label>{props.label}</Label>
        {renderNode(props.field)}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      </div>
    );
  },
});
