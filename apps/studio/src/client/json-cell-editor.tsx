import type { FileContents } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import { EditProvider, File } from "@pierre/diffs/react";
import {
  BracesIcon,
  CopyIcon,
  EyeIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  Minimize2Icon,
  Redo2Icon,
  SaveIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { Button } from "./components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { useStudioTheme } from "./studio-theme";

export const MAX_JSON_CELL_WRITE_CHARS = 8_192;

export type JsonDocumentAnalysis = Readonly<{
  compact: string;
  error?: string;
  syntaxValid: boolean;
  withinWriteLimit: boolean;
}>;

export type JsonCellSaveResult =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; error: string }>;

type JsonCellEditorProps = Readonly<{
  cacheKey: string;
  canEdit: boolean;
  columnName: string;
  incomplete: boolean;
  onSave: (json: string) => Promise<JsonCellSaveResult>;
  relationName: string;
  value: string;
}>;

export function JsonCellEditor({
  cacheKey,
  canEdit,
  columnName,
  incomplete,
  onSave,
  relationName,
  value,
}: JsonCellEditorProps) {
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [session, setSession] = useState(0);
  const [sessionCanEdit, setSessionCanEdit] = useState(canEdit);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const close = (force = false) => {
    if (submittingRef.current && !force) return;
    setOpen(false);
    setFullscreen(false);
    setSession((current) => current + 1);
  };

  const submit = async (json: string): Promise<JsonCellSaveResult> => {
    if (submittingRef.current) {
      return { accepted: false, error: "This JSON change is already being submitted." };
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await onSave(json);
      if (result.accepted) close(true);
      return result;
    } catch (error) {
      return { accepted: false, error: jsonSubmissionError(error) };
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setSessionCanEdit(canEdit);
          setOpen(true);
        }
        else close();
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          aria-label={`Open structured JSON value for ${columnName}`}
          className="table-editor-json-cell-trigger"
          tabIndex={-1}
          type="button"
        >
          <BracesIcon aria-hidden="true" size={13} strokeWidth={1.8} />
          <span>{value}</span>
        </button>
      </PopoverTrigger>
      {open ? (
        <JsonEditorSurface
          cacheKey={`${cacheKey}:${session}`}
          canEdit={sessionCanEdit}
          columnName={columnName}
          fullscreen={fullscreen}
          incomplete={incomplete}
          key={session}
          onClose={close}
          onFullscreenChange={setFullscreen}
          onSave={submit}
          relationName={relationName}
          submitting={submitting}
          value={value}
        />
      ) : null}
    </Popover>
  );
}

