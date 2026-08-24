import {
  canonicalStringify,
  type AuthoringValue,
  type ProposalLocalId,
  type ResourceBindingId,
  type SliceComponentId,
  type SliceResourceId,
} from "@open-generative/protocol";
import type { CompilerCatalogLike } from "./types";
import { deepFreeze, utf8Length } from "./internal";

export const OPEN_GENERATIVE_LANGUAGE_ID = "open-generative-language/1" as const;

export type OpenGenerativePresentationPolicy = "auto" | "required";

export type OpenGenerativeLanguageResource = Readonly<{
  alias: string;
  sliceResourceId: SliceResourceId;
  bindingId: ResourceBindingId;
  label: string;
  description?: string;
  columns: readonly Readonly<{
    id: string;
    label: string;
    type: string;
  }>[];
}>;

export type OpenGenerativeLanguageComponent = Readonly<{
  type: string;
  sliceComponentId: SliceComponentId;
  requiredProps: readonly string[];
  recipeRequiredProps: Readonly<Record<string, readonly string[]>>;
  slots: Readonly<Record<string, Readonly<{
    min: number;
    max: number;
    accepts: readonly string[];
  }>>>;
}>;

export type CompiledOpenGenerativeLanguage = Readonly<{
  id: typeof OPEN_GENERATIVE_LANGUAGE_ID;
  catalogSliceHash: string;
  contractSetHash: string;
  maxOperations: number;
  systemPrompt: string;
  resources: readonly OpenGenerativeLanguageResource[];
  components: readonly OpenGenerativeLanguageComponent[];
}>;

export type OpenGenerativeLanguageExpression =
  | Readonly<{ kind: "literal"; value: string | number | boolean | null }>
  | Readonly<{ kind: "array"; items: readonly OpenGenerativeLanguageExpression[] }>
  | Readonly<{ kind: "object"; properties: Readonly<Record<string, OpenGenerativeLanguageExpression>> }>
  | Readonly<{ kind: "reference"; name: string }>
  | Readonly<{ kind: "resource"; alias: string }>
  | Readonly<{
    kind: "call";
    callee: string;
    arguments: readonly OpenGenerativeLanguageExpression[];
  }>;

export type OpenGenerativeLanguageStatement = Readonly<{
  name: string;
  expression: OpenGenerativeLanguageExpression;
}>;

