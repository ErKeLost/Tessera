"use client";

import {
  CheckIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Field, FieldGroup } from "./components/ui/field";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/ui/tabs";
import { ThinkingOrb } from "thinking-orbs";

export type StudioDatabaseDialect = "postgres" | "mysql";
export type StudioDatabaseAccessMode = "read-only" | "read-write";
export type StudioSettingsTab = "database" | "model" | "limits" | "permissions";
export type StudioReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "none";
export type StudioReasoningSelection = "default" | StudioReasoningEffort;
export type StudioPermissionProfile = "normal" | "auto" | "dangerous";
export type StudioPermissionLevel = "allow" | "ask" | "deny";
export type StudioPermissionClass = "read" | "write" | "destructive" | "unknown";
export type StudioPermissionSettings = Readonly<{
  profile: StudioPermissionProfile;
  sqlStatements: Readonly<Record<StudioPermissionClass, StudioPermissionLevel>>;
}>;

type StudioReasoningCapability = Readonly<{
  supportedEfforts: readonly StudioReasoningEffort[];
  defaultEffort?: StudioReasoningEffort;
  defaultEnabled: boolean;
  mandatory: boolean;
}>;

type StudioOpenRouterModelOption = Readonly<{
  id: string;
  name: string;
  family: string;
  reasoning?: StudioReasoningCapability;
}>;

type StudioOpenRouterModelCatalog = Readonly<{
  models: readonly StudioOpenRouterModelOption[];
}>;

/** Public settings state returned by GET /api/settings. Secret values are never present here. */
export type StudioSettingsSnapshot = Readonly<{
  database: Readonly<{
    dialect: StudioDatabaseDialect;
    accessMode: StudioDatabaseAccessMode;
    urlConfigured: boolean;
  }>;
  llm: Readonly<{
    provider: string;
    model: string;
    reasoningEffort: StudioReasoningSelection;
    baseUrl?: string;
    apiKeyConfigured: boolean;
  }>;
  limits: Readonly<{
    maxRows: number;
    timeoutMs: number;
    maxSteps: number;
  }>;
  permissions: StudioPermissionSettings;
}>;

/** Candidate settings sent to POST /api/settings/test and PUT /api/settings. */
export type StudioSettingsCandidate = Readonly<{
  database: Readonly<{
    dialect: StudioDatabaseDialect;
    accessMode: StudioDatabaseAccessMode;
    /** Omitted when the field is blank so a configured server URL is retained. */
    url?: string;
  }>;
  llm: Readonly<{
    provider: string;
    model: string;
    reasoningEffort: StudioReasoningSelection;
    /** Omitted when blank so an existing server key is retained. */
    apiKey?: string;
    baseUrl?: string;
  }>;
  limits: Readonly<{
    maxRows: number;
    timeoutMs: number;
    maxSteps: number;
  }>;
}>;

export type StudioSettingsDialogProps = Readonly<{
  initialTab?: StudioSettingsTab;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved?(settings: StudioSettingsSnapshot): void;
}>;

type SettingsForm = {
  dialect: StudioDatabaseDialect;
  accessMode: StudioDatabaseAccessMode;
  databaseUrl: string;
  provider: string;
  model: string;
  reasoningEffort: StudioReasoningSelection;
  apiKey: string;
  baseUrl: string;
  maxRows: string;
  timeoutMs: string;
  maxSteps: string;
  permissions: StudioPermissionSettings;
};

type RequestState = "idle" | "loading" | "testing" | "saving" | "success" | "error";

const DEFAULT_SETTINGS: StudioSettingsSnapshot = {
  database: {
    dialect: "postgres",
    accessMode: "read-only",
    urlConfigured: false,
  },
  llm: {
    provider: "openrouter",
    model: "qwen/qwen3.8-27b",
    reasoningEffort: "low",
    apiKeyConfigured: false,
  },
  limits: {
    maxRows: 500,
    timeoutMs: 15_000,
    maxSteps: 50,
  },
  permissions: {
    profile: "normal",
    sqlStatements: {
      read: "allow",
      write: "ask",
      destructive: "ask",
      unknown: "ask",
    },
  },
};