function JsonEditorSurface({
  cacheKey,
  canEdit,
  columnName,
  fullscreen,
  incomplete,
  onClose,
  onFullscreenChange,
  onSave,
  relationName,
  submitting,
  value,
}: Omit<JsonCellEditorProps, "cacheKey"> & Readonly<{
  cacheKey: string;
  fullscreen: boolean;
  onClose: () => void;
  onFullscreenChange: (fullscreen: boolean) => void;
  submitting: boolean;
}>) {
  const { resolvedTheme } = useStudioTheme();
  const initialText = useMemo(() => formatJsonDocument(value), [value]);
  const initialAnalysis = useMemo(() => analyzeJsonDocument(initialText), [initialText]);
  const initialCompact = initialAnalysis.syntaxValid ? initialAnalysis.compact : value;
  const [analysis, setAnalysis] = useState<JsonDocumentAnalysis>(initialAnalysis);
  const [history, setHistory] = useState({ canRedo: false, canUndo: false });
  const [copied, setCopied] = useState(false);
  const [fileSource, setFileSource] = useState(initialText);
  const [submissionError, setSubmissionError] = useState<string>();
  const editorRef = useRef<Editor<undefined> | null>(null);
  const draftRef = useRef(initialText);
  const editable = canEdit && !incomplete && initialAnalysis.syntaxValid;
  const dirty = analysis.syntaxValid && analysis.compact !== initialCompact;
  const file = useMemo<FileContents>(() => ({
    cacheKey,
    contents: fileSource,
    lang: "json",
    name: `${columnName}.json`,
  }), [cacheKey, columnName, fileSource]);
  const editorOptions = useMemo<EditorOptions<undefined>>(() => ({
    autoSurround: "default",
    historyMaxEntries: 100,
    matchBrackets: true,
    onAttach(editor) {
      editorRef.current = editor;
      setHistory({ canRedo: editor.canRedo, canUndo: editor.canUndo });
      window.requestAnimationFrame(() => editor.focus({ lineNumber: "first-visible" }));
    },
    onChange(nextFile) {
      draftRef.current = nextFile.contents;
      setAnalysis(analyzeJsonDocument(nextFile.contents));
      setSubmissionError(undefined);
      const editor = editorRef.current;
      setHistory({ canRedo: editor?.canRedo ?? false, canUndo: editor?.canUndo ?? false });
    },
    persistState: false,
  }), []);
  const fileOptions = useMemo(() => ({
    disableFileHeader: true,
    overflow: "wrap" as const,
    theme: { dark: "pierre-dark" as const, light: "pierre-light" as const },
    themeType: resolvedTheme,
    unsafeCSS: ":host { --diffs-bg: var(--background); --diffs-light-bg: var(--background); --diffs-dark-bg: var(--background); --diffs-light: var(--foreground); --diffs-dark: var(--foreground); --diffs-light-number: var(--muted-foreground); --diffs-dark-number: var(--muted-foreground); --diffs-font-family: var(--font-mono); --diffs-font-size: 12px; --diffs-line-height: 1.55; }",
  }), [resolvedTheme]);

  const copy = async () => {
    const text = editorRef.current?.getText() ?? draftRef.current;
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };

  const save = async () => {
    if (submitting) return;
    const currentText = editorRef.current?.getText() ?? draftRef.current;
    const current = analyzeJsonDocument(currentText);
    setAnalysis(current);
    if (!editable || !current.syntaxValid || !current.withinWriteLimit || current.compact === initialCompact) return;
    setFileSource(currentText);
    setSubmissionError(undefined);
    editorRef.current?.blur();
    const result = await onSave(current.compact);
    if (!result.accepted) setSubmissionError(result.error);
  };

  const readOnlyReason = incomplete
    ? "This preview was shortened, so Tessera will not write it back."
    : !canEdit
      ? "This value is read only under the current database policy."
      : !initialAnalysis.syntaxValid
        ? "The database preview did not contain a valid JSON document."
        : undefined;

  return (
    <PopoverContent
      align="start"
      aria-label={`${columnName} JSON editor`}
      className={`table-editor-json-popover${fullscreen ? " is-fullscreen" : ""}`}
      collisionPadding={12}
      aria-busy={submitting}
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        if (!submitting) onClose();
      }}
      side="bottom"
      sideOffset={6}
      role="dialog"
    >
      <header className="table-editor-json-header">
        <span className="table-editor-json-heading-icon" aria-hidden="true">
          <BracesIcon size={15} strokeWidth={1.8} />
        </span>
        <div>
          <strong>{columnName}</strong>
          <span>{relationName} / JSON</span>
        </div>
        {editable ? null : <span className="table-editor-json-readonly"><EyeIcon aria-hidden="true" size={12} /> Read only</span>}
      </header>

      <div aria-label={`${columnName} JSON document`} aria-readonly={!editable || submitting} className="table-editor-json-document" role="region">
        <EditProvider createEditor={createJsonEditor}>
          <File
            className="table-editor-json-code"
            edit={editable && !submitting}
            editorOptions={editorOptions}
            file={file}
            options={fileOptions}
          />
        </EditProvider>
      </div>

      <footer className="table-editor-json-footer">
        <div className="table-editor-json-status" aria-live="polite">
          {analysis.error || submissionError
            ? <span data-tone="error">{analysis.error ?? submissionError}</span>
            : readOnlyReason
              ? <span>{readOnlyReason}</span>
              : <span>{submitting ? "Submitting governed change..." : dirty ? "Unsaved changes" : "JSON is valid"}</span>}
        </div>
        <div className="table-editor-json-actions">
          {editable ? (
            <>
              <TooltipIconButton
                aria-label="Undo JSON edit"
                disabled={submitting || !history.canUndo}
                onClick={() => editorRef.current?.undo()}
                tooltip="Undo"
                type="button"
              >
                <Undo2Icon aria-hidden="true" size={14} />
              </TooltipIconButton>
              <TooltipIconButton
                aria-label="Redo JSON edit"
                disabled={submitting || !history.canRedo}
                onClick={() => editorRef.current?.redo()}
                tooltip="Redo"
                type="button"
              >
                <Redo2Icon aria-hidden="true" size={14} />
              </TooltipIconButton>
            </>
          ) : null}
          <TooltipIconButton aria-label="Copy JSON" onClick={() => void copy()} tooltip={copied ? "Copied" : "Copy JSON"} type="button">
            <CopyIcon aria-hidden="true" size={14} />
          </TooltipIconButton>
          <TooltipIconButton
            aria-label={fullscreen ? "Exit fullscreen JSON editor" : "Open fullscreen JSON editor"}
            disabled={submitting}
            onClick={() => onFullscreenChange(!fullscreen)}
            tooltip={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            type="button"
          >
            {fullscreen ? <Minimize2Icon aria-hidden="true" size={14} /> : <Maximize2Icon aria-hidden="true" size={14} />}
          </TooltipIconButton>
          <Button disabled={submitting} onClick={onClose} size="sm" type="button" variant="outline">
            <XIcon aria-hidden="true" size={14} />
            Cancel
          </Button>
          {editable ? (
            <Button disabled={submitting || !dirty || !analysis.withinWriteLimit} onClick={() => void save()} size="sm" type="button">
              {submitting ? <LoaderCircleIcon aria-hidden="true" className="spin" size={14} /> : <SaveIcon aria-hidden="true" size={14} />}
              {submitting ? "Saving" : "Save changes"}
            </Button>
          ) : null}
        </div>
      </footer>
    </PopoverContent>
  );
}

