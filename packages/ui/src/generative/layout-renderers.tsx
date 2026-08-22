"use client";

import type {
  LayoutGridProps,
  LayoutSectionProps,
  LayoutStackProps,
} from "@open-generative/components";
import type { RendererInput } from "@open-generative/react";
import {
  createElement,
  type CSSProperties,
} from "react";
import { classes } from "./primitives";

const gapClass = {
  none: "og-gap-none",
  xs: "og-gap-xs",
  sm: "og-gap-sm",
  md: "og-gap-md",
  lg: "og-gap-lg",
} as const;

const alignClass = {
  stretch: "og-align-stretch",
  start: "og-align-start",
  center: "og-align-center",
  end: "og-align-end",
} as const;

export function LayoutStackRenderer({
  resolvedProps,
  slots,
}: RendererInput<LayoutStackProps>) {
  return (
    <div
      className={classes(
        "og-ui og-stack",
        gapClass[resolvedProps.gap],
        alignClass[resolvedProps.align],
        resolvedProps.density === "compact" ? "og-density-compact" : "og-density-comfortable",
      )}
      data-og-component="layout.stack"
    >
      {slots.children}
    </div>
  );
}

export function LayoutGridRenderer({
  resolvedProps,
  slots,
}: RendererInput<LayoutGridProps>) {
  const columns = resolvedProps.columns === "auto" ? "auto" : String(resolvedProps.columns);
  return (
    <div
      className={classes(
        "og-ui og-grid",
        gapClass[resolvedProps.gap],
        alignClass[resolvedProps.align],
      )}
      data-columns={columns}
      data-og-component="layout.grid"
      style={{ "--og-grid-columns": columns } as CSSProperties}
    >
      {slots.children}
    </div>
  );
}

export function LayoutSectionRenderer({
  resolvedProps,
  slots,
}: RendererInput<LayoutSectionProps>) {
  const heading = resolvedProps.title === undefined
    ? null
    : createElement(
      `h${resolvedProps.level}`,
      { className: "og-section-title" },
      resolvedProps.title,
    );
  return (
    <section
      className={classes("og-ui og-section", resolvedProps.divider && "og-section-divider")}
      data-og-component="layout.section"
    >
      {heading || resolvedProps.description ? (
        <header className="og-section-header">
          {heading}
          {resolvedProps.description ? <p className="og-section-description">{resolvedProps.description}</p> : null}
        </header>
      ) : null}
      <div className="og-section-content">{slots.children}</div>
    </section>
  );
}