const PROVIDERS = ["openrouter", "openai", "anthropic", "google", "custom"] as const;
const DEFAULT_PROVIDER_BASE_URLS: Readonly<Record<string, string | undefined>> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};
const REASONING_EFFORTS = new Set<StudioReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max", "none"]);
const EMPTY_MODEL_CATALOG: StudioOpenRouterModelCatalog = { models: [] };

export function StudioSettingsDialog({
  initialTab = "database",
  open,
  onOpenChange,
  onSaved,
}: StudioSettingsDialogProps) {
  const [settings, setSettings] = useState<StudioSettingsSnapshot>(DEFAULT_SETTINGS);
  const [form, setForm] = useState<SettingsForm>(() => toForm(DEFAULT_SETTINGS));
  const [modelCatalog, setModelCatalog] = useState<StudioOpenRouterModelCatalog>(EMPTY_MODEL_CATALOG);
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [notice, setNotice] = useState<string>();
  const [activeTab, setActiveTab] = useState<StudioSettingsTab>("database");
  const loadAbortRef = useRef<AbortController | null>(null);
  const modelCatalogAbortRef = useRef<AbortController | null>(null);

  const loadSettings = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setRequestState("loading");
    setNotice(undefined);

    try {
      const response = await fetch("/api/settings", {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("settings_request_failed");
      const snapshot = readStudioSettingsSnapshot(await response.json());
      if (controller.signal.aborted) return;
      setSettings(snapshot);
      setForm(toForm(snapshot));
      setRequestState("idle");
    } catch {
      if (controller.signal.aborted) return;
      setRequestState("error");
      setNotice("Settings could not be loaded.");
    }
  }, []);

  const loadModelCatalog = useCallback(async () => {
    modelCatalogAbortRef.current?.abort();
    const controller = new AbortController();
    modelCatalogAbortRef.current = controller;
    try {
      const response = await fetch("/api/settings/models", {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("model_catalog_request_failed");
      const catalog = readModelCatalog(await response.json());
      if (!controller.signal.aborted) setModelCatalog(catalog);
    } catch {
      if (!controller.signal.aborted) setModelCatalog(EMPTY_MODEL_CATALOG);
    }
  }, []);

  const visible = open;

  useEffect(() => {
    if (open) setActiveTab(initialTab);
  }, [initialTab, open]);

  useEffect(() => {
    if (!visible) return;
    void loadSettings();
    void loadModelCatalog();
    return () => {
      loadAbortRef.current?.abort();
      modelCatalogAbortRef.current?.abort();
    };
  }, [loadModelCatalog, loadSettings, visible]);

  const providerOptions = useMemo(() => (
    PROVIDERS.includes(form.provider as (typeof PROVIDERS)[number])
      ? PROVIDERS
      : [...PROVIDERS, form.provider] as const
  ), [form.provider]);

  const modelOptions = useMemo(() => {
    if (form.provider !== "openrouter") return [];
    const currentModel = form.model.trim();
    if (!currentModel || modelCatalog.models.some((model) => model.id === currentModel)) return modelCatalog.models;
    return [{ id: currentModel, name: currentModel, family: "Current" }, ...modelCatalog.models];
  }, [form.model, form.provider, modelCatalog.models]);

  const selectedModel = useMemo(
    () => form.provider === "openrouter" ? modelOptions.find((model) => model.id === form.model.trim()) : undefined,
    [form.model, form.provider, modelOptions],
  );
  const reasoningCapability = selectedModel?.reasoning;
  const reasoningOptions = reasoningCapability?.supportedEfforts ?? [];

  useEffect(() => {
    if (modelCatalog.models.length === 0 || form.reasoningEffort === "default") return;
    if (reasoningOptions.includes(form.reasoningEffort)) return;
    setForm((current) => current.reasoningEffort === "default"
      ? current
      : { ...current, reasoningEffort: "default" });
  }, [form.reasoningEffort, modelCatalog.models.length, reasoningOptions]);

  const updateForm = useCallback(<Key extends keyof SettingsForm>(key: Key, value: SettingsForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setNotice(undefined);
    if (requestState === "success" || requestState === "error") setRequestState("idle");
  }, [requestState]);

  const updateProvider = useCallback((provider: string) => {
    setForm((current) => ({
      ...current,
      provider,
      baseUrl: current.baseUrl === (DEFAULT_PROVIDER_BASE_URLS[current.provider] ?? "")
        ? (DEFAULT_PROVIDER_BASE_URLS[provider] ?? "")
        : current.baseUrl,
      ...(provider === "openrouter" ? {} : { reasoningEffort: "default" as const }),
    }));
    setNotice(undefined);
    if (requestState === "success" || requestState === "error") setRequestState("idle");
  }, [requestState]);

  const updateOpenRouterModel = useCallback((model: string) => {
    const selected = modelOptions.find((candidate) => candidate.id === model);
    setForm((current) => ({
      ...current,
      provider: "openrouter",
      model,
      reasoningEffort: preferredReasoningSelection(selected?.reasoning, current.reasoningEffort),
    }));
    setNotice(undefined);
    if (requestState === "success" || requestState === "error") setRequestState("idle");
  }, [modelOptions, requestState]);

  const candidate = useMemo(() => buildCandidate(form), [form]);
  const busy = requestState === "loading" || requestState === "testing" || requestState === "saving";

  const testCandidate = useCallback(async () => {
    if (!candidate) {
      setRequestState("error");
      setNotice("Enter valid limits before testing this configuration.");
      return;
    }
    setRequestState("testing");
    setNotice(undefined);
    try {
      const target = activeTab === "model" ? "model" : "database";
      const response = await fetch(`/api/settings/test?target=${target}`, jsonRequest(candidate));
      if (!response.ok) {
        const failure = await response.json().catch(() => undefined) as unknown;
        throw new Error(readPublicErrorMessage(failure) ?? "settings_test_failed");
      }
      const result = await response.json().catch(() => undefined) as unknown;
      const message = readPublicMessage(result) ?? (target === "model"
        ? "OpenRouter returned a valid model response."
        : "Database connection verified.");
      setRequestState("success");
      setNotice(message);
    } catch (error) {
      setRequestState("error");
      setNotice(error instanceof Error && error.message !== "settings_test_failed"
        ? error.message
        : "Configuration test did not complete.");
    }
  }, [activeTab, candidate]);

  const saveCandidate = useCallback(async () => {
    if (!candidate) {
      setRequestState("error");
      setNotice("Enter valid limits before saving these settings.");
      return;
    }
    setRequestState("saving");
    setNotice(undefined);
    try {
      const response = await fetch("/api/settings", {
        ...jsonRequest(candidate),
        method: "PUT",
      });
      if (!response.ok) throw new Error("settings_save_failed");
      const body = await response.json().catch(() => undefined) as unknown;
      const saved = readStudioSettingsSnapshot(body);
      setSettings(saved);
      // Never retain values that might have been supplied as credentials.
      setForm((current) => ({ ...toForm(saved), databaseUrl: "", apiKey: "" }));
      setRequestState("success");
      setNotice(readPublicMessage(body) ?? "Settings saved.");
      onSaved?.(saved);
    } catch {
      setRequestState("error");
      setNotice("Settings could not be saved.");
    }
  }, [candidate, onSaved]);

  const savePermissions = useCallback(async () => {
    setRequestState("saving");
    setNotice(undefined);
    try {
      const response = await fetch("/api/settings/permissions", {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form.permissions),
      });
      if (!response.ok) throw new Error("permissions_save_failed");
      const body = await response.json().catch(() => undefined) as unknown;
      const saved = readStudioSettingsSnapshot(body);
      setSettings(saved);
      setForm((current) => ({ ...current, permissions: saved.permissions }));
      setRequestState("success");
      setNotice(readPublicMessage(body) ?? "Database permissions saved.");
      onSaved?.(saved);
    } catch {
      setRequestState("error");
      setNotice("Database permissions could not be saved.");
    }
  }, [form.permissions, onSaved]);

  const saveCurrentTab = useCallback(async () => {
    if (activeTab === "permissions") {
      await savePermissions();
      return;
    }
    await saveCandidate();
  }, [activeTab, saveCandidate, savePermissions]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    // Keep an in-flight connection test or save from being abandoned through
    // the overlay or Escape key. The dialog remains controlled by its parent.
    if (!nextOpen && busy) return;
    if (!nextOpen) {
      loadAbortRef.current?.abort();
      modelCatalogAbortRef.current?.abort();
      setForm((current) => ({ ...current, databaseUrl: "", apiKey: "" }));
      setRequestState("idle");
      setNotice(undefined);
    }
    onOpenChange(nextOpen);
  }, [busy, onOpenChange]);

  const canSave = activeTab === "permissions" ? true : Boolean(candidate);
  const testTarget = activeTab === "database" ? "database" : activeTab === "model" ? "model" : undefined;
  const canTest = Boolean(candidate) && (testTarget === "database"
    ? Boolean(form.databaseUrl.trim() || settings.database.urlConfigured)
    : testTarget === "model"
      ? form.provider === "openrouter" && Boolean(form.apiKey.trim() || settings.llm.apiKeyConfigured)
      : false);
  const settingsForm = (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void saveCurrentTab();
      }}
    >
      <DialogHeader>
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>
          Manage the local database, model, permissions, and execution settings.
        </DialogDescription>
      </DialogHeader>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as StudioSettingsTab)}
      >
        <TabsList className="w-full">
          <TabsTrigger value="database">Database</TabsTrigger>
          <TabsTrigger value="model">Model</TabsTrigger>
          <TabsTrigger value="limits">Limits</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
        </TabsList>

            <TabsContent value="database">
              <FieldGroup>
                <Field>
                  <Label htmlFor="settings-dialect">Database engine</Label>
                  <Select disabled={busy} onValueChange={(value) => updateForm("dialect", value as StudioDatabaseDialect)} value={form.dialect}>
                    <SelectTrigger className="w-full" id="settings-dialect"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="postgres">PostgreSQL</SelectItem>
                      <SelectItem value="mysql">MySQL</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <Label htmlFor="settings-access-mode">Access mode</Label>
                  <Select disabled={busy} onValueChange={(value) => updateForm("accessMode", value as StudioDatabaseAccessMode)} value={form.accessMode}>
                    <SelectTrigger className="w-full" id="settings-access-mode"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="read-only">Read-only</SelectItem>
                      <SelectItem value="read-write">Read &amp; write</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <Label htmlFor="settings-database-url">Database URL</Label>
                  <Input
                    autoComplete="off"
                    disabled={busy}
                    id="settings-database-url"
                    name="databaseUrl"
                    onChange={(event) => updateForm("databaseUrl", event.target.value)}
                    placeholder={settings.database.urlConfigured ? "Configured locally" : "postgres:// or mysql://"}
                    type="password"
                    value={form.databaseUrl}
                  />
                </Field>
              </FieldGroup>
            </TabsContent>

            <TabsContent value="model">
              <FieldGroup>
                <Field>
                  <Label htmlFor="settings-provider">Provider</Label>
                  <Select disabled={busy} onValueChange={updateProvider} value={form.provider}>
                    <SelectTrigger className="w-full" id="settings-provider"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {providerOptions.map((provider) => (
                        <SelectItem key={provider} value={provider}>{provider}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <Label htmlFor="settings-model">Model</Label>
                  {form.provider === "openrouter" ? (
                    <Select disabled={busy || modelOptions.length === 0} onValueChange={updateOpenRouterModel} value={form.model}>
                      <SelectTrigger className="w-full" id="settings-model"><SelectValue placeholder="Select a model" /></SelectTrigger>
                      <SelectContent>
                        {modelOptions.map((model) => (
                          <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      autoComplete="off"
                      disabled={busy}
                      id="settings-model"
                      name="model"
                      onChange={(event) => updateForm("model", event.target.value)}
                      placeholder="provider/model"
                      value={form.model}
                    />
                  )}
                </Field>
                {reasoningOptions.length > 0 ? (
                  <Field>
                    <Label htmlFor="settings-reasoning">Reasoning</Label>
                    <Select
                      disabled={busy}
                      onValueChange={(value) => updateForm("reasoningEffort", value as StudioReasoningSelection)}
                      value={reasoningOptions.includes(form.reasoningEffort as StudioReasoningEffort) ? form.reasoningEffort : "default"}
                    >
                      <SelectTrigger className="w-full" id="settings-reasoning"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Provider default</SelectItem>
                        {reasoningOptions.map((effort) => (
                          <SelectItem key={effort} value={effort}>{formatReasoningEffort(effort)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
                <Field>
                  <Label htmlFor="settings-api-key">API key</Label>
                  <Input
                    autoComplete="new-password"
                    disabled={busy}
                    id="settings-api-key"
                    name="apiKey"
                    onChange={(event) => updateForm("apiKey", event.target.value)}
                    placeholder={settings.llm.apiKeyConfigured ? "Configured locally" : "Optional provider key"}
                    type="password"
                    value={form.apiKey}
                  />
                </Field>
                <Field>
                  <Label htmlFor="settings-base-url">Base URL</Label>
                  <Input
                    autoComplete="off"
                    disabled={busy}
                    id="settings-base-url"
                    name="baseUrl"
                    onChange={(event) => updateForm("baseUrl", event.target.value)}
                    placeholder={DEFAULT_PROVIDER_BASE_URLS[form.provider] ?? "https://api.example.com/v1"}
                    type="url"
                    value={form.baseUrl}
                  />
                </Field>
              </FieldGroup>
            </TabsContent>

            <TabsContent value="limits">
              <FieldGroup>
                <NumberField disabled={busy} id="settings-max-rows" label="Maximum rows" max={10_000} min={1} onChange={(value) => updateForm("maxRows", value)} value={form.maxRows} />
                <NumberField disabled={busy} id="settings-timeout-ms" label="Timeout (ms)" max={120_000} min={250} onChange={(value) => updateForm("timeoutMs", value)} value={form.timeoutMs} />
                <NumberField disabled={busy} id="settings-max-steps" label="Maximum steps" max={50} min={3} onChange={(value) => updateForm("maxSteps", value)} value={form.maxSteps} />
              </FieldGroup>
            </TabsContent>

            <TabsContent value="permissions">
              <PermissionSettingsFields
                disabled={busy}
                onChange={(permissions) => {
                  setForm((current) => ({ ...current, permissions }));
                  setNotice(undefined);
                  if (requestState === "success" || requestState === "error") setRequestState("idle");
                }}
                value={form.permissions}
              />
            </TabsContent>
      </Tabs>

      <SettingsNotice notice={notice} state={requestState} />

      <DialogFooter>
        {testTarget ? (
          <Button disabled={busy || !canTest} onClick={() => void testCandidate()} type="button" variant="outline">
            {requestState === "testing" ? <ThinkingOrb aria-label={`Testing ${testTarget}`} size={20} state="connecting" theme="auto" /> : null}
            {testTarget === "model" ? "Test model" : "Test database"}
          </Button>
        ) : null}
        <DialogClose asChild>
          <Button disabled={busy} type="button" variant="outline">Cancel</Button>
        </DialogClose>
        <Button disabled={busy || !canSave} type="submit">
          {requestState === "saving" ? <ThinkingOrb aria-label="Saving local settings" size={20} state="composing" theme="auto" /> : null}
          Save changes
        </Button>
      </DialogFooter>
    </form>
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="tessera-settings-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl" showCloseButton={!busy}>
        {settingsForm}
      </DialogContent>
    </Dialog>
  );
}

function NumberField({
  disabled,
  id,
  label,
  max,
  min,
  onChange,
  value,
}: {
  disabled: boolean;
  id: string;
  label: string;
  max: number;
  min: number;
  onChange(value: string): void;
  value: string;
}) {
  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      <Input
        disabled={disabled}
        id={id}
        inputMode="numeric"
        max={max}
        min={min}
        onChange={(event) => onChange(event.target.value)}
        step={1}
        type="number"
        value={value}
      />
    </Field>
  );
}

const PERMISSION_CLASSES: ReadonlyArray<readonly [StudioPermissionClass, string]> = [
  ["read", "Read"],
  ["write", "Write"],
  ["destructive", "Destructive"],
  ["unknown", "Unknown"],
];

const PERMISSION_PROFILES: ReadonlyArray<readonly [StudioPermissionProfile, string]> = [
  ["normal", "Normal"],
  ["auto", "Auto"],
  ["dangerous", "Dangerous"],
];

const PERMISSION_LEVELS: ReadonlyArray<readonly [StudioPermissionLevel, string]> = [
  ["allow", "Allow"],
  ["ask", "Ask"],
  ["deny", "Deny"],
];

function PermissionSettingsFields({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange(value: StudioPermissionSettings): void;
  value: StudioPermissionSettings;
}) {
  return (
    <div className="grid gap-4">
      <FieldGroup>
        <Field>
          <Label htmlFor="settings-permission-profile">Permission profile</Label>
          <Select
            disabled={disabled}
            onValueChange={(profile) => onChange({ ...value, profile: profile as StudioPermissionProfile })}
            value={value.profile}
          >
            <SelectTrigger className="w-full" id="settings-permission-profile"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PERMISSION_PROFILES.map(([profile, label]) => (
                <SelectItem key={profile} value={profile}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {PERMISSION_CLASSES.map(([statementClass, label]) => (
          <Field key={statementClass}>
            <Label htmlFor={`settings-permission-${statementClass}`}>{label} actions</Label>
            <Select
              disabled={disabled}
              onValueChange={(permission) => onChange({
                ...value,
                sqlStatements: { ...value.sqlStatements, [statementClass]: permission as StudioPermissionLevel },
              })}
              value={value.sqlStatements[statementClass]}
            >
              <SelectTrigger className="w-full" id={`settings-permission-${statementClass}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {PERMISSION_LEVELS.map(([permission, permissionLabel]) => (
                  <SelectItem key={permission} value={permission}>{permissionLabel}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ))}
      </FieldGroup>
      <p className="text-xs leading-5 text-muted-foreground">
        Read actions can run automatically. Write and destructive actions follow the selected approval level.
      </p>
    </div>
  );
}

function SettingsNotice({ notice, state }: { notice: string | undefined; state: RequestState }) {
  const activeNotice = notice
    ?? (state === "loading" ? "Loading local settings..." : state === "testing" ? "Testing local connection..." : state === "saving" ? "Saving local settings..." : undefined);
  if (!activeNotice) return null;
  const Icon = state === "error" ? CircleAlertIcon : state === "success" ? CheckIcon : LoaderCircleIcon;
  const orbState = state === "testing" ? "connecting" : "composing";
  const isWorking = state === "loading" || state === "testing" || state === "saving";
  return (
    <p
      className={state === "error" ? "flex min-w-0 items-center gap-2 text-sm text-destructive" : "flex min-w-0 items-center gap-2 text-sm text-muted-foreground"}
      role={state === "error" ? "alert" : "status"}
    >
      {isWorking ? <ThinkingOrb aria-hidden="true" size={20} state={orbState} theme="auto" /> : <Icon aria-hidden="true" size={16} />}
      <span>{activeNotice}</span>
    </p>
  );
}

function toForm(settings: StudioSettingsSnapshot): SettingsForm {
  return {
    dialect: settings.database.dialect,
    accessMode: settings.database.accessMode,
    databaseUrl: "",
    provider: settings.llm.provider,
    model: settings.llm.model,
    reasoningEffort: settings.llm.reasoningEffort,
    apiKey: "",
    baseUrl: settings.llm.baseUrl ?? DEFAULT_PROVIDER_BASE_URLS[settings.llm.provider] ?? "",
    maxRows: String(settings.limits.maxRows),
    timeoutMs: String(settings.limits.timeoutMs),
    maxSteps: String(settings.limits.maxSteps),
    permissions: settings.permissions,
  };
}

function buildCandidate(form: SettingsForm): StudioSettingsCandidate | undefined {
  const maxRows = readBoundedInteger(form.maxRows, 1, 10_000);
  const timeoutMs = readBoundedInteger(form.timeoutMs, 250, 120_000);
  const maxSteps = readBoundedInteger(form.maxSteps, 3, 50);
  const provider = form.provider.trim();
  const model = form.model.trim();
  if (maxRows === undefined || timeoutMs === undefined || maxSteps === undefined || !provider || !model) return undefined;

  const databaseUrl = form.databaseUrl.trim();
  const apiKey = form.apiKey.trim();
  const baseUrl = form.baseUrl.trim();
  // The server remains authoritative, but reject obviously unsafe or malformed
  // provider endpoints before including them in a request.
  if (baseUrl && !readSafeUrl(baseUrl)) return undefined;
  return {
    database: {
      dialect: form.dialect,
      accessMode: form.accessMode,
      ...(databaseUrl ? { url: databaseUrl } : {}),
    },
    llm: {
      provider,
      model,
      reasoningEffort: form.reasoningEffort,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    },
    limits: { maxRows, timeoutMs, maxSteps },
  };
}

export function readStudioSettingsSnapshot(value: unknown): StudioSettingsSnapshot {
  const root = asRecord(value);
  const source = asRecord(root?.settings) ?? root;
  const database = asRecord(source?.database);
  const llm = asRecord(source?.llm);
  const limits = asRecord(source?.limits);
  const permissions = readPermissions(source?.permissions);
  const baseUrl = readSafeUrl(llm?.baseUrl);

  return {
    database: {
      dialect: readDialect(database?.dialect) ?? DEFAULT_SETTINGS.database.dialect,
      accessMode: readAccessMode(database?.accessMode) ?? DEFAULT_SETTINGS.database.accessMode,
      urlConfigured: database?.urlConfigured === true,
    },
    llm: {
      provider: readShortString(llm?.provider) ?? DEFAULT_SETTINGS.llm.provider,
      model: readShortString(llm?.model) ?? DEFAULT_SETTINGS.llm.model,
      reasoningEffort: readReasoningSelection(llm?.reasoningEffort) ?? DEFAULT_SETTINGS.llm.reasoningEffort,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      apiKeyConfigured: llm?.apiKeyConfigured === true,
    },
    limits: {
      maxRows: readBoundedInteger(limits?.maxRows, 1, 10_000) ?? DEFAULT_SETTINGS.limits.maxRows,
      timeoutMs: readBoundedInteger(limits?.timeoutMs, 250, 120_000) ?? DEFAULT_SETTINGS.limits.timeoutMs,
      maxSteps: readBoundedInteger(limits?.maxSteps, 3, 50) ?? DEFAULT_SETTINGS.limits.maxSteps,
    },
    permissions: permissions ?? DEFAULT_SETTINGS.permissions,
  };
}

function readPermissions(value: unknown): StudioPermissionSettings | undefined {
  const source = asRecord(value);
  const sqlStatements = asRecord(source?.sqlStatements);
  if (!source || !sqlStatements || !isPermissionProfile(source.profile)) return undefined;
  const statementClasses: StudioPermissionClass[] = ["read", "write", "destructive", "unknown"];
  if (!statementClasses.every((statementClass) => isPermissionLevel(sqlStatements[statementClass]))) return undefined;
  return {
    profile: source.profile,
    sqlStatements: {
      read: sqlStatements.read as StudioPermissionLevel,
      write: sqlStatements.write as StudioPermissionLevel,
      destructive: sqlStatements.destructive as StudioPermissionLevel,
      unknown: sqlStatements.unknown as StudioPermissionLevel,
    },
  };
}

function jsonRequest(candidate: StudioSettingsCandidate): RequestInit {
  return {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(candidate),
  };
}

function readPublicMessage(value: unknown): string | undefined {
  const root = asRecord(value);
  return readShortString(root?.message);
}

function readPublicErrorMessage(value: unknown): string | undefined {
  const root = asRecord(value);
  return readShortString(asRecord(root?.error)?.message);
}

function readDialect(value: unknown): StudioDatabaseDialect | undefined {
  return value === "postgres" || value === "mysql" ? value : undefined;
}

function readAccessMode(value: unknown): StudioDatabaseAccessMode | undefined {
  return value === "read-only" || value === "read-write" ? value : undefined;
}

function isPermissionProfile(value: unknown): value is StudioPermissionProfile {
  return value === "normal" || value === "auto" || value === "dangerous";
}

function isPermissionLevel(value: unknown): value is StudioPermissionLevel {
  return value === "allow" || value === "ask" || value === "deny";
}

function readReasoningSelection(value: unknown): StudioReasoningSelection | undefined {
  if (value === "default") return value;
  return typeof value === "string" && REASONING_EFFORTS.has(value as StudioReasoningEffort)
    ? value as StudioReasoningEffort
    : undefined;
}

function readModelCatalog(value: unknown): StudioOpenRouterModelCatalog {
  const root = asRecord(value);
  const source = Array.isArray(root?.models) ? root.models : [];
  const models: StudioOpenRouterModelOption[] = [];
  const ids = new Set<string>();
  for (const item of source) {
    const model = asRecord(item);
    const id = readShortString(model?.id);
    const name = readShortString(model?.name);
    const family = readShortString(model?.family);
    if (!id || !name || !family || ids.has(id)) continue;
    ids.add(id);
    const reasoning = readReasoningCapability(model?.reasoning);
    models.push({ id, name, family, ...(reasoning === undefined ? {} : { reasoning }) });
  }
  return { models };
}

function readReasoningCapability(value: unknown): StudioReasoningCapability | undefined {
  const source = asRecord(value);
  const rawEfforts = source?.supportedEfforts;
  if (!Array.isArray(rawEfforts)) return undefined;
  const supportedEfforts = [...new Set(rawEfforts
    .filter((effort): effort is StudioReasoningEffort => typeof effort === "string" && REASONING_EFFORTS.has(effort as StudioReasoningEffort)))];
  if (supportedEfforts.length === 0) return undefined;
  const defaultEffort = readReasoningSelection(source?.defaultEffort);
  return {
    supportedEfforts,
    ...(defaultEffort === undefined || defaultEffort === "default" ? {} : { defaultEffort }),
    defaultEnabled: source?.defaultEnabled === true,
    mandatory: source?.mandatory === true,
  };
}

function preferredReasoningSelection(
  capability: StudioReasoningCapability | undefined,
  current: StudioReasoningSelection,
): StudioReasoningSelection {
  if (capability === undefined) return "default";
  if (current !== "default" && capability.supportedEfforts.includes(current)) return current;
  if (capability.supportedEfforts.includes("low")) return "low";
  return capability.defaultEffort ?? "default";
}

function formatReasoningEffort(value: StudioReasoningEffort): string {
  return value === "xhigh" ? "Extra high" : value.slice(0, 1).toUpperCase() + value.slice(1);
}

function readBoundedInteger(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : undefined;
}

function readShortString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 ? value.trim() : undefined;
}

function readSafeUrl(value: unknown): string | undefined {
  const candidate = readShortString(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!url.hostname || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
