"use client";

import {
  CheckIcon,
  DatabaseIcon,
  LoaderCircleIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  readStudioSettingsSnapshot,
  type StudioDatabaseAccessMode,
  type StudioDatabaseDialect,
  type StudioSettingsCandidate,
  type StudioSettingsSnapshot,
} from "../../studio-settings";
import { EASE_OUT } from "../../lib/ease";
import { Button } from "../motion/button";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "../motion/popover-morph";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

type SettingsTab = "connection" | "limits";
type RequestState = "idle" | "loading" | "testing" | "saving" | "success" | "error";

type DatabaseSettingsForm = {
  dialect: StudioDatabaseDialect;
  accessMode: StudioDatabaseAccessMode;
  databaseUrl: string;
  maxRows: string;
  timeoutMs: string;
  maxSteps: string;
};

const EMPTY_SETTINGS: StudioSettingsSnapshot = {
  database: { dialect: "postgres", accessMode: "read-only", urlConfigured: false },
  llm: {
    provider: "openrouter",
    model: "qwen/qwen3.8-27b",
    reasoningEffort: "low",
    apiKeyConfigured: false,
  },
  limits: { maxRows: 500, timeoutMs: 15_000, maxSteps: 50 },
  permissions: {
    profile: "normal",
    sqlStatements: { read: "allow", write: "ask", destructive: "ask", unknown: "ask" },
  },
};

export function DatabaseSettingsControl({
  disabled = false,
  onSaved,
}: {
  disabled?: boolean;
  onSaved?(): void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <MorphPopover onOpenChange={setOpen} open={open}>
      <MorphPopoverTrigger>
        <Button
          aria-label="Configure database connection and limits"
          className="studio-database-settings-trigger size-8 rounded-full text-muted-foreground hover:text-foreground"
          disabled={disabled}
          size="icon"
          title="Database connection and limits"
          type="button"
          variant="ghost"
        >
          <DatabaseIcon className="size-4" />
        </Button>
      </MorphPopoverTrigger>
      <MorphPopoverContent
        align="end"
        className="studio-database-settings-popover w-[min(23rem,calc(100dvw-1.5rem))] p-0"
        radius={14}
        side="top"
        sideOffset={10}
      >
        {open ? <DatabaseSettingsPanel onSaved={onSaved} /> : null}
      </MorphPopoverContent>
    </MorphPopover>
  );
}

function DatabaseSettingsPanel({ onSaved }: { onSaved?(): void }) {
  const reduce = useReducedMotion() ?? false;
  const [activeTab, setActiveTab] = useState<SettingsTab>("connection");
  const [settings, setSettings] = useState<StudioSettingsSnapshot>(EMPTY_SETTINGS);
  const [form, setForm] = useState<DatabaseSettingsForm>(() => toForm(EMPTY_SETTINGS));
  const [requestState, setRequestState] = useState<RequestState>("loading");
  const [notice, setNotice] = useState<string>();

  const loadSettings = useCallback(async (signal: AbortSignal) => {
    setRequestState("loading");
    setNotice(undefined);
    try {
      const response = await fetch("/api/settings", {
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error("settings_request_failed");
      const snapshot = readStudioSettingsSnapshot(await response.json());
      if (signal.aborted) return;
      setSettings(snapshot);
      setForm(toForm(snapshot));
      setRequestState("idle");
    } catch {
      if (signal.aborted) return;
      setRequestState("error");
      setNotice("Settings could not be loaded.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadSettings(controller.signal);
    return () => controller.abort();
  }, [loadSettings]);

  const candidate = useMemo(() => buildCandidate(form, settings), [form, settings]);
  const busy = requestState === "loading" || requestState === "testing" || requestState === "saving";
  const update = <Key extends keyof DatabaseSettingsForm>(key: Key, value: DatabaseSettingsForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setNotice(undefined);
    if (requestState === "error" || requestState === "success") setRequestState("idle");
  };

  const test = async () => {
    if (!candidate) {
      setRequestState("error");
      setNotice("Enter valid limits before testing this connection.");
      return;
    }
    setRequestState("testing");
    setNotice(undefined);
    try {
      const response = await fetch("/api/settings/test", requestInit(candidate, "POST"));
      if (!response.ok) throw new Error("settings_test_failed");
      setRequestState("success");
      setNotice("Connection test completed.");
    } catch {
      setRequestState("error");
      setNotice("Connection test did not complete.");
    }
  };

  const save = async () => {
    if (!candidate) {
      setRequestState("error");
      setNotice("Enter valid limits before saving.");
      return;
    }
    setRequestState("saving");
    setNotice(undefined);
    try {
      const response = await fetch("/api/settings", requestInit(candidate, "PUT"));
      if (!response.ok) throw new Error("settings_save_failed");
      const snapshot = readStudioSettingsSnapshot(await response.json());
      setSettings(snapshot);
      setForm(toForm(snapshot));
      setRequestState("success");
      setNotice("Connection settings saved.");
      onSaved?.();
    } catch {
      setRequestState("error");
      setNotice("Settings could not be saved.");
    }
  };

  return (
    <form
      className="studio-database-settings-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header className="studio-database-settings-header">
        <div>
          <p>Data source</p>
          <h2>Database connection</h2>
        </div>
        <span className={settings.database.urlConfigured ? "is-configured" : undefined}>
          {settings.database.urlConfigured ? "Configured" : "Not configured"}
        </span>
      </header>

      <div aria-label="Database settings sections" className="studio-database-settings-tabs" role="tablist">
        <SettingsTabButton active={activeTab === "connection"} icon={<DatabaseIcon />} label="Connection" onClick={() => setActiveTab("connection")} />
        <SettingsTabButton active={activeTab === "limits"} icon={<SlidersHorizontalIcon />} label="Limits" onClick={() => setActiveTab("limits")} />
      </div>

      <AnimatePresence initial={false} mode="wait">
        <motion.div
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, filter: "blur(0px)" }}
          className="studio-database-settings-body"
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, filter: "blur(2px)" }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6, filter: "blur(2px)" }}
          key={activeTab}
          transition={reduce ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }}
        >
          {activeTab === "connection" ? (
            <ConnectionFields busy={busy} form={form} configured={settings.database.urlConfigured} onChange={update} />
          ) : (
            <LimitFields busy={busy} form={form} onChange={update} />
          )}
        </motion.div>
      </AnimatePresence>

      {notice ? <p className={`studio-database-settings-notice is-${requestState}`} role="status">{notice}</p> : null}

      <footer className="studio-database-settings-footer">
        <Button disabled={busy || !candidate} onClick={() => void test()} size="sm" type="button" variant="outline">
          {requestState === "testing" ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
          Test
        </Button>
        <Button disabled={busy || !candidate} size="sm" type="submit">
          {requestState === "saving" ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
          Save
        </Button>
      </footer>
    </form>
  );
}

function SettingsTabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      aria-selected={active}
      className="studio-database-settings-tab"
      onClick={onClick}
      role="tab"
      type="button"
    >
      {icon}
      <span>{label}</span>
      {active ? <motion.span className="studio-database-settings-tab-indicator" layoutId="database-settings-tab-indicator" /> : null}
    </button>
  );
}

function ConnectionFields({
  busy,
  configured,
  form,
  onChange,
}: {
  busy: boolean;
  configured: boolean;
  form: DatabaseSettingsForm;
  onChange<Key extends keyof DatabaseSettingsForm>(key: Key, value: DatabaseSettingsForm[Key]): void;
}) {
  return (
    <div className="studio-database-settings-fields">
      <label>
        <span>Database engine</span>
        <select disabled={busy} onChange={(event) => onChange("dialect", event.target.value as StudioDatabaseDialect)} value={form.dialect}>
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL</option>
        </select>
      </label>
      <label>
        <span>Access mode</span>
        <select disabled={busy} onChange={(event) => onChange("accessMode", event.target.value as StudioDatabaseAccessMode)} value={form.accessMode}>
          <option value="read-only">Read-only</option>
          <option value="read-write">Read &amp; write</option>
        </select>
      </label>
      <label className="studio-database-settings-url">
        <span>Database URL</span>
        <Input
          autoComplete="off"
          disabled={busy}
          onChange={(event) => onChange("databaseUrl", event.target.value)}
          placeholder={configured ? "Configured locally" : "postgres:// or mysql://"}
          type="password"
          value={form.databaseUrl}
        />
      </label>
    </div>
  );
}

function LimitFields({
  busy,
  form,
  onChange,
}: {
  busy: boolean;
  form: DatabaseSettingsForm;
  onChange<Key extends keyof DatabaseSettingsForm>(key: Key, value: DatabaseSettingsForm[Key]): void;
}) {
  return (
    <div className="studio-database-settings-fields">
      <NumberInput busy={busy} label="Maximum rows" max={10_000} min={1} onChange={(value) => onChange("maxRows", value)} value={form.maxRows} />
      <NumberInput busy={busy} label="Timeout (ms)" max={120_000} min={250} onChange={(value) => onChange("timeoutMs", value)} value={form.timeoutMs} />
      <NumberInput busy={busy} label="Maximum steps" max={50} min={3} onChange={(value) => onChange("maxSteps", value)} value={form.maxSteps} />
    </div>
  );
}

function NumberInput({
  busy,
  label,
  max,
  min,
  onChange,
  value,
}: {
  busy: boolean;
  label: string;
  max: number;
  min: number;
  onChange(value: string): void;
  value: string;
}) {
  return (
    <label>
      <span>{label}</span>
      <Input disabled={busy} inputMode="numeric" max={max} min={min} onChange={(event) => onChange(event.target.value)} step={1} type="number" value={value} />
    </label>
  );
}

function toForm(settings: StudioSettingsSnapshot): DatabaseSettingsForm {
  return {
    dialect: settings.database.dialect,
    accessMode: settings.database.accessMode,
    databaseUrl: "",
    maxRows: String(settings.limits.maxRows),
    timeoutMs: String(settings.limits.timeoutMs),
    maxSteps: String(settings.limits.maxSteps),
  };
}

function buildCandidate(form: DatabaseSettingsForm, settings: StudioSettingsSnapshot): StudioSettingsCandidate | undefined {
  const maxRows = boundedInteger(form.maxRows, 1, 10_000);
  const timeoutMs = boundedInteger(form.timeoutMs, 250, 120_000);
  const maxSteps = boundedInteger(form.maxSteps, 3, 50);
  if (maxRows === undefined || timeoutMs === undefined || maxSteps === undefined) return undefined;
  const databaseUrl = form.databaseUrl.trim();
  return {
    database: {
      dialect: form.dialect,
      accessMode: form.accessMode,
      ...(databaseUrl ? { url: databaseUrl } : {}),
    },
    llm: {
      provider: settings.llm.provider,
      model: settings.llm.model,
      reasoningEffort: settings.llm.reasoningEffort,
      ...(settings.llm.baseUrl ? { baseUrl: settings.llm.baseUrl } : {}),
    },
    limits: { maxRows, timeoutMs, maxSteps },
  };
}

function requestInit(candidate: StudioSettingsCandidate, method: "POST" | "PUT"): RequestInit {
  return {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(candidate),
  };
}

function boundedInteger(value: string, min: number, max: number): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}
