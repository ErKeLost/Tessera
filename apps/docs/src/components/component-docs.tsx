"use client";

import {
  File,
  MultiFileDiff,
  type FileContents,
  type FileOptions,
} from "@pierre/diffs/react";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { useTheme } from "fumadocs-ui/provider/base";
import {
  CheckIcon,
  ClipboardIcon,
  Code2Icon,
  PackageIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";

type PreviewTab = "preview" | "code";
type InstallMethod = "renderer" | "contracts" | "manual";

const sourceOptions = {
  disableFileHeader: false,
  overflow: "scroll",
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system",
  unsafeCSS: `
    :host {
      --diffs-font-family: var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --diffs-header-font-family: var(--font-geist), ui-sans-serif, system-ui, sans-serif;
      --diffs-font-size: 12px;
      --diffs-line-height: 22px;
      display: block;
      min-width: 0;
      background: transparent;
    }

    [data-diffs-header="default"] {
      min-height: 38px;
      border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent);
      background: transparent;
    }

    pre {
      max-height: 560px;
      scrollbar-width: thin;
      background: transparent !important;
    }

    [data-column-number] { opacity: 0.58; }
  `,
} satisfies FileOptions<undefined>;

function useSourceOptions() {
  const { resolvedTheme } = useTheme();
  const themeType: "dark" | "light" =
    resolvedTheme === "dark" ? "dark" : "light";

  return useMemo(
    () => ({
      ...sourceOptions,
      themeType,
    }),
    [themeType],
  );
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function CopyButton({
  value,
  label = "Copy code",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const { locale } = useI18n();
  const copiedLabel = locale === "zh" ? "已复制" : "Copied";

  const copy = async () => {
    await copyText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      aria-label={copied ? copiedLabel : label}
      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => void copy()}
      title={copied ? copiedLabel : label}
      type="button"
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-3.5 text-primary" />
      ) : (
        <ClipboardIcon aria-hidden="true" className="size-3.5" />
      )}
    </button>
  );
}

function SourceCode({
  code,
  label = "example.tsx",
}: {
  code: string;
  label?: string;
}) {
  const contents = code.trim();
  const file = useMemo<FileContents>(
    () => ({ contents, name: label }),
    [contents, label],
  );
  const { locale } = useI18n();
  const options = useSourceOptions();

  return (
    <div className="de-source-code relative min-w-0 bg-background">
      <div className="absolute right-2 top-1 z-10">
        <CopyButton
          label={locale === "zh" ? "复制源代码" : "Copy source code"}
          value={contents}
        />
      </div>
      <File
        className="block min-w-0"
        disableWorkerPool
        file={file}
        options={options}
      />
    </div>
  );
}

