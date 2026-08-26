import {
  shadcnComponentFamilies,
  type ShadcnComponentFamily,
} from "@open-generative/components";
import type {
  OpenGenerativeComponentProfile,
  OpenGenerativeComponentSelection,
  OpenGenerativeComponentType,
  OpenGenerativeDatasetResource,
} from "@open-generative/mastra";
import {
  OPEN_GENERATIVE_COMPONENT_PROFILES,
  OPEN_GENERATIVE_COMPONENT_SLICE_LIMIT,
  OPEN_GENERATIVE_REQUIRED_COMPONENT_TYPES,
} from "@open-generative/mastra";

export type TesseraPresentationTaskType =
  | "database"
  | "sql"
  | "edge-function"
  | "debugging"
  | "monitoring"
  | "conversation";

export type TesseraPresentationWorkspace = Readonly<{
  hasCurrentRelation: boolean;
}>;

type ComponentTextMatch = Readonly<{
  family: ShadcnComponentFamily;
  start: number;
  end: number;
}>;

const SHADCN_COMPONENT_ALIASES: Readonly<Partial<Record<ShadcnComponentFamily, readonly string[]>>> = {
  accordion: ["\u624b\u98ce\u7434", "\u6298\u53e0\u9762\u677f"],
  "alert-dialog": ["\u8b66\u544a\u5bf9\u8bdd\u6846", "\u786e\u8ba4\u5bf9\u8bdd\u6846"],
  attachment: ["\u9644\u4ef6"],
  avatar: ["\u5934\u50cf"],
  badge: ["\u5fbd\u7ae0"],
  breadcrumb: ["\u9762\u5305\u5c51"],
  "button-group": ["\u6309\u94ae\u7ec4"],
  calendar: ["\u65e5\u5386"],
  card: ["\u5361\u7247"],
  carousel: ["\u8f6e\u64ad"],
  chart: ["\u56fe\u8868"],
  checkbox: ["\u590d\u9009\u6846"],
  combobox: ["\u7ec4\u5408\u6846", "\u53ef\u641c\u7d22\u4e0b\u62c9"],
  command: ["\u547d\u4ee4\u9762\u677f"],
  "context-menu": ["\u53f3\u952e\u83dc\u5355", "\u4e0a\u4e0b\u6587\u83dc\u5355"],
  dialog: ["\u5bf9\u8bdd\u6846", "\u5f39\u7a97"],
  drawer: ["\u62bd\u5c49"],
  "dropdown-menu": ["\u4e0b\u62c9\u83dc\u5355"],
  empty: ["\u7a7a\u72b6\u6001"],
  form: ["\u8868\u5355"],
  "hover-card": ["\u60ac\u6d6e\u5361\u7247"],
  input: ["\u8f93\u5165\u6846"],
  "input-otp": ["\u9a8c\u8bc1\u7801\u8f93\u5165"],
  "navigation-menu": ["\u5bfc\u822a\u83dc\u5355"],
  pagination: ["\u5206\u9875"],
  progress: ["\u8fdb\u5ea6\u6761"],
  "radio-group": ["\u5355\u9009\u7ec4"],
  resizable: ["\u53ef\u8c03\u6574\u5927\u5c0f", "\u53ef\u62d6\u62fd\u5206\u680f"],
  select: ["\u9009\u62e9\u5668", "\u4e0b\u62c9\u9009\u62e9"],
  separator: ["\u5206\u9694\u7ebf"],
  sheet: ["\u4fa7\u8fb9\u9762\u677f"],
  sidebar: ["\u4fa7\u8fb9\u680f"],
  skeleton: ["\u9aa8\u67b6\u5c4f"],
  slider: ["\u6ed1\u5757"],
  spinner: ["\u52a0\u8f7d\u6307\u793a\u5668"],
  switch: ["\u5f00\u5173"],
  table: ["\u8868\u683c"],
  tabs: ["\u9009\u9879\u5361", "\u6807\u7b7e\u9875"],
  textarea: ["\u6587\u672c\u57df", "\u591a\u884c\u8f93\u5165"],
  tooltip: ["\u5de5\u5177\u63d0\u793a"],
};

/**
 * Selects presentation capabilities only. This advisory result never enters a
 * database tool, permission decision, approval, or action contract.
 */
export function selectTesseraOpenGenerativeComponents(input: Readonly<{
  message: string;
  workspace?: TesseraPresentationWorkspace;
  hasAnalyses: boolean;
  hasQueries: boolean;
  resources: readonly OpenGenerativeDatasetResource[];
}>): OpenGenerativeComponentSelection {
  const taskType = inferTesseraPresentationTaskType(input.message);
  const profile = inferTesseraPresentationProfile(input.message)
    ?? (input.hasAnalyses || taskType === "monitoring"
    ? "dashboard"
    : input.hasQueries
      || taskType === "database"
      || taskType === "sql"
      || input.workspace?.hasCurrentRelation === true
      ? "records"
      : "analysis");
  const profileTypes = new Set<OpenGenerativeComponentType>(
    OPEN_GENERATIVE_COMPONENT_PROFILES[profile],
  );
  const capacity = OPEN_GENERATIVE_COMPONENT_SLICE_LIMIT
    - OPEN_GENERATIVE_REQUIRED_COMPONENT_TYPES.length
    - profileTypes.size;
  const componentTypes = new Set<OpenGenerativeComponentType>();
  const requestedTypes: OpenGenerativeComponentType[] = [
    ...matchExplicitShadcnComponents(input.message),
    ...(input.resources.length > 1 ? ["shadcn.tabs" as const] : []),
    ...(taskType === "monitoring" ? ["shadcn.alert" as const] : []),
  ];
  for (const componentType of requestedTypes) {
    if (profileTypes.has(componentType) || componentTypes.has(componentType)) continue;
    if (componentTypes.size >= capacity) break;
    componentTypes.add(componentType);
  }
  return {
    profile,
    ...(componentTypes.size === 0 ? {} : { componentTypes: [...componentTypes] }),
  };
}

