"use client";

import type { ComponentGroup } from "@openuidev/react-lang";

// Feedback / form-detail / small widgets
export { SkeletonBlock } from "../components/skeleton-block";
export { SpinnerBlock } from "../components/spinner-block";
export { ToggleBlock, ToggleGroupBlock } from "../components/toggle-block";
export { OtpInput } from "../components/otp-input";
export { Kbd } from "../components/kbd";
export { EmptyBlock } from "../components/empty-block";
export { ItemBlock } from "../components/item-block";
export { InputGroup } from "../components/input-group";
export { ButtonGroupBlock } from "../components/button-group-block";
export { ToastBlock } from "../components/toast-block";

// Mount <Toaster /> once at the application root so ToastBlock notifications appear.
export { Toaster } from "@/components/ui/sonner";

import { ButtonGroupBlock } from "../components/button-group-block";
import { EmptyBlock } from "../components/empty-block";
import { InputGroup } from "../components/input-group";
import { ItemBlock } from "../components/item-block";
import { Kbd } from "../components/kbd";
import { OtpInput } from "../components/otp-input";
import { SkeletonBlock } from "../components/skeleton-block";
import { SpinnerBlock } from "../components/spinner-block";
import { ToastBlock } from "../components/toast-block";
import { ToggleBlock, ToggleGroupBlock } from "../components/toggle-block";

/** Every component defined by this group, ready to spread into `createLibrary`. */
export const feedbackComponents = [
  SkeletonBlock,
  SpinnerBlock,
  ToggleBlock,
  ToggleGroupBlock,
  OtpInput,
  Kbd,
  EmptyBlock,
  ItemBlock,
  InputGroup,
  ButtonGroupBlock,
  ToastBlock,
] as const;

export const feedbackComponentGroup: ComponentGroup = {
  name: "Feedback & Input Details",
  components: [
    "SkeletonBlock",
    "SpinnerBlock",
    "ToggleBlock",
    "ToggleGroupBlock",
    "OtpInput",
    "Kbd",
    "EmptyBlock",
    "ItemBlock",
    "InputGroup",
    "ButtonGroupBlock",
    "ToastBlock",
  ],
  notes: [
    "- SkeletonBlock and SpinnerBlock stand in for loading content — use them instead of writing loading text.",
    "- ToggleBlock stays pressed/unpressed; ToggleGroupBlock is for one-of-many choices.",
    "- OtpInput is a passcode field with separate character slots.",
    "- Kbd renders keyboard shortcut key caps, e.g. Kbd([\"⌘\", \"K\"]).",
    "- EmptyBlock renders an empty state with an icon, title and optional description.",
    "- ItemBlock is a card-like list row with a title, optional description and optional right-aligned meta text.",
    "- InputGroup is a single input with optional inline prefix/suffix text (currency, unit).",
    "- ButtonGroupBlock renders attached buttons; clicking one sends its label to the assistant.",
    "- ToastBlock renders a button that raises a toast notification when pressed. It only fires when the user clicks it.",
  ],
};

export const feedbackExamples: string[] = [
  `Example — Loading, empty state and a toast trigger:
root = Card([header, loading, emptyState, toastBtn])
header = CardHeader("Reports", "Preparing your data")
loading = SkeletonBlock(3)
emptyState = EmptyBlock("No reports yet", "Once a report finishes generating it will appear here.")
toastBtn = ToastBlock("Report queued", "We will notify you when it is ready.", "Notify me", "success")`,

  `Example — Input details:
root = Card([header, budget, code, shortcut, choices])
header = CardHeader("Payment Settings", "Configure billing details")
budget = InputGroup("Monthly budget", "$", "USD", "0.00")
code = OtpInput("Verification code", 6)
shortcut = Kbd(["⌘", "K"])
choices = ToggleGroupBlock(["Monthly", "Quarterly", "Yearly"], "outline", "default")`,

  `Example — List rows with actions:
root = Card([header, item, actions])
header = CardHeader("Team members", "3 active seats")
item = ItemBlock("Ada Lovelace", "Owner · ada@example.com", "Active")
actions = ButtonGroupBlock(["Invite member", "Manage billing"], "row")`,
];

export const feedbackRules: string[] = [
  "Use SkeletonBlock or SpinnerBlock to represent loading states instead of describing them in prose.",
  "Use EmptyBlock when a section has no data to show.",
  "Use ItemBlock for compact list rows; put the trailing value in the meta prop.",
  "Use InputGroup when a single input needs inline prefix/suffix text; use Form with FormControl for full forms.",
  "Use ToggleBlock for a single on/off control and ToggleGroupBlock for choosing one option from a small set.",
  "Use OtpInput for passcodes and Kbd for keyboard shortcuts.",
  "ToastBlock renders a trigger button and raises a notification only when the user clicks it — never describe it as automatic.",
  "ButtonGroupBlock buttons send their own label as the next user message, so each label must read as a complete request.",
];