export function ComponentPreview({
  children,
  code,
  filename = "component-example.tsx",
}: {
  children: ReactNode;
  code: string;
  filename?: string;
}) {
  const [tab, setTab] = useState<PreviewTab>("preview");
  const id = useId();
  const { locale } = useI18n();
  const chinese = locale === "zh";
  const tabs: Array<{
    label: string;
    value: PreviewTab;
    icon: typeof WrenchIcon;
  }> = [
    { label: chinese ? "预览" : "Preview", value: "preview", icon: WrenchIcon },
    { label: chinese ? "代码" : "Code", value: "code", icon: Code2Icon },
  ];

  return (
    <div className="de-component-preview not-prose my-7">
      <div
        aria-label={chinese ? "组件示例" : "Component example"}
        className="mb-2 flex h-8 items-center justify-between px-1"
        role="tablist"
      >
        <div className="flex h-full items-center gap-0.5">
          {tabs.map(({ icon: Icon, label, value }) => (
            <button
              aria-controls={`${id}-${value}`}
              aria-selected={tab === value}
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[active=true]:bg-muted data-[active=true]:text-foreground"
              data-active={tab === value}
              id={`${id}-${value}-tab`}
              key={value}
              onClick={() => setTab(value)}
              role="tab"
              type="button"
            >
              <Icon aria-hidden="true" className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
        <span className="hidden pr-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground sm:inline">
          {chinese ? "交互式示例" : "Interactive example"}
        </span>
      </div>

      <div
        aria-labelledby={`${id}-preview-tab`}
        className={tab === "preview" ? "block" : "hidden"}
        id={`${id}-preview`}
        role="tabpanel"
      >
        <div className="flex items-center justify-center overflow-hidden rounded-[24px] bg-foreground/[0.025] p-6 dark:bg-foreground/[0.04] md:p-10">
          <div className="mx-auto w-full max-w-[48rem]">{children}</div>
        </div>
      </div>
      <div
        aria-labelledby={`${id}-code-tab`}
        className={tab === "code" ? "block" : "hidden"}
        id={`${id}-code`}
        role="tabpanel"
      >
        <SourceCode code={code} label={filename} />
      </div>
    </div>
  );
}

function getVerificationCommands() {
  return {
    renderer: "bun --cwd packages/ui typecheck",
    contracts: "bun --cwd packages/components test",
  };
}

function ManualInstall({ name, source }: { name: string; source: string }) {
  const manualSource = source.trim();
  const { locale } = useI18n();
  const chinese = locale === "zh";
  return (
    <div className="grid gap-3 p-3">
      <div className="flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
        <p>
          {chinese
            ? "这是固定 Artifact 方案的历史源码，仅用于设计审查，不是当前 Component Contract 实现。"
            : "This is historical source for the fixed Artifact design, not the current Component Contract implementation."}
        </p>
        <CopyButton
          label={chinese ? "复制历史源码" : "Copy historical source"}
          value={manualSource}
        />
      </div>
      <SourceCode code={manualSource} label={`${name}.tsx`} />
    </div>
  );
}

export function InstallCommand({
  name,
  source,
}: {
  name: string;
  source?: string;
}) {
  const [method, setMethod] = useState<InstallMethod>("renderer");
  const id = useId();
  const { locale } = useI18n();
  const chinese = locale === "zh";
  const commands = getVerificationCommands();
  const methods: Array<{
    value: InstallMethod;
    label: string;
    icon: typeof PackageIcon;
  }> = [
    { value: "renderer", label: chinese ? "Renderer 源码" : "Renderer source", icon: PackageIcon },
    { value: "contracts", label: "Contract tests", icon: TerminalIcon },
    ...(source
      ? [
          {
            value: "manual" as const,
            label: chinese ? "手动" : "Manual",
            icon: Code2Icon,
          },
        ]
      : []),
  ];

  return (
    <div className="de-install-command not-prose my-6 overflow-hidden rounded-lg border border-border/80 bg-card ring-1 ring-foreground/[0.018]">
      <div
        aria-label={chinese ? "仓库验证方式" : "Repository verification"}
        className="flex min-h-12 items-center gap-1 overflow-x-auto border-b border-border/70 bg-muted/[0.13] px-2"
        role="tablist"
      >
        {methods.map(({ icon: Icon, label, value }) => (
          <button
            aria-controls={`${id}-${value}`}
            aria-selected={method === value}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:ring-1 data-[active=true]:ring-border/70"
            data-active={method === value}
            id={`${id}-${value}-tab`}
            key={value}
            onClick={() => setMethod(value)}
            role="tab"
            type="button"
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {label}
          </button>
        ))}
      </div>

      {method === "manual" ? (
        <div
          aria-labelledby={`${id}-manual-tab`}
          id={`${id}-manual`}
          role="tabpanel"
        >
          <ManualInstall name={name} source={source!} />
        </div>
      ) : (
        <div
          aria-labelledby={`${id}-${method}-tab`}
          id={`${id}-${method}`}
          role="tabpanel"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border/70 bg-muted/[0.16] px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {method === "renderer" ? (
                <PackageIcon aria-hidden="true" className="size-3.5 shrink-0" />
              ) : (
                <TerminalIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0"
                />
              )}
              <span className="rounded-md bg-background px-2 py-0.5 font-mono text-[10px] font-medium text-foreground ring-1 ring-border/70">
                bun
              </span>
              <span className="truncate">
                {method === "renderer" ? "packages/ui" : "packages/components"}
              </span>
            </div>
            <CopyButton
              label={chinese ? "复制验证命令" : "Copy verification command"}
              value={commands[method]}
            />
          </div>
          <pre className="m-0 overflow-x-auto border-0 bg-background px-4 py-4 font-mono text-[13px] leading-6">
            <code>{commands[method]}</code>
          </pre>
          <p className="border-t border-border px-4 py-3 text-xs leading-5 text-muted-foreground">
            {method === "renderer"
              ? chinese
                ? "验证当前 Tessera Agent Generative UI Renderer 源码；本页固定 Artifact 不再单独安装。"
                : "Verifies the current Tessera Agent Generative UI renderers; this fixed Artifact is no longer installed separately."
              : chinese
                ? "验证生成当前 12 个 Component Contract 与 Chart Recipe 的 source of truth。"
                : "Verifies the source of truth for the current 12 Component Contracts and chart recipes."}
          </p>
        </div>
      )}
    </div>
  );
}

export function CodeExample({
  code,
  filename = "example.tsx",
}: {
  code: string;
  filename?: string;
}) {
  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border border-border/80 bg-card ring-1 ring-foreground/[0.018]">
      <SourceCode code={code} label={filename} />
    </div>
  );
}

export function CodeDiff({
  filename = "example.tsx",
  newCode,
  oldCode,
}: {
  filename?: string;
  newCode: string;
  oldCode: string;
}) {
  const oldFile = useMemo<FileContents>(
    () => ({ contents: oldCode.trim(), name: filename }),
    [filename, oldCode],
  );
  const newFile = useMemo<FileContents>(
    () => ({ contents: newCode.trim(), name: filename }),
    [filename, newCode],
  );
  const options = useSourceOptions();
  const diffOptions = useMemo(
    () => ({
      ...options,
      diffIndicators: "bars" as const,
      diffStyle: "split" as const,
    }),
    [options],
  );
  return (
    <div className="de-source-code not-prose my-6 min-w-0 overflow-hidden rounded-lg border border-border/80 bg-card ring-1 ring-foreground/[0.018]">
      <MultiFileDiff
        className="block min-w-0"
        disableWorkerPool
        newFile={newFile}
        oldFile={oldFile}
        options={diffOptions}
      />
    </div>
  );
}

export type ApiProperty = {
  name: string;
  type: string;
  defaultValue?: string;
  required?: boolean;
  description: string;
};

export function ApiReference({
  name,
  properties,
}: {
  name: string;
  properties: ApiProperty[];
}) {
  const { locale } = useI18n();
  const chinese = locale === "zh";
  return (
    <div className="not-prose my-6 overflow-hidden rounded-lg border border-border/80 bg-card ring-1 ring-foreground/[0.018]">
      <div className="flex items-center justify-between gap-4 border-b border-border/70 bg-muted/[0.13] px-4 py-3">
        <code className="text-sm font-semibold text-foreground">{`<${name} />`}</code>
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Props
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Prop</th>
              <th className="px-4 py-2.5 font-medium">
                {chinese ? "类型" : "Type"}
              </th>
              <th className="px-4 py-2.5 font-medium">
                {chinese ? "默认值" : "Default"}
              </th>
              <th className="px-4 py-2.5 font-medium">
                {chinese ? "说明" : "Description"}
              </th>
            </tr>
          </thead>
          <tbody>
            {properties.map((property) => (
              <tr
                className="border-b border-border align-top last:border-0"
                key={property.name}
              >
                <td className="px-4 py-3">
                  <code className="text-[13px] font-medium text-foreground">
                    {property.name}
                  </code>
                  {property.required && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground">
                      {chinese ? "必填" : "required"}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <code className="text-xs text-muted-foreground">
                    {property.type}
                  </code>
                </td>
                <td className="px-4 py-3">
                  <code className="text-xs text-muted-foreground">
                    {property.defaultValue ?? "-"}
                  </code>
                </td>
                <td className="max-w-sm px-4 py-3 leading-5 text-muted-foreground">
                  {property.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
