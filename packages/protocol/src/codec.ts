import { z } from "zod";
import { DEFAULT_PROTOCOL_LIMITS, FORBIDDEN_OBJECT_KEYS, type ProtocolLimits } from "./constants";
import { createDiagnostic, ProtocolError } from "./diagnostics";
import { canonicalEncode } from "./hash";
import { assertValidUnicode } from "./json";

export type JsonCodecOptions = {
  limits?: ProtocolLimits;
  maxBytes?: number;
};

export function encodeJson<T>(value: T, schema: z.ZodType<T>, options: JsonCodecOptions = {}): Uint8Array {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw schemaProtocolError("transport.encode-schema-invalid", parsed.error.message);
  const bytes = canonicalEncode(parsed.data);
  enforceByteLimit(bytes.byteLength, options.maxBytes ?? options.limits?.maxFrameBytes ?? DEFAULT_PROTOCOL_LIMITS.maxFrameBytes);
  return bytes;
}

export function decodeJson<T>(
  input: string | Uint8Array,
  schema: z.ZodType<T>,
  options: JsonCodecOptions = {},
): T {
  const limits = options.limits ?? DEFAULT_PROTOCOL_LIMITS;
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  enforceByteLimit(bytes.byteLength, options.maxBytes ?? limits.maxFrameBytes);

  let text: string;
  try {
    text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw codecError("decode.invalid-utf8", "Frame is not valid UTF-8.");
  }

  let raw: unknown;
  try {
    new JsonScanner(text, limits.maxDepth).parse();
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw codecError("decode.invalid-json", "Frame is not valid JSON.");
  }

  enforceValueLimits(raw, limits);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw schemaProtocolError("decode.schema-invalid", parsed.error.message);
  return parsed.data;
}

export function createJsonCodec<T>(schema: z.ZodType<T>, options: JsonCodecOptions = {}) {
  return Object.freeze({
    encode(value: T): Uint8Array {
      return encodeJson(value, schema, options);
    },
    decode(input: string | Uint8Array): T {
      return decodeJson(input, schema, options);
    },
    createJsonLinesDecoder(): JsonLinesDecoder<T> {
      return new JsonLinesDecoder(schema, options);
    },
  });
}

export class JsonLinesDecoder<T> {
  readonly #schema: z.ZodType<T>;
  readonly #options: JsonCodecOptions;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = "";
  #closed = false;
  #mode: "text" | "bytes" | undefined;

  constructor(schema: z.ZodType<T>, options: JsonCodecOptions = {}) {
    this.#schema = schema;
    this.#options = options;
  }

