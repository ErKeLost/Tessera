/**
 * Shared visual recipes for Data Elements.
 *
 * The vocabulary intentionally follows assistant-ui's shadcn/ui primitives:
 * paper, floating, field, fieldInteractive, ghostButton, and mono. The CSS
 * classes resolve through `styles.css`. The library owns the assistant-ui
 * baseline tokens, so an artifact has the same visual system in every host.
 */

export const paper = "de-paper";
export const floating = "de-floating";
export const field = "de-field";
export const fieldInteractive = "de-field-interactive";
export const ghostButton = "de-ghost-button";
export const mono = "de-metadata";

export const typography = {
  title: "de-title",
  heading: "de-heading",
  body: "de-body",
  label: "de-label",
  caption: "de-caption",
  metadata: "de-metadata",
} as const;

export const control = {
  focus: "de-focus",
  input: "de-input",
  select: "de-select",
  button: "de-button",
  iconButton: "de-icon-button",
  toggle: "de-toggle",
} as const;

export const shape = {
  inner: "de-shape-inner",
  control: "de-shape-control",
  field: "de-shape-field",
  callout: "de-shape-callout",
  panel: "de-shape-panel",
  indicator: "de-shape-indicator",
  full: "de-shape-full",
} as const;

export const layout = {
  divider: "de-divider",
  row: "de-row",
  tableRow: "de-table-row",
  contentInset: "de-content-inset",
  compactInset: "de-compact-inset",
} as const;
