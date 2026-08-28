"use client";

import { createShadcnRadixPorts } from "@open-generative/adapter-shadcn";
import {
  openGenerativeShadcnBindings,
  resolveOpenGenerativeIcon,
} from "./bindings";

export const openGenerativeShadcnPorts = createShadcnRadixPorts({
  components: openGenerativeShadcnBindings,
  resolveIcon: resolveOpenGenerativeIcon,
  // Studio's checked-in component source is the Radix New York family.
  style: "new-york",
});