  push(chunk: string | Uint8Array): T[] {
    if (this.#closed) throw codecError("decode.closed", "JSON Lines decoder is already closed.");
    const mode = typeof chunk === "string" ? "text" : "bytes";
    if (this.#mode !== undefined && this.#mode !== mode) {
      throw codecError("decode.mixed-input", "Do not mix string and byte chunks in one decoder.");
    }
    this.#mode = mode;
    try {
      this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    } catch {
      throw codecError("decode.invalid-utf8", "JSON Lines stream is not valid UTF-8.");
    }
    return this.#consumeCompleteLines();
  }

  finish(): T[] {
    if (this.#closed) throw codecError("decode.closed", "JSON Lines decoder is already closed.");
    this.#closed = true;
    if (this.#mode === "bytes") {
      try {
        this.#buffer += this.#decoder.decode();
      } catch {
        throw codecError("decode.invalid-utf8", "JSON Lines stream ends with invalid UTF-8.");
      }
    }
    const output = this.#consumeCompleteLines();
    if (this.#buffer.length > 0) {
      output.push(decodeJson(stripCarriageReturn(this.#buffer), this.#schema, this.#options));
      this.#buffer = "";
    }
    return output;
  }

  #consumeCompleteLines(): T[] {
    const output: T[] = [];
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = stripCarriageReturn(this.#buffer.slice(0, newline));
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) throw codecError("decode.empty-frame", "JSON Lines stream contains an empty frame.");
      output.push(decodeJson(line, this.#schema, this.#options));
      newline = this.#buffer.indexOf("\n");
    }
    const maxBytes = this.#options.maxBytes ?? this.#options.limits?.maxFrameBytes ?? DEFAULT_PROTOCOL_LIMITS.maxFrameBytes;
    enforceByteLimit(new TextEncoder().encode(this.#buffer).byteLength, maxBytes);
    return output;
  }
}

export function encodeJsonLine<T>(value: T, schema: z.ZodType<T>, options: JsonCodecOptions = {}): Uint8Array {
  const frame = encodeJson(value, schema, options);
  const output = new Uint8Array(frame.byteLength + 1);
  output.set(frame);
  output[frame.byteLength] = 0x0a;
  return output;
}

function stripCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function enforceByteLimit(actualBytes: number, maxBytes: number): void {
  if (actualBytes <= maxBytes) return;
  throw new ProtocolError(createDiagnostic({
    phase: "decode",
    code: "decode.frame-too-large",
    severity: "fatal",
    recoverable: false,
    modelCorrectable: false,
    message: `Frame is ${actualBytes} bytes; the negotiated limit is ${maxBytes}.`,
    actualSummary: `${actualBytes} bytes`,
  }));
}

function enforceValueLimits(input: unknown, limits: ProtocolLimits): void {
  let totalValues = 0;
  const visit = (value: unknown, depth: number): void => {
    totalValues += 1;
    if (totalValues > limits.maxTotalValues) throw codecError("decode.too-many-values", "Frame has too many JSON values.");
    if (depth > limits.maxDepth) throw codecError("decode.max-depth", `JSON exceeds depth ${limits.maxDepth}.`);
    if (typeof value === "string") {
      try {
        assertValidUnicode(value);
      } catch {
        throw codecError("decode.invalid-unicode", "JSON string contains an unpaired Unicode surrogate.");
      }
      if (new TextEncoder().encode(value).byteLength > limits.maxStringBytes) {
        throw codecError("decode.string-too-large", "JSON string exceeds the negotiated byte limit.");
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      if (value.length > limits.maxCollectionItems) throw codecError("decode.collection-too-large", "JSON array is too large.");
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const entries = Object.entries(value);
    if (entries.length > limits.maxObjectKeys) throw codecError("decode.object-too-wide", "JSON object has too many keys.");
    for (const [key, item] of entries) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) throw codecError("decode.forbidden-key", `Forbidden JSON object key: ${key}.`);
      try {
        assertValidUnicode(key);
      } catch {
        throw codecError("decode.invalid-unicode", "JSON object key contains an unpaired Unicode surrogate.");
      }
      visit(item, depth + 1);
    }
  };
  visit(input, 0);
}

function schemaProtocolError(code: string, message: string): ProtocolError {
  return new ProtocolError(createDiagnostic({
    phase: "decode",
    code,
    severity: "fatal",
    recoverable: false,
    modelCorrectable: false,
    message,
  }));
}

function codecError(code: string, message: string): ProtocolError {
  return new ProtocolError(createDiagnostic({
    phase: "decode",
    code,
    severity: "fatal",
    recoverable: false,
    modelCorrectable: false,
    message,
  }));
}

class JsonScanner {
  readonly #input: string;
  readonly #maxDepth: number;
  #index = 0;

  constructor(input: string, maxDepth: number) {
    this.#input = input;
    this.#maxDepth = maxDepth;
  }

  parse(): void {
    this.#skipWhitespace();
    this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.#input.length) this.#syntax("Unexpected trailing content.");
  }

  #parseValue(depth: number): void {
    if (depth > this.#maxDepth) throw codecError("decode.max-depth", `JSON exceeds depth ${this.#maxDepth}.`);
    const char = this.#input[this.#index];
    if (char === "{") return this.#parseObject(depth + 1);
    if (char === "[") return this.#parseArray(depth + 1);
    if (char === "\"") {
      this.#parseString();
      return;
    }
    if (char === "t") return this.#expect("true");
    if (char === "f") return this.#expect("false");
    if (char === "n") return this.#expect("null");
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return this.#parseNumber();
    this.#syntax("Expected a JSON value.");
  }

  #parseObject(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    const keys = new Set<string>();
    if (this.#input[this.#index] === "}") {
      this.#index += 1;
      return;
    }
    while (true) {
      if (this.#input[this.#index] !== "\"") this.#syntax("Expected an object key.");
      const key = this.#parseString();
      if (keys.has(key)) throw codecError("decode.duplicate-key", `Duplicate JSON object key: ${key}.`);
      if (FORBIDDEN_OBJECT_KEYS.has(key)) throw codecError("decode.forbidden-key", `Forbidden JSON object key: ${key}.`);
      keys.add(key);
      this.#skipWhitespace();
      this.#expect(":");
      this.#skipWhitespace();
      this.#parseValue(depth);
      this.#skipWhitespace();
      const delimiter = this.#input[this.#index];
      if (delimiter === "}") {
        this.#index += 1;
        return;
      }
      if (delimiter !== ",") this.#syntax("Expected ',' or '}' in object.");
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #parseArray(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#input[this.#index] === "]") {
      this.#index += 1;
      return;
    }
    while (true) {
      this.#parseValue(depth);
      this.#skipWhitespace();
      const delimiter = this.#input[this.#index];
      if (delimiter === "]") {
        this.#index += 1;
        return;
      }
      if (delimiter !== ",") this.#syntax("Expected ',' or ']' in array.");
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #parseString(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#input.length) {
      const char = this.#input[this.#index];
      if (char === "\"") {
        this.#index += 1;
        try {
          return JSON.parse(this.#input.slice(start, this.#index)) as string;
        } catch {
          this.#syntax("Invalid JSON string.");
        }
      }
      if (char === "\\") {
        this.#index += 1;
        const escape = this.#input[this.#index];
        if (escape === "u") {
          const hex = this.#input.slice(this.#index + 1, this.#index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.#syntax("Invalid Unicode escape.");
          this.#index += 5;
          continue;
        }
        if (!escape || !"\"\\/bfnrt".includes(escape)) this.#syntax("Invalid string escape.");
        this.#index += 1;
        continue;
      }
      if (char === undefined || char.charCodeAt(0) < 0x20) this.#syntax("Invalid control character in string.");
      this.#index += 1;
    }
    this.#syntax("Unterminated JSON string.");
  }

  #parseNumber(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.#input.slice(this.#index));
    if (!match) this.#syntax("Invalid JSON number.");
    this.#index += match[0].length;
  }

  #expect(value: string): void {
    if (!this.#input.startsWith(value, this.#index)) this.#syntax(`Expected '${value}'.`);
    this.#index += value.length;
  }

  #skipWhitespace(): void {
    while (this.#index < this.#input.length && /[\u0009\u000a\u000d\u0020]/.test(this.#input[this.#index]!)) {
      this.#index += 1;
    }
  }

  #syntax(message: string): never {
    throw codecError("decode.invalid-json", `${message} At character offset ${this.#index}.`);
  }
}
