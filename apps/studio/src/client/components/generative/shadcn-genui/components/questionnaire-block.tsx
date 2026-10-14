"use client";

import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { z } from "zod";

/** The item name the answers are read back from. */
const ITEM_NAME = "answer";

const QuestionnaireBlockSchema = z.object({
  question: z.string(),
  choices: z.array(z.string()),
  description: z.string().optional(),
  multiple: z.boolean().optional(),
});

export const QuestionnaireBlock = defineComponent({
  name: "QuestionnaireBlock",
  props: QuestionnaireBlockSchema,
  description:
    'Clarifying question with a small set of choices, answered in place. Pressing Submit sends the chosen choice text back as the next user message. multiple: allow picking more than one choice. Use it when the request is genuinely ambiguous and a few choices cover the options — never for a question whose answer needs free text.',
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const isStreaming = useIsStreaming();
    const choices = props.choices ?? [];

    return (
      <Questionnaire
        className="rounded-(--radius-card) border p-5"
        defaultItem={ITEM_NAME}
        items={[
          {
            choices: choices.map((value) => ({ value })),
            name: ITEM_NAME,
            required: true,
          },
        ]}
        shortcuts="letters"
        onSubmit={(event) => {
          event.preventDefault();
          const picked = new FormData(event.currentTarget).getAll(ITEM_NAME).map(String);
          if (picked.length > 0) void triggerAction(picked.join(", "));
        }}
      >
        <QuestionnaireItem name={ITEM_NAME} required multiple={props.multiple}>
          <QuestionnaireTitle>{props.question}</QuestionnaireTitle>
          {props.description && (
            <QuestionnaireDescription>{props.description}</QuestionnaireDescription>
          )}
          <QuestionnaireChoices>
            {choices.map((choice) => (
              <QuestionnaireChoice key={choice} value={choice}>
                {choice}
              </QuestionnaireChoice>
            ))}
          </QuestionnaireChoices>
          <QuestionnaireError />
        </QuestionnaireItem>
        <QuestionnaireActions>
          <QuestionnaireSubmit disabled={isStreaming}>Submit</QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    );
  },
});