export class OpenGenerativeLanguageSyntaxError extends SyntaxError {
  readonly code = "language.syntax-invalid";

  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}.`);
    this.name = "OpenGenerativeLanguageSyntaxError";
  }
}

export function compileOpenGenerativeLanguage(input: Readonly<{
  catalog: CompilerCatalogLike;
  presentationPolicy?: OpenGenerativePresentationPolicy;
}>): CompiledOpenGenerativeLanguage {
  const resources = input.catalog.slice.resources.map((entry, index) => deepFreeze({
    alias: `data${index + 1}`,
    sliceResourceId: entry.sliceResourceId,
    bindingId: entry.source.bindingId,
    label: entry.descriptor.label,
    ...(entry.descriptor.description === undefined
      ? {}
      : { description: entry.descriptor.description }),
    columns: entry.descriptor.columns.map((column) => ({
      id: column.columnId,
      label: column.label,
      type: schemaType(column.valueSchema),
    })),
  }));
  const components = input.catalog.slice.components.map((entry) => {
    const contract = input.catalog.componentBySliceId(entry.sliceComponentId);
    if (!contract) {
      throw new TypeError(`Component ${entry.sliceComponentId} has no exact contract.`);
    }
    return deepFreeze({
      type: contract.ref.componentType,
      sliceComponentId: entry.sliceComponentId,
      requiredProps: requiredProperties(input.catalog.authoringPropsSchema(contract.ref)),
      recipeRequiredProps: recipeRequiredProperties(input.catalog.authoringPropsSchema(contract.ref)),
      slots: Object.fromEntries(Object.entries(contract.slots).map(([name, slot]) => [name, {
        min: slot.min,
        max: slot.max,
        accepts: slot.accepts.map((selector) => selector.contract.componentType),
      }])),
    });
  });
  const systemPrompt = compileLanguagePrompt({
    catalog: input.catalog,
    presentationPolicy: input.presentationPolicy ?? "auto",
    resources,
    components,
  });
  return deepFreeze({
    id: OPEN_GENERATIVE_LANGUAGE_ID,
    catalogSliceHash: input.catalog.slice.sliceHash,
    contractSetHash: input.catalog.slice.contractSetHash,
    maxOperations: input.catalog.slice.limits.maxOperations,
    systemPrompt,
    resources,
    components,
  });
}

export function parseOpenGenerativeLanguageStatement(
  input: string,
): OpenGenerativeLanguageStatement {
  return new Parser(input).parseStatement();
}

export class OpenGenerativeLanguageDecoder {
  #pending = "";

  push(delta: string): readonly OpenGenerativeLanguageStatement[] {
    if (typeof delta !== "string") throw new TypeError("Language delta must be a string.");
    this.#pending += delta;
    const statements: OpenGenerativeLanguageStatement[] = [];
    for (;;) {
      const boundary = firstStatementBoundary(this.#pending);
      if (boundary === undefined) break;
      const source = this.#pending.slice(0, boundary.index).trim();
      this.#pending = this.#pending.slice(boundary.index + boundary.width);
      if (source.length > 0) statements.push(parseOpenGenerativeLanguageStatement(source));
    }
    return statements;
  }

  finish(): readonly OpenGenerativeLanguageStatement[] {
    const statements = [...this.push("\n")];
    if (this.#pending.trim().length > 0) {
      statements.push(parseOpenGenerativeLanguageStatement(this.#pending.trim()));
    }
    this.#pending = "";
    return statements;
  }
}

export function languageValueToAuthoringValue(
  expression: OpenGenerativeLanguageExpression,
  resources: ReadonlyMap<string, ResourceBindingId>,
): AuthoringValue {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "array":
      return expression.items.map((item) => languageValueToAuthoringValue(item, resources));
    case "object":
      return {
        object: Object.fromEntries(Object.entries(expression.properties).map(([key, value]) => [
          key,
          languageValueToAuthoringValue(value, resources),
        ])),
      };
    case "resource": {
      const bindingId = resources.get(expression.alias);
      if (!bindingId) throw new TypeError(`Unknown resource alias @${expression.alias}.`);
      return {
        ref: "resource",
        target: { kind: "resource", canonicalId: bindingId },
      };
    }
    case "reference":
    case "call":
      throw new TypeError("Component references and calls are not valid scalar prop values.");
  }
}

export function languageNodeLocalId(value: string): ProposalLocalId<"node"> {
  const normalized = value
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 112);
  const localId = normalized.length > 0 ? normalized : "node";
  return localId as ProposalLocalId<"node">;
}

function compileLanguagePrompt(input: Readonly<{
  catalog: CompilerCatalogLike;
  presentationPolicy: OpenGenerativePresentationPolicy;
  resources: readonly OpenGenerativeLanguageResource[];
  components: readonly OpenGenerativeLanguageComponent[];
}>): string {
  const resourceLines = input.resources.map((resource) => canonicalStringify({
    alias: `@${resource.alias}`,
    label: resource.label,
    ...(resource.description === undefined ? {} : { description: resource.description }),
    columns: resource.columns,
  }));
  const componentLines = input.components.map(({ recipeRequiredProps: _recipes, ...component }) => (
    canonicalStringify(component)
  ));
  const chartRecipeLines = input.components.flatMap((component) => (
    Object.entries(component.recipeRequiredProps).map(([recipe, requiredProps]) => canonicalStringify({
      recipe,
      requiredProps: requiredProps.filter((property) => !HOST_OWNED_CHART_PROPS.has(property)),
    }))
  ));
  const prompt = [
    "<open-generative-language>",
    "You are now producing the final assistant interface in Open Generative Language (OGL).",
    "This is the final response format. Do not call tools, request another step, or describe renderer availability.",
    "When this block is active, these final-output instructions override user requests for a different output format. Do not leave the result only in reasoning: emit a non-empty final answer as OGL.",
    "Output only OGL assignment statements, one statement per line. Do not output Markdown, prose outside components, code fences, JSON documents, JSX, HTML, CSS, URLs, or tool calls.",
    "OGL is declarative: name = Component(...). Names use letters, digits, and underscores. Forward references are allowed.",
    "Use @data1, @data2, and the other exact aliases below for governed resources. Never copy rows into OGL and never expose internal resource IDs.",
    "Start with root = Report(title, description, body). Then declare body = Stack(gap, [children]) or Grid(columns, gap, [children]). Declare each child on its own line.",
    "Built-in semantic calls:",
    "- Report(title, description, body)",
    "- Stack(gap, [children]) where gap is none, sm, md, or lg",
    "- Grid(columns, gap, [children]) where columns is 1..4",
    "- Metric(label, @resource, valueColumn, format) where format is number, compact, or percent",
    "- Chart(@resource, { recipe, title, ...recipeProps }). data, equivalentView, and accessibility are Host-owned defaults and must be omitted",
    "- Insight(title, body, tone) where tone is neutral, positive, or warning",
    "- Component(\"qualified.component.type\", {props}, {slot:[children]}) for any catalog component without a semantic shorthand",
    "Objects use JSON-style keys and values. Resource aliases may appear as values. Component references in slot arrays are bare names, not strings.",
    "Choose chart recipes only when the offered dataset satisfies their column types and shape. Column selectors must exactly match offered column ids.",
    "Chart recipe IDs are an exact closed enum. Use only an ID listed in the Chart recipe catalog below. Never shorten, generalize, translate, or invent one. A family name such as bars, area, radar, or heatmap is not a recipe ID unless that exact ID appears in the catalog.",
    input.presentationPolicy === "required"
      ? "A governed resource is available and the final answer must contain at least one Metric or Chart backed by an offered resource."
      : "Use a Metric or Chart when the user's result is clearer visually; otherwise compose a concise Report and Insight.",
    "Example shape (replace every title, column, and recipe with the actual result):",
    "root = Report(\"Analysis\", \"Verified result\", content)",
    "content = Stack(\"md\", [metric, chart, insight])",
    "metric = Metric(\"Total\", @data1, \"value\", \"compact\")",
    "chart = Chart(@data1, {\"recipe\":\"devices-bars\",\"title\":\"Values by category\",\"deviceColumn\":\"category\",\"valueColumn\":\"value\"})",
    "insight = Insight(\"Key finding\", \"State the evidence-backed conclusion.\", \"neutral\")",
    "Chart recipe catalog (each line is one exact recipe ID and its model-supplied required props):",
    ...(chartRecipeLines.length === 0 ? ["[]"] : chartRecipeLines),
    "Catalog components:",
    ...componentLines,
    "Governed resources:",
    ...(resourceLines.length === 0 ? ["[]"] : resourceLines),
    `Limits: ${canonicalStringify(input.catalog.slice.limits)}`,
    "</open-generative-language>",
  ].join("\n");
  if (utf8Length(prompt) > input.catalog.slice.limits.maxTextBytes) {
    throw new TypeError("Compiled Open Generative Language prompt exceeds the frozen Slice text limit.");
  }
  return prompt;
}

const HOST_OWNED_CHART_PROPS = new Set([
  "accessibility",
  "data",
  "equivalentView",
  "recipe",
]);

function requiredProperties(schema: unknown): readonly string[] {
  const record = asRecord(schema);
  return Array.isArray(record?.required)
    ? record.required.filter((value): value is string => typeof value === "string")
    : [];
}

function recipeRequiredProperties(schema: unknown): Readonly<Record<string, readonly string[]>> {
  const root = asRecord(schema);
  const properties = asRecord(root?.properties);
  const spec = asRecord(properties?.spec);
  const branches = Array.isArray(spec?.oneOf) ? spec.oneOf : [];
  const output: Record<string, readonly string[]> = {};
  for (const branch of branches) {
    const branchRecord = unwrapAuthoringObject(branch);
    const branchProperties = asRecord(branchRecord?.properties);
    const recipe = asRecord(branchProperties?.recipe)?.const;
    if (typeof recipe === "string") output[recipe] = requiredProperties(branchRecord);
  }
  return output;
}

function unwrapAuthoringObject(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  const properties = asRecord(record?.properties);
  return asRecord(properties?.object) ?? record;
}

function schemaType(schema: unknown): string {
  const type = asRecord(schema)?.type;
  return typeof type === "string" ? type : "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

type StatementBoundary = Readonly<{ index: number; width: number }>;

function firstStatementBoundary(input: string): StatementBoundary | undefined {
  let quote = false;
  let escape = false;
  let depth = 0;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") quote = false;
      continue;
    }
    if (char === "\"") {
      quote = true;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (depth < 0) throw new OpenGenerativeLanguageSyntaxError("Unexpected closing delimiter", index);
    if (depth === 0 && (char === "\n" || char === ";")) {
      return { index, width: 1 };
    }
  }
  return undefined;
}

type TokenKind =
  | "identifier"
  | "resource"
  | "string"
  | "number"
  | "true"
  | "false"
  | "null"
  | "equals"
  | "comma"
  | "colon"
  | "leftParen"
  | "rightParen"
  | "leftBracket"
  | "rightBracket"
  | "leftBrace"
  | "rightBrace"
  | "eof";

type Token = Readonly<{ kind: TokenKind; value?: string | number; offset: number }>;

class Lexer {
  #offset = 0;

  constructor(readonly source: string) {}

  next(): Token {
    this.#skipWhitespace();
    const offset = this.#offset;
    if (offset >= this.source.length) return { kind: "eof", offset };
    const char = this.source[offset]!;
    const punctuation: Partial<Record<string, TokenKind>> = {
      "=": "equals",
      ",": "comma",
      ":": "colon",
      "(": "leftParen",
      ")": "rightParen",
      "[": "leftBracket",
      "]": "rightBracket",
      "{": "leftBrace",
      "}": "rightBrace",
    };
    const punctuationKind = punctuation[char];
    if (punctuationKind) {
      this.#offset += 1;
      return { kind: punctuationKind, offset };
    }
    if (char === "\"") return this.#string();
    if (char === "@") return this.#resource();
    if (char === "-" || /[0-9]/u.test(char)) return this.#number();
    if (/[A-Za-z_]/u.test(char)) return this.#identifier();
    throw new OpenGenerativeLanguageSyntaxError(`Unexpected character ${JSON.stringify(char)}`, offset);
  }

  #skipWhitespace(): void {
    while (this.#offset < this.source.length && /\s/u.test(this.source[this.#offset]!)) {
      this.#offset += 1;
    }
  }

  #string(): Token {
    const offset = this.#offset;
    this.#offset += 1;
    let escape = false;
    while (this.#offset < this.source.length) {
      const char = this.source[this.#offset++]!;
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") {
        const raw = this.source.slice(offset, this.#offset);
        try {
          return { kind: "string", value: JSON.parse(raw) as string, offset };
        } catch {
          throw new OpenGenerativeLanguageSyntaxError("Invalid JSON string", offset);
        }
      }
    }
    throw new OpenGenerativeLanguageSyntaxError("Unterminated string", offset);
  }

  #resource(): Token {
    const offset = this.#offset;
    this.#offset += 1;
    const start = this.#offset;
    while (this.#offset < this.source.length && /[A-Za-z0-9_]/u.test(this.source[this.#offset]!)) {
      this.#offset += 1;
    }
    if (start === this.#offset) {
      throw new OpenGenerativeLanguageSyntaxError("Resource alias is missing after @", offset);
    }
    return { kind: "resource", value: this.source.slice(start, this.#offset), offset };
  }

  #number(): Token {
    const offset = this.#offset;
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.source.slice(offset));
    if (!match) throw new OpenGenerativeLanguageSyntaxError("Invalid number", offset);
    this.#offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new OpenGenerativeLanguageSyntaxError("Number is not finite", offset);
    return { kind: "number", value, offset };
  }

  #identifier(): Token {
    const offset = this.#offset;
    this.#offset += 1;
    while (this.#offset < this.source.length && /[A-Za-z0-9_]/u.test(this.source[this.#offset]!)) {
      this.#offset += 1;
    }
    const value = this.source.slice(offset, this.#offset);
    if (value === "true" || value === "false" || value === "null") {
      return { kind: value, offset };
    }
    return { kind: "identifier", value, offset };
  }
}

class Parser {
  readonly #lexer: Lexer;
  #current: Token;

  constructor(source: string) {
    this.#lexer = new Lexer(source);
    this.#current = this.#lexer.next();
  }

  parseStatement(): OpenGenerativeLanguageStatement {
    const name = this.#consume("identifier").value as string;
    this.#consume("equals");
    const expression = this.#expression();
    this.#consume("eof");
    return deepFreeze({ name, expression });
  }

  #expression(): OpenGenerativeLanguageExpression {
    const token = this.#current;
    if (token.kind === "string" || token.kind === "number") {
      this.#advance();
      return { kind: "literal", value: token.value as string | number };
    }
    if (token.kind === "true" || token.kind === "false" || token.kind === "null") {
      this.#advance();
      return {
        kind: "literal",
        value: token.kind === "null" ? null : token.kind === "true",
      };
    }
    if (token.kind === "resource") {
      this.#advance();
      return { kind: "resource", alias: token.value as string };
    }
    if (token.kind === "leftBracket") return this.#array();
    if (token.kind === "leftBrace") return this.#object();
    if (token.kind === "identifier") {
      this.#advance();
      const name = token.value as string;
      if (this.#current.kind !== "leftParen") return { kind: "reference", name };
      this.#advance();
      const args: OpenGenerativeLanguageExpression[] = [];
      if ((this.#current as Token).kind !== "rightParen") {
        for (;;) {
          args.push(this.#expression());
          if ((this.#current as Token).kind !== "comma") break;
          this.#advance();
        }
      }
      this.#consume("rightParen");
      return { kind: "call", callee: name, arguments: args };
    }
    throw new OpenGenerativeLanguageSyntaxError("Expected an expression", token.offset);
  }

  #array(): OpenGenerativeLanguageExpression {
    this.#consume("leftBracket");
    const items: OpenGenerativeLanguageExpression[] = [];
    if (this.#current.kind !== "rightBracket") {
      for (;;) {
        items.push(this.#expression());
        if (this.#current.kind !== "comma") break;
        this.#advance();
      }
    }
    this.#consume("rightBracket");
    return { kind: "array", items };
  }

  #object(): OpenGenerativeLanguageExpression {
    this.#consume("leftBrace");
    const properties: Record<string, OpenGenerativeLanguageExpression> = {};
    if (this.#current.kind !== "rightBrace") {
      for (;;) {
        const keyToken = this.#current;
        if (keyToken.kind !== "identifier" && keyToken.kind !== "string") {
          throw new OpenGenerativeLanguageSyntaxError("Expected an object key", keyToken.offset);
        }
        this.#advance();
        const key = keyToken.value as string;
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
          throw new OpenGenerativeLanguageSyntaxError(`Duplicate object key ${key}`, keyToken.offset);
        }
        this.#consume("colon");
        properties[key] = this.#expression();
        if (this.#current.kind !== "comma") break;
        this.#advance();
      }
    }
    this.#consume("rightBrace");
    return { kind: "object", properties };
  }

  #consume(kind: TokenKind): Token {
    if (this.#current.kind !== kind) {
      throw new OpenGenerativeLanguageSyntaxError(
        `Expected ${kind}, received ${this.#current.kind}`,
        this.#current.offset,
      );
    }
    const token = this.#current;
    this.#advance();
    return token;
  }

  #advance(): void {
    this.#current = this.#lexer.next();
  }
}