export function inferTesseraPresentationTaskType(message: string): TesseraPresentationTaskType {
  const normalized = message.toLowerCase();
  if (/(?:edge[\s_-]*function|deno|deploy.{0,32}function|\u8fb9\u7f18\u51fd\u6570)/u.test(normalized)) return "edge-function";
  if (/(?:debug|error|exception|stack trace|not working|failed|bug|\u8c03\u8bd5|\u62a5\u9519|\u9519\u8bef|\u5931\u8d25|\u6392\u67e5|\u6545\u969c)/u.test(normalized)) return "debugging";
  if (/(?:monitor|logs?|advisor|health|latency|slow query|\u76d1\u63a7|\u65e5\u5fd7|\u544a\u8b66|\u6027\u80fd|\u6162\u67e5\u8be2)/u.test(normalized)) return "monitoring";
  if (/(?:\bsql\b|```(?:sql)?|^\s*(?:select|with|insert|update|delete|create|alter|drop)\b|(?:write|generate|draft|explain|fix).{0,32}\b(?:select|with|insert|update|delete|create|alter|drop)\b|\u7f16\u5199\s*sql)/u.test(normalized)) return "sql";
  if (/(?:database|schema|table|column|row|record|data|\u6570\u636e\u5e93|\u8868|\u5b57\u6bb5|\u8bb0\u5f55|\u6570\u636e)/u.test(normalized)) return "database";
  return "conversation";
}

function inferTesseraPresentationProfile(message: string): OpenGenerativeComponentProfile | undefined {
  const normalized = message.toLowerCase();
  if (/(?:\u4eea\u8868\u76d8|\u6570\u636e\u770b\u677f|\b(?:dashboard|scorecard)\b)/u.test(normalized)) return "dashboard";
  if (/(?:\u8868\u5355|\bform(?: builder)?\b|data[\s-]?entry|settings form)/u.test(normalized)) return "forms";
  if (/(?:\u5bfc\u822a|\b(?:navigation|site nav)\b)/u.test(normalized)) return "navigation";
  if (/(?:\u5bf9\u8bdd\u6d41|\u804a\u5929|\u6d88\u606f\u6d41|\b(?:conversation|chat|message stream)\b)/u.test(normalized)) return "conversation";
  if (/(?:\u53cd\u9988\u72b6\u6001|\u52a0\u8f7d\u72b6\u6001|\u9519\u8bef\u72b6\u6001|\b(?:feedback|loading|error) states?\b)/u.test(normalized)) return "feedback";
  if (/(?:\u5f39\u5c42|\u6d6e\u5c42|\b(?:modal|overlay)\b)/u.test(normalized)) return "overlays";
  return undefined;
}

function matchExplicitShadcnComponents(message: string): OpenGenerativeComponentType[] {
  const normalized = message.toLowerCase();
  const matches: ComponentTextMatch[] = [];
  for (const family of shadcnComponentFamilies) {
    const familyPattern = family.split("-").map(escapeRegex).join("[\\s_-]+");
    const canonicalPattern = new RegExp(`(^|[^a-z0-9])(${familyPattern})(?=$|[^a-z0-9])`, "giu");
    for (const match of normalized.matchAll(canonicalPattern)) {
      const prefixLength = match[1]?.length ?? 0;
      const valueLength = match[2]?.length ?? 0;
      const start = (match.index ?? 0) + prefixLength;
      matches.push({ family, start, end: start + valueLength });
    }
    for (const alias of SHADCN_COMPONENT_ALIASES[family] ?? []) {
      let start = normalized.indexOf(alias);
      while (start >= 0) {
        matches.push({ family, start, end: start + alias.length });
        start = normalized.indexOf(alias, start + alias.length);
      }
    }
  }

  const accepted: ComponentTextMatch[] = [];
  const acceptedFamilies = new Set<ShadcnComponentFamily>();
  for (const match of matches.sort((left, right) => (
    (right.end - right.start) - (left.end - left.start)
    || left.start - right.start
    || left.family.localeCompare(right.family)
  ))) {
    if (acceptedFamilies.has(match.family)) continue;
    if (accepted.some((item) => item.start < match.end && match.start < item.end)) continue;
    accepted.push(match);
    acceptedFamilies.add(match.family);
  }
  return accepted
    .sort((left, right) => left.start - right.start || left.family.localeCompare(right.family))
    .map(({ family }) => `shadcn.${family}` as OpenGenerativeComponentType);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
