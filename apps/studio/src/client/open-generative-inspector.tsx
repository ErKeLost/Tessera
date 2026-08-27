"use client";

import {
  BracesIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleDotIcon,
  CircleXIcon,
  CopyIcon,
  FileCode2Icon,
  LoaderCircleIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  WrapTextIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { StudioLoading } from "./components/studio-loading";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { cn } from "./lib/utils";
import {
  fetchStudioOpenGenerativeInspection,
  publicError,
  type StudioOpenGenerativeInspection,
} from "./api/studio-api";

export const OPEN_GENERATIVE_INSPECTOR_TABS = Object.freeze([
  Object.freeze({ label: "OGL", value: "ogl" }),
  Object.freeze({ label: "AST", value: "ast" }),
  Object.freeze({ label: "Catalog Slice", value: "catalog" }),
  Object.freeze({ label: "Resource authorization", value: "resources" }),
  Object.freeze({ label: "Events", value: "events" }),
  Object.freeze({ label: "Action receipts", value: "receipts" }),
  Object.freeze({ label: "Rejections", value: "rejections" }),
] as const);

const INSPECTOR_SUMMARY_ITEMS = Object.freeze([
  Object.freeze({ key: "oglLines", label: "OGL lines" }),
  Object.freeze({ key: "components", label: "Components" }),
  Object.freeze({ key: "resources", label: "Resources" }),
  Object.freeze({ key: "events", label: "Events" }),
  Object.freeze({ key: "receipts", label: "Receipts" }),
  Object.freeze({ key: "rejections", label: "Rejections" }),
] as const);
type InspectorTab = typeof OPEN_GENERATIVE_INSPECTOR_TABS[number]["value"];
type InspectorState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; inspection: StudioOpenGenerativeInspection }>
  | Readonly<{ status: "error"; message: string }>;
type CopyState = "idle" | "copied" | "error";

export type OpenGenerativeInspectorStatus = "captured" | "committed" | "rejected";

export type OpenGenerativeInspectorSection = Readonly<{
  count: number;
  countLabel: string;
  emptyMessage: string;
  truncated?: boolean;
  value: unknown;
}>;

export type OpenGenerativeInspectorSummary = Readonly<{
  status: OpenGenerativeInspectorStatus;
  oglLines: number;
  components: number;
  resources: number;
  events: number;
  receipts: number;
  rejections: number;
}>;

export function openGenerativeInspectorSections(
  inspection: StudioOpenGenerativeInspection,
): Readonly<Record<InspectorTab, OpenGenerativeInspectorSection>> {
  const { snapshot } = inspection;
  const oglLines = countSourceLines(snapshot.ogl.source);
  return Object.freeze({
    ogl: Object.freeze({
      value: snapshot.ogl.source,
      count: oglLines,
      countLabel: oglLines === 1 ? "line" : "lines",
      emptyMessage: "OGL source was not captured.",
      ...(snapshot.ogl.truncated === true ? { truncated: true } : {}),
    }),
    ast: Object.freeze({
      value: snapshot.ogl.ast,
      count: arrayLength(snapshot.ogl.ast),
      countLabel: "statements",
      emptyMessage: "AST was not captured.",
    }),
    catalog: Object.freeze({
      value: snapshot.catalog,
      count: arrayPropertyLength(snapshot.catalog, "components"),
      countLabel: "components",
      emptyMessage: "No Catalog Slice was captured.",
    }),
    resources: Object.freeze({
      value: snapshot.resourceAuthorizations,
      count: snapshot.resourceAuthorizations.length,
      countLabel: "decisions",
      emptyMessage: "No resource authorization decisions were recorded.",
    }),
    events: Object.freeze({
      value: snapshot.events,
      count: snapshot.events.length,
      countLabel: "events",
      emptyMessage: "No Surface events were recorded.",
    }),
    receipts: Object.freeze({
      value: snapshot.receipts,
      count: snapshot.receipts.length,
      countLabel: "receipts",
      emptyMessage: "No action receipts were recorded.",
    }),
    rejections: Object.freeze({
      value: snapshot.rejections,
      count: snapshot.rejections.length,
      countLabel: "rejections",
      emptyMessage: "No rejections were recorded.",
    }),
  });
}

