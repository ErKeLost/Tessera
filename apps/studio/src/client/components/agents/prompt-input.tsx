"use client";
// beui.dev/components/agents/prompt-input

import { ArrowUp, Check, ChevronDown, Plus, ShieldCheck, Square } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type ClipboardEvent,
  type DragEvent,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/motion/button";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/motion/select";
import {
  Select as StudioSelect,
  SelectContent as StudioSelectContent,
  SelectItem as StudioSelectItem,
  SelectTrigger as StudioSelectTrigger,
  SelectValue as StudioSelectValue,
} from "@/components/ui/select";
import { SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export interface PromptModel {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface PromptAction {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export type PromptPermissionLevel = "allow" | "ask" | "deny";
export type PromptPermissionProfile = "normal" | "auto" | "dangerous";
export type PromptPermissions = Readonly<{
  profile: PromptPermissionProfile;
  sqlStatements: Readonly<Record<"read" | "write" | "destructive" | "unknown", PromptPermissionLevel>>;
}>;

export interface PromptInputProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "defaultValue" | "onChange" | "onSubmit" | "children"
> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  models?: PromptModel[];
  model?: string;
  defaultModel?: string;
  onModelChange?: (model: string) => void;
  actions?: PromptAction[];
  onAction?: (action: string) => void;
  onSubmit?: (value: string, model?: string) => void | Promise<void>;
  loading?: boolean;
  onStop?: () => void;
  minRows?: number;
  maxRows?: number;
  leadingAction?: ReactNode;
  trailingAction?: ReactNode;
  attachments?: ReactNode;
  hasAttachments?: boolean;
  onPasteFiles?: (files: File[]) => void | Promise<void>;
  onDropFiles?: (files: File[]) => void | Promise<void>;
  permissions?: PromptPermissions;
  onPermissionsChange?: (permissions: PromptPermissions) => void;
  className?: string;
}

export function PromptInput({
  value,
  defaultValue = "",
  onValueChange,
  models = [],
  model,
  defaultModel,
  onModelChange,
  actions = [],
  onAction,
  onSubmit,
  loading = false,
  onStop,
  minRows = 2,
  maxRows = 8,
  leadingAction,
  trailingAction,
  attachments,
  hasAttachments = false,
  onPasteFiles,
  onDropFiles,
  permissions,
  onPermissionsChange,
  className,
  disabled,
  placeholder = "Ask the agent to do something…",
  "aria-label": ariaLabel = "Prompt",
  onPaste: onTextareaPaste,
  onKeyDown,
  ...textareaProps
}: PromptInputProps) {
  const reduce = useReducedMotion() ?? false;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [internalModel, setInternalModel] = useState(
    defaultModel ?? models[0]?.value,
  );
  const [actionsOpen, setActionsOpen] = useState(false);
  const currentValue = value ?? internalValue;
  const currentModelValue = model ?? internalModel;
  const currentModel = models.find(
    (option) => option.value === currentModelValue,
  );
  const canSubmit = (Boolean(currentValue.trim()) || hasAttachments) && !disabled && !loading;

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    const measurement = measurementRef.current;
    if (!textarea || !measurement || textarea.value !== currentValue) return;

    const lineHeight = 24;
    const nextHeight = Math.min(
      Math.max(measurement.scrollHeight, minRows * lineHeight),
      maxRows * lineHeight,
    );
    const height = `${nextHeight}px`;
    if (textarea.style.height !== height) textarea.style.height = height;
  }, [currentValue, maxRows, minRows]);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [resizeTextarea]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeTextarea);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  const setValue = (next: string) => {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
  };

  const setModel = (next: string) => {
    if (model === undefined) setInternalModel(next);
    onModelChange?.(next);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = currentValue.trim();
    if ((!prompt && !hasAttachments) || disabled || loading) return;

    onSubmit?.(prompt, currentModelValue);
    if (value === undefined) setInternalValue("");
    textareaRef.current?.focus({ preventScroll: true });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    submit();
  };

  const readClipboardFiles = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const directFiles = Array.from(event.clipboardData?.files ?? []);
    if (directFiles.length > 0) return directFiles;
    return Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    onTextareaPaste?.(event);
    if (event.defaultPrevented || !onPasteFiles) return;
    const files = readClipboardFiles(event);
    if (files.length === 0) return;
    event.preventDefault();
    void onPasteFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!onDropFiles || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void onDropFiles(Array.from(event.dataTransfer.files));
  };

  const handleDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!onDropFiles || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  return (
    <form
      onSubmit={submit}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={cn(
        "relative w-full rounded-2xl border border-border/80 bg-background p-2 transition-colors focus-within:border-foreground/25",
        disabled && "opacity-60",
        className,
      )}
    >
      {attachments}
      <div
        ref={measurementRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-x-2 top-0 whitespace-pre-wrap px-2 text-sm leading-6 [overflow-wrap:break-word]"
      >
        {`${currentValue}\u200b`}
      </div>
      <textarea
        ref={textareaRef}
        value={currentValue}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        rows={minRows}
        {...textareaProps}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        className="scrollbar-hide block w-full resize-none overflow-y-auto bg-transparent px-2 pt-1.5 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/55"
      />

      <div className="mt-1 flex min-h-8 items-center gap-1">
        {actions.length ? (
          <MorphPopover open={actionsOpen} onOpenChange={setActionsOpen}>
            <MorphPopoverTrigger>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled || loading}
                aria-label="Add to prompt"
                className="size-8 rounded-full"
              >
                <motion.span
                  aria-hidden="true"
                  animate={{ rotate: actionsOpen ? 45 : 0 }}
                  transition={reduce ? { duration: 0 } : SPRING_SWAP}
                >
                  <Plus className="size-4" />
                </motion.span>
              </Button>
            </MorphPopoverTrigger>

            <MorphPopoverContent
              side="top"
              align="start"
              sideOffset={8}
              radius={12}
              className="w-56 p-1.5"
            >
              {actions.map((action) => (
                <button
                  key={action.value}
                  type="button"
                  disabled={action.disabled}
                  onClick={() => {
                    onAction?.(action.value);
                    setActionsOpen(false);
                  }}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  {action.icon ? (
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                      {action.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0">
                    <span className="block text-sm text-foreground">
                      {action.label}
                    </span>
                    {action.description ? (
                      <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                        {action.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </MorphPopoverContent>
          </MorphPopover>
        ) : null}
        {leadingAction}
        {models.length ? (
          <Select
            value={currentModelValue}
            onValueChange={setModel}
            disabled={disabled || loading}
            className="min-w-0"
          >
            <SelectTrigger className="studio-model-trigger h-8 w-auto max-w-52 rounded-xl border-0 bg-transparent px-2 py-0 text-xs hover:bg-muted focus-visible:ring-2">
              <span className="flex min-w-0 items-center gap-1.5">
                {currentModel?.icon ? (
                  <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&_svg]:size-3.5">
                    {currentModel.icon}
                  </span>
                ) : null}
                <span className="truncate text-muted-foreground">
                  {currentModel?.label ?? "Choose model"}
                </span>
              </span>
            </SelectTrigger>
            <SelectContent className="right-auto w-52 shadow-none">
              {models.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="py-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {option.icon ? (
                      <span className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                        {option.icon}
                      </span>
                    ) : null}
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {option.label}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <div className="flex shrink-0 items-center gap-1">
            <PermissionControl
              disabled={disabled || loading}
              onChange={onPermissionsChange}
              value={permissions}
            />

            {trailingAction}
          </div>

          <Button
            type={loading ? "button" : "submit"}
            size="icon"
            disabled={loading ? !onStop : !canSubmit}
            aria-label={loading ? "Stop generating" : "Send prompt"}
            onClick={loading ? onStop : undefined}
            className="size-8 rounded-full"
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={loading ? "stop" : "send"}
                initial={reduce ? { opacity: 1 } : { opacity: 0, y: 3, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.8 }}
                transition={reduce ? { duration: 0 } : SPRING_SWAP}
                className="grid place-items-center"
              >
                {loading ? (
                  <Square className="size-3 fill-current" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </motion.span>
            </AnimatePresence>
          </Button>
        </div>
      </div>
    </form>
  );
}

const permissionClasses = [
  ["read", "Read"],
  ["write", "Write"],
  ["destructive", "Destructive"],
  ["unknown", "Unknown"],
] as const;
const permissionProfiles = [
  ["normal", "Normal"],
  ["auto", "Auto"],
  ["dangerous", "Dangerous"],
] as const;

function PermissionControl({
  value,
  onChange,
  disabled,
}: {
  value?: PromptPermissions;
  onChange?: (permissions: PromptPermissions) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<PromptPermissions | undefined>(value);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    if (value !== undefined) setCurrent(value);
  }, [value]);

  const load = useCallback(async () => {
    setNotice(undefined);
    try {
      const response = await fetch("/api/settings", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("permissions_load_failed");
      const body = await response.json() as unknown;
      const parsed = readPromptPermissions(body);
      if (parsed) setCurrent(parsed);
    } catch {
      setNotice("Unable to load permissions");
    }
  }, []);

  const update = (key: keyof PromptPermissions["sqlStatements"], permission: PromptPermissionLevel) => {
    setCurrent((previous) => previous === undefined ? previous : {
      ...previous,
      sqlStatements: { ...previous.sqlStatements, [key]: permission },
    });
  };

  const save = async () => {
    if (!current) return;
    setSaving(true);
    setNotice(undefined);
    try {
      const response = await fetch("/api/settings/permissions", {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(current),
      });
      if (!response.ok) throw new Error("permissions_save_failed");
      const body = await response.json() as unknown;
      const saved = readPromptPermissions(body) ?? current;
      setCurrent(saved);
      onChange?.(saved);
      setOpen(false);
    } catch {
      setNotice("Permissions could not be saved");
    } finally {
      setSaving(false);
    }
  };

  return (
    <MorphPopover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) void load();
    }}>
      <MorphPopoverTrigger>
        <Button
          aria-label="Configure database permissions"
          className="size-8 rounded-full text-muted-foreground hover:text-foreground"
          disabled={disabled}
          size="icon"
          type="button"
          variant="ghost"
          title="Database permissions"
        >
          <ShieldCheck className="size-4" />
        </Button>
      </MorphPopoverTrigger>
      <MorphPopoverContent side="top" align="end" sideOffset={8} radius={10} className="studio-permissions-popover p-0">
        <section className="studio-permissions-panel" aria-label="Database permissions">
          <header className="studio-permissions-header">
            <div>
              <p>Data access</p>
              <h2>Database permissions</h2>
            </div>
            <StudioSelect
              disabled={!current || saving}
              onValueChange={(profile) => setCurrent((previous) => previous && {
                ...previous,
                profile: profile as PromptPermissionProfile,
              })}
              value={current?.profile ?? "normal"}
            >
              <StudioSelectTrigger aria-label="Permission profile" className="studio-permissions-profile" size="sm"><StudioSelectValue /></StudioSelectTrigger>
              <StudioSelectContent className="studio-permissions-select-content" position="popper">
                {permissionProfiles.map(([profile, label]) => <StudioSelectItem key={profile} value={profile}>{label}</StudioSelectItem>)}
              </StudioSelectContent>
            </StudioSelect>
          </header>
          <div className="studio-permissions-rules">
            {permissionClasses.map(([key, label]) => (
              <div className="studio-permissions-rule" key={key}>
                <span>{label} SQL</span>
                <StudioSelect
                  aria-label={`${label} SQL permission`}
                  disabled={!current || saving}
                  onValueChange={(permission) => update(key, permission as PromptPermissionLevel)}
                  value={current?.sqlStatements[key] ?? "ask"}
                >
                  <StudioSelectTrigger aria-label={`${label} SQL permission`} className="studio-permissions-rule-select" size="sm"><StudioSelectValue /></StudioSelectTrigger>
                  <StudioSelectContent className="studio-permissions-select-content" position="popper">
                    <StudioSelectItem value="allow">Allow</StudioSelectItem>
                    <StudioSelectItem value="ask">Ask</StudioSelectItem>
                    <StudioSelectItem value="deny">Deny</StudioSelectItem>
                  </StudioSelectContent>
                </StudioSelect>
              </div>
            ))}
          </div>
          {notice ? <p className="studio-permissions-notice" role="alert">{notice}</p> : null}
          <footer className="studio-permissions-footer">
            <Button disabled={!current || saving} onClick={() => void save()} size="sm" type="button">
              {saving ? "Saving..." : <><Check className="size-3.5" />Save permissions</>}
            </Button>
          </footer>
        </section>
      </MorphPopoverContent>
    </MorphPopover>
  );
}

function readPromptPermissions(value: unknown): PromptPermissions | undefined {
  const root = value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const source = root?.settings && typeof root.settings === "object" ? root.settings as Record<string, unknown> : root;
  const permissions = source?.permissions && typeof source.permissions === "object" ? source.permissions as Record<string, unknown> : undefined;
  const sql = permissions?.sqlStatements && typeof permissions.sqlStatements === "object" ? permissions.sqlStatements as Record<string, unknown> : undefined;
  if (!permissions || !sql || !isPromptProfile(permissions.profile)) return undefined;
  if (!["read", "write", "destructive", "unknown"].every((key) => isPromptLevel(sql[key]))) return undefined;
  return {
    profile: permissions.profile,
    sqlStatements: {
      read: sql.read as PromptPermissionLevel,
      write: sql.write as PromptPermissionLevel,
      destructive: sql.destructive as PromptPermissionLevel,
      unknown: sql.unknown as PromptPermissionLevel,
    },
  };
}

function isPromptProfile(value: unknown): value is PromptPermissionProfile {
  return value === "normal" || value === "auto" || value === "dangerous";
}

function isPromptLevel(value: unknown): value is PromptPermissionLevel {
  return value === "allow" || value === "ask" || value === "deny";
}
