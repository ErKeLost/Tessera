"use client";

import { Kbd as ShadcnKbd, KbdGroup } from "@/components/ui/kbd";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const KbdSchema = z.object({
  keys: z.array(z.string()),
});

export const Kbd = defineComponent({
  name: "Kbd",
  props: KbdSchema,
  description:
    'Keyboard shortcut hint, e.g. Kbd(["⌘", "K"]). Each entry renders as its own key cap.',
  component: ({ props }) => {
    const keys = props.keys ?? [];
    if (keys.length === 0) return null;

    return (
      <KbdGroup>
        {keys.map((key, index) => (
          <ShadcnKbd key={`${key}-${index}`}>{key}</ShadcnKbd>
        ))}
      </KbdGroup>
    );
  },
});