export function openGenerativeInspectorSummary(
  inspection: StudioOpenGenerativeInspection,
): OpenGenerativeInspectorSummary {
  const sections = openGenerativeInspectorSections(inspection);
  const committed = inspection.snapshot.events.some((event) => event.type === "revision-committed");
  const rejected = !committed && (
    inspection.snapshot.rejections.length > 0
    || inspection.snapshot.events.some((event) => event.type === "rejected")
  );
  return Object.freeze({
    status: committed ? "committed" : rejected ? "rejected" : "captured",
    oglLines: sections.ogl.count,
    components: sections.catalog.count,
    resources: sections.resources.count,
    events: sections.events.count,
    receipts: sections.receipts.count,
    rejections: sections.rejections.count,
  });
}

export function OpenGenerativeInspector({
  hostDeployment,
  surfaceSessionId,
}: Readonly<{
  hostDeployment: "demo" | "production" | null;
  surfaceSessionId: string;
}>) {
  const [open, setOpen] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const [state, setState] = useState<InspectorState>({ status: "idle" });

  useEffect(() => {
    if (!open) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    void fetchStudioOpenGenerativeInspection(surfaceSessionId, controller.signal).then(
      (inspection) => setState({ status: "ready", inspection }),
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", message: publicError(error) });
      },
    );
    return () => controller.abort();
  }, [open, requestVersion, surfaceSessionId]);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <TooltipIconButton
          aria-label="Open Surface inspector"
          className="size-7 border bg-background text-muted-foreground shadow-(--shadow-whisper) hover:text-foreground"
          tooltip="Inspect generated surface"
          type="button"
        >
          <BracesIcon aria-hidden="true" />
        </TooltipIconButton>
      </DialogTrigger>
      <DialogContent className="flex max-h-[min(88dvh,52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(92vw,72rem)]">
        <InspectorTitleBar
          hostDeployment={hostDeployment}
          state={state}
          surfaceSessionId={surfaceSessionId}
        />
        <InspectorBody
          onRetry={() => setRequestVersion((current) => current + 1)}
          state={state}
        />
      </DialogContent>
    </Dialog>
  );
}

function InspectorTitleBar({
  hostDeployment,
  state,
  surfaceSessionId,
}: Readonly<{
  hostDeployment: "demo" | "production" | null;
  state: InspectorState;
  surfaceSessionId: string;
}>) {
  return (
    <DialogHeader className="shrink-0 gap-1 border-b px-4 py-3 pr-12 text-left">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <DialogTitle className="shrink-0 text-sm leading-5">Surface inspector</DialogTitle>
        <InspectorStatusBadge state={state} />
        {hostDeployment === null ? null : (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {hostDeployment}
          </span>
        )}
        <code
          aria-label={`Surface session ${surfaceSessionId}`}
          className="min-w-0 basis-full truncate font-mono text-[11px] text-muted-foreground sm:ml-auto sm:max-w-[48%] sm:basis-auto"
          title={surfaceSessionId}
        >
          {surfaceSessionId}
        </code>
      </div>
      <DialogDescription className="sr-only">
        Read-only Open Generative Host inspection data for this Surface session.
      </DialogDescription>
    </DialogHeader>
  );
}

