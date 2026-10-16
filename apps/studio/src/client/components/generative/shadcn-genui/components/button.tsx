"use client";

import { Button as ShadcnButton } from "@/components/ui/button";
import {
  BuiltinActionType,
  defineComponent,
  useFormName,
  useFormValidation,
  useIsStreaming,
  useTriggerAction,
  type ActionPlan,
} from "@openuidev/react-lang";
import { z } from "zod";
import { actionSchema, type ActionSchema } from "../action";

const ButtonSchema = z.object({
  label: z.string(),
  action: actionSchema,
  variant: z.enum(["default", "destructive", "outline", "secondary", "ghost", "link"]).optional(),
  size: z.enum(["default", "xs", "sm", "lg", "icon"]).optional(),
});

/**
 * OpenUI 1.0 evaluates a step expression (`@ToAssistant("...")`, `Action([...])`)
 * to a plan under `steps` before the prop reaches the component, while a legacy
 * `{ type, params }` object arrives as-is. Both are handed back to
 * `useTriggerAction`, which runs `@Set`/`@Reset` locally and forwards the rest
 * as an action event.
 */
function isActionPlan(value: unknown): value is ActionPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { steps?: unknown }).steps)
  );
}

/** A button that sends a message must validate its form first, same as before. */
function continuesConversation(action: ActionSchema | ActionPlan | undefined): boolean {
  if (isActionPlan(action)) {
    return action.steps.some((step) => step.type === "continue_conversation");
  }
  return (
    (action?.type ?? BuiltinActionType.ContinueConversation) ===
    BuiltinActionType.ContinueConversation
  );
}

export const Button = defineComponent({
  name: "Button",
  props: ButtonSchema,
  description:
    'Clickable button. variant: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link". size: "default" | "xs" | "sm" | "lg" | "icon". action: one @step from the Action section, e.g. @ToAssistant("...").',
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const formName = useFormName();
    const formValidation = useFormValidation();
    const isStreaming = useIsStreaming();

    const label = String(props.label ?? "");
    const action = props.action as ActionSchema | ActionPlan | undefined;
    const variant = props.variant ?? "default";
    const size = props.size ?? "default";

    return (
      <ShadcnButton
        variant={variant}
        size={size}
        disabled={isStreaming}
        onClick={() => {
          if (formValidation && variant === "default" && continuesConversation(action)) {
            const valid = formValidation.validateForm();
            if (!valid) return;
          }
          if (isActionPlan(action)) {
            triggerAction(label, formName, action);
            return;
          }
          const actionType = action?.type ?? BuiltinActionType.ContinueConversation;
          const actionParams =
            action?.type === BuiltinActionType.OpenUrl
              ? { url: (action as { url: string }).url }
              : (action as { params?: Record<string, unknown> })?.params;
          triggerAction(label, formName, { type: actionType, params: actionParams });
        }}
      >
        {label}
      </ShadcnButton>
    );
  },
});