function createJsonEditor(options: EditorOptions<undefined>): Editor<undefined> {
  return new Editor(options);
}

export function isJsonColumnType(dataType: string): boolean {
  return /^(?:json|jsonb)$/iu.test(dataType.trim());
}

export function analyzeJsonDocument(source: string): JsonDocumentAnalysis {
  try {
    JSON.parse(source);
  } catch (error) {
    return {
      compact: "",
      error: jsonSyntaxError(error),
      syntaxValid: false,
      withinWriteLimit: false,
    };
  }

  const compact = formatJsonWhitespace(source, false);
  const withinWriteLimit = compact.length <= MAX_JSON_CELL_WRITE_CHARS;
  return {
    compact,
    ...(withinWriteLimit ? {} : { error: `JSON is ${compact.length.toLocaleString("en-US")} characters; the governed write limit is ${MAX_JSON_CELL_WRITE_CHARS.toLocaleString("en-US")}.` }),
    syntaxValid: true,
    withinWriteLimit,
  };
}

export function formatJsonDocument(source: string): string {
  const analysis = analyzeJsonDocument(source);
  return analysis.syntaxValid ? formatJsonWhitespace(source, true) : source;
}

function formatJsonWhitespace(source: string, pretty: boolean): string {
  let result = "";
  let depth = 0;
  let escaped = false;
  let inString = false;
  let previousToken = "";
  const indent = () => "  ".repeat(depth);

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      previousToken = character;
      continue;
    }
    if (/\s/u.test(character)) continue;
    if (character === "{" || character === "[") {
      result += character;
      depth += 1;
      const next = nextNonWhitespace(source, index + 1);
      if (pretty && next !== (character === "{" ? "}" : "]")) result += `\n${indent()}`;
      previousToken = character;
      continue;
    }
    if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
      if (pretty && previousToken !== (character === "}" ? "{" : "[")) result += `\n${indent()}`;
      result += character;
      previousToken = character;
      continue;
    }
    if (character === ",") {
      result += pretty ? `,\n${indent()}` : ",";
      previousToken = character;
      continue;
    }
    if (character === ":") {
      result += pretty ? ": " : ":";
      previousToken = character;
      continue;
    }
    result += character;
    previousToken = character;
  }
  return result;
}

function nextNonWhitespace(source: string, start: number): string | undefined {
  for (let index = start; index < source.length; index += 1) {
    if (!/\s/u.test(source[index]!)) return source[index];
  }
  return undefined;
}

function jsonSyntaxError(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "The JSON document is invalid.";
  return message ? `Invalid JSON: ${message}` : "The JSON document is invalid.";
}

function jsonSubmissionError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "Tessera could not submit this JSON change.";
}