function InspectorStatusBadge({ state }: Readonly<{ state: InspectorState }>) {
  if (state.status === "error") {
    return (
      <Badge variant="destructive">
        <CircleXIcon aria-hidden="true" />
        Error
      </Badge>
    );
  }
  if (state.status !== "ready") {
    return (
      <Badge variant="secondary">
        <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
        Loading
      </Badge>
    );
  }
  const status = openGenerativeInspectorSummary(state.inspection).status;
  if (status === "committed") {
    return (
      <Badge className="border-primary/30 bg-primary/10 text-primary" variant="outline">
        <CheckCircle2Icon aria-hidden="true" />
        Committed
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge variant="destructive">
        <CircleXIcon aria-hidden="true" />
        Rejected
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <CircleDotIcon aria-hidden="true" />
      Captured
    </Badge>
  );
}

function InspectorBody({
  onRetry,
  state,
}: Readonly<{
  onRetry: () => void;
  state: InspectorState;
}>) {
  if (state.status === "idle" || state.status === "loading") {
    return (
      <StudioLoading
        className="open-generative-inspector-loading"
        label="Loading inspection"
      />
    );
  }
  if (state.status === "error") {
    return <InspectorError message={state.message} onRetry={onRetry} />;
  }
  return <OpenGenerativeInspectionView inspection={state.inspection} />;
}

function InspectorError({
  message,
  onRetry,
}: Readonly<{
  message: string;
  onRetry: () => void;
}>) {
  return (
    <div className="p-4 sm:p-6">
      <Alert className="bg-transparent" variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        <AlertTitle>Inspection unavailable</AlertTitle>
        <AlertDescription>
          <p className="break-words">{message}</p>
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            <RefreshCwIcon aria-hidden="true" />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

export function OpenGenerativeInspectionView({
  inspection,
}: Readonly<{ inspection: StudioOpenGenerativeInspection }>) {
  const sections = useMemo(() => openGenerativeInspectorSections(inspection), [inspection]);
  const summary = useMemo(() => openGenerativeInspectorSummary(inspection), [inspection]);
  return (
    <div className="min-h-0">
      <InspectorSummary summary={summary} />
      <Tabs className="min-h-0 gap-0" defaultValue="ogl">
        <div className="shrink-0 overflow-x-auto border-b px-2 sm:px-4">
          <TabsList className="h-10 min-w-max rounded-none p-0" variant="line">
            {OPEN_GENERATIVE_INSPECTOR_TABS.map((tab) => (
              <TabsTrigger className="gap-1.5 px-2.5 text-xs" key={tab.value} value={tab.value}>
                <span>{tab.label}</span>
                <span className="min-w-5 rounded-sm bg-muted px-1 font-mono text-[10px] leading-4 tabular-nums text-muted-foreground">
                  {sections[tab.value].count}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {OPEN_GENERATIVE_INSPECTOR_TABS.map((tab) => (
          <TabsContent
            className="m-0 min-h-0 overflow-hidden data-[state=inactive]:hidden"
            key={tab.value}
            value={tab.value}
          >
            <InspectionValue section={sections[tab.value]} tab={tab} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function InspectorSummary({ summary }: Readonly<{ summary: OpenGenerativeInspectorSummary }>) {
  return (
    <div className="overflow-x-auto border-b bg-muted/20">
      <dl className="grid min-w-[39rem] grid-cols-6 divide-x">
        {INSPECTOR_SUMMARY_ITEMS.map((item) => (
          <div className="px-3 py-2" key={item.key}>
            <dt className="truncate text-[11px] text-muted-foreground">{item.label}</dt>
            <dd className="font-mono text-sm font-medium tabular-nums text-foreground">
              {summary[item.key]}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function InspectionValue({
  section,
  tab,
}: Readonly<{
  section: OpenGenerativeInspectorSection;
  tab: typeof OPEN_GENERATIVE_INSPECTOR_TABS[number];
}>) {
  const [wrap, setWrap] = useState(true);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  if (isEmptyInspectionValue(section.value)) {
    return <InspectorEmpty message={section.emptyMessage} />;
  }
  const formatted = typeof section.value === "string"
    ? section.value
    : JSON.stringify(section.value, null, 2) ?? "";
  const copyLabel = copyState === "copied"
    ? "Copied"
    : copyState === "error" ? "Copy failed" : `Copy ${tab.label}`;
  const wrapLabel = wrap ? "Disable line wrapping" : "Wrap long lines";

  const copy = () => {
    void copyInspectionValue(formatted).then(
      () => setCopyState("copied"),
      () => setCopyState("error"),
    );
  };

  return (
    <section aria-label={`${tab.label} inspection`} className="min-h-0">
      <header className="flex h-9 min-w-0 items-center justify-between gap-3 border-b bg-muted/20 px-3">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="truncate font-medium text-foreground">{tab.label}</span>
          <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
            {section.count} {section.countLabel}
          </span>
          {section.truncated ? <Badge variant="outline">Truncated</Badge> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <TooltipIconButton
            aria-label={wrapLabel}
            aria-pressed={wrap}
            className={cn("size-7", wrap && "bg-accent text-accent-foreground")}
            onClick={() => setWrap((current) => !current)}
            tooltip={wrapLabel}
            type="button"
          >
            <WrapTextIcon aria-hidden="true" />
          </TooltipIconButton>
          <TooltipIconButton
            aria-label={copyLabel}
            className="size-7"
            onClick={copy}
            tooltip={copyLabel}
            type="button"
          >
            {copyState === "copied" ? (
              <CheckIcon aria-hidden="true" />
            ) : copyState === "error" ? (
              <CircleXIcon aria-hidden="true" />
            ) : (
              <CopyIcon aria-hidden="true" />
            )}
          </TooltipIconButton>
          <span aria-live="polite" className="sr-only">
            {copyState === "copied" ? "Copied to clipboard" : copyState === "error" ? "Copy failed" : ""}
          </span>
        </div>
      </header>
      <div className="max-h-[min(56dvh,34rem)] min-h-0 overflow-auto bg-surface-sunken/50">
        {tab.value === "ogl" ? (
          <OglSource source={formatted} wrap={wrap} />
        ) : (
          <pre className={cn(
            "min-w-full p-4 font-mono text-xs leading-5 text-foreground",
            wrap
              ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
              : "w-max whitespace-pre",
          )}>
            <code>{formatted}</code>
          </pre>
        )}
      </div>
    </section>
  );
}

function OglSource({ source, wrap }: Readonly<{ source: string; wrap: boolean }>) {
  const lines = sourceLines(source);
  return (
    <ol aria-label="OGL source" className={cn(
      "min-w-full py-3 font-mono text-xs leading-5 text-foreground",
      wrap ? "" : "w-max",
    )}>
      {lines.map((line, index) => (
        <li className="flex min-w-full items-start" key={index}>
          <span
            aria-hidden="true"
            className="sticky left-0 w-12 shrink-0 select-none border-r bg-surface-sunken/95 px-3 text-right tabular-nums text-muted-foreground/70"
          >
            {index + 1}
          </span>
          <code className={cn(
            "block min-w-0 flex-1 px-4",
            wrap
              ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
              : "whitespace-pre",
          )}>
            {line.length === 0 ? " " : line}
          </code>
        </li>
      ))}
    </ol>
  );
}

function InspectorEmpty({ message }: Readonly<{ message: string }>) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-6 py-8 text-center" role="status">
      <div className="flex size-9 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground">
        <FileCode2Icon aria-hidden="true" className="size-4" />
      </div>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

async function copyInspectionValue(value: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard?.writeText === undefined) {
    throw new Error("Clipboard access is unavailable.");
  }
  await navigator.clipboard.writeText(value);
}

function countSourceLines(source: string | undefined): number {
  return source === undefined || source.trim().length === 0 ? 0 : sourceLines(source).length;
}

function sourceLines(source: string): readonly string[] {
  const normalized = source.replace(/\r\n?/gu, "\n");
  const displaySource = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return displaySource.length === 0 ? [] : displaySource.split("\n");
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function arrayPropertyLength(value: unknown, property: string): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return 0;
  return arrayLength((value as Readonly<Record<string, unknown>>)[property]);
}

function isEmptyInspectionValue(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === "string" && value.trim().length === 0)
    || (Array.isArray(value) && value.length === 0)
    || (
      typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).length === 0
    );
}
