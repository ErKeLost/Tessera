import { expect, test } from "bun:test";
import { shadcnComponentFamilies } from "@open-generative/components";
import {
  OPEN_GENERATIVE_COMPONENT_PROFILES,
  OPEN_GENERATIVE_COMPONENT_SLICE_LIMIT,
  OPEN_GENERATIVE_REQUIRED_COMPONENT_TYPES,
  type OpenGenerativeComponentSelection,
  type OpenGenerativeComponentType,
} from "@open-generative/mastra";
import {
  inferTesseraPresentationTaskType,
  selectTesseraOpenGenerativeComponents,
} from "./catalog-selection";

test("selects bounded Open Generative UI packs without changing authority", () => {
  expect(selectTesseraOpenGenerativeComponents({
    message: "Show the orders table",
    hasAnalyses: false,
    hasQueries: true,
    resources: [{} as never],
  })).toEqual({ profile: "records" });

  expect(selectTesseraOpenGenerativeComponents({
    message: "Monitor slow query health",
    hasAnalyses: true,
    hasQueries: false,
    resources: [{} as never, {} as never],
  })).toEqual({
    profile: "dashboard",
    componentTypes: ["shadcn.alert"],
  });

  expect(selectTesseraOpenGenerativeComponents({
    message: "Hello there",
    hasAnalyses: false,
    hasQueries: false,
    resources: [],
  })).toEqual({ profile: "analysis" });

  expect(inferTesseraPresentationTaskType("Please debug the failed SQL query")).toBe("debugging");
  expect(inferTesseraPresentationTaskType("Write a CREATE TABLE statement")).toBe("sql");
  expect(inferTesseraPresentationTaskType("Check the slow query logs")).toBe("monitoring");
  expect(inferTesseraPresentationTaskType("Deploy an Edge Function")).toBe("edge-function");
  expect(inferTesseraPresentationTaskType("Show the orders table")).toBe("database");
  expect(inferTesseraPresentationTaskType("Hello there")).toBe("conversation");
});

test("makes every canonical shadcn family reachable without expanding the whole prompt", () => {
  for (const family of shadcnComponentFamilies) {
    const selection = selectTesseraOpenGenerativeComponents({
      message: `Compose with shadcn.${family}.`,
      hasAnalyses: false,
      hasQueries: false,
      resources: [],
    });
    expect(effectiveComponentTypes(selection)).toContain(`shadcn.${family}`);
    expect(effectiveComponentTypes(selection).size).toBeLessThanOrEqual(
      OPEN_GENERATIVE_COMPONENT_SLICE_LIMIT,
    );
  }
});

test("caps explicit component matches locally and prefers longer component names", () => {
  const allComponents = selectTesseraOpenGenerativeComponents({
    message: shadcnComponentFamilies.map((family) => `shadcn.${family}`).join(", "),
    hasAnalyses: false,
    hasQueries: false,
    resources: [],
  });
  expect(effectiveComponentTypes(allComponents).size).toBe(
    OPEN_GENERATIVE_COMPONENT_SLICE_LIMIT,
  );

  const overlappingNames = selectTesseraOpenGenerativeComponents({
    message: "Use alert and alert-dialog with input-group.",
    hasAnalyses: false,
    hasQueries: false,
    resources: [],
  });
  expect(overlappingNames.componentTypes).toEqual([
    "shadcn.alert",
    "shadcn.alert-dialog",
    "shadcn.input-group",
  ]);
  expect(overlappingNames.componentTypes).not.toContain("shadcn.dialog");
  expect(overlappingNames.componentTypes).not.toContain("shadcn.input");
});

test("keeps Chinese component routing inside the presentation adapter", () => {
  const selection = selectTesseraOpenGenerativeComponents({
    message: "\u7528\u62bd\u5c49\u3001\u65e5\u5386\u548c\u6ed1\u5757\u7ec4\u5408\u4e00\u4e2a\u7b5b\u9009\u5668",
    hasAnalyses: false,
    hasQueries: false,
    resources: [],
  });
  expect(selection).toEqual({
    profile: "analysis",
    componentTypes: ["shadcn.drawer", "shadcn.calendar", "shadcn.slider"],
  });
});

function effectiveComponentTypes(
  selection: OpenGenerativeComponentSelection,
): ReadonlySet<OpenGenerativeComponentType> {
  return new Set([
    ...OPEN_GENERATIVE_REQUIRED_COMPONENT_TYPES,
    ...OPEN_GENERATIVE_COMPONENT_PROFILES[selection.profile ?? "analysis"],
    ...(selection.componentTypes ?? []),
  ]);
}
