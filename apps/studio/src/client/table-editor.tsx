import {
  CheckIcon,
  CircleXIcon,
  CircleAlertIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DatabaseIcon,
  EyeIcon,
  FilterIcon,
  FileCode2Icon,
  KeyRoundIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  ListXIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  Table2Icon,
  Trash2Icon,
  ArrowUpDownIcon,
  XIcon,
} from "lucide-react";
import { File as HighlightedFile } from "@pierre/diffs/react";
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  approveStudioDatabaseAction,
  fetchStudioDatabaseActionCapabilities,
  rejectStudioDatabaseAction,
  submitStudioDatabaseAction,
  type StudioDatabaseAction,
  type StudioDatabaseActionCapabilities,
  type StudioDatabaseActionEffect,
} from "./api/studio-api";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "./components/motion/combobox";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Input } from "./components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Skeleton } from "./components/ui/skeleton";
import { Switch } from "./components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import "./table-editor.css";
import { cx } from "./utils";
import { useStudioTheme } from "./studio-theme";
import { CreateTableDialog, type CreateTableDraft } from "./create-table-dialog";
import { eventOriginatedWithinCurrentTarget } from "./event-boundary";
import { isJsonColumnType, JsonCellEditor, type JsonCellSaveResult } from "./json-cell-editor";
import {
  INITIAL_TABLE_EDITOR_WORKSPACE_STATE,
  tableEditorWorkspaceReducer,
  type RecentTableVisit,
  type TableEditorWorkspaceState,
  type TableTabCloseCommand,
} from "./table-editor-workspace";

type DatabaseDialect = "postgres" | "mysql" | "sqlite" | "turso" | "mongodb";

type Connection = {
  connected: boolean;
  credentialCanWrite?: boolean;
  databaseName?: string;
  dialect: DatabaseDialect;
  latencyMs?: number;
  readOnlyTransactions: boolean;
};

type CatalogColumn = {
  comment?: string;
  dataType: string;
  defaultValue?: string;
  name: string;
  nullable: boolean;
  ordinal?: number;
};

type CatalogForeignKey = {
  columns: string[];
  name: string;
  referencedColumns: string[];
  referencedSchema: string;
  referencedTable: string;
};

type CatalogIndex = {
  columns: string[];
  definition?: string;
  isConstraint?: boolean;
  method?: string;
  name: string;
  unique: boolean;
};

type CatalogTable = {
  columns: CatalogColumn[];
  estimatedRows?: number;
  foreignKeys?: CatalogForeignKey[];
  indexes?: CatalogIndex[];
  kind: string;
  name: string;
  primaryKey?: string[];
  schema: string;
};

type CatalogSchema = {
  name: string;
  tables: CatalogTable[];
};

type Catalog = {
  connectionRef: string;
  databaseName: string;
  dialect: DatabaseDialect;
  fingerprint: string;
  schemas: CatalogSchema[];
};

type PreviewValue = string | number | boolean | null;

type PreviewRow = Readonly<{
  incompleteColumns: ReadonlySet<string>;
  row: Record<string, PreviewValue>;
  sourceIndex: number;
}>;

type DatabaseWriteValues = Extract<StudioDatabaseAction, { kind: "data.insert" }> ["values"][number];
type DatabaseActionPredicate = Extract<StudioDatabaseAction, { kind: "data.update" }> ["where"];
type DatabaseActionEnvelope = Pick<
  Extract<StudioDatabaseAction, { kind: "data.insert" }>,
  "catalogFingerprint" | "connectionRef" | "databaseRef" | "relation" | "version"
>;

type TablePreview = {
  columns: CatalogColumn[];
  definition?: string;
  durationMs: number;
  incompleteCells?: Array<Readonly<{ columns: string[]; rowIndex: number }>>;
  page?: number;
  pageSize?: number;
  rowCount: number;
  rows: Array<Record<string, PreviewValue>>;
  table: CatalogTable;
  totalRowCount?: number;
  truncated: boolean;
};

type PreviewState =
  | { status: "idle" | "loading" }
  | { data: TablePreview; status: "ready" }
  | { error: string; status: "error" };

type WriteCapabilityState =
  | { status: "loading" }
  | { capabilities: StudioDatabaseActionCapabilities; status: "ready" }
  | { error: string; status: "unavailable" };

type MutationFeedback = Readonly<{
  message: string;
  tone: "error" | "notice" | "success";
}>;

type MutationSubmissionResult = JsonCellSaveResult;

type SortDirection = "asc" | "desc";
type TableSort = Readonly<{ column: string; direction: SortDirection }>;
type TableFilterOperator = "contains" | "equals" | "not_equals" | "gt" | "gte" | "lt" | "lte" | "is_null" | "is_not_null";
type TableFilter = Readonly<{ column: string; operator: TableFilterOperator; value: string }>;
type TableCellPosition = Readonly<{ columnIndex: number; rowIndex: number }>;
type TableCellSelection = Readonly<{ anchor: TableCellPosition; focus: TableCellPosition }>;

function isCellSelected(position: TableCellPosition, selection: TableCellSelection | undefined): boolean {
  if (!selection) return false;
  const minRow = Math.min(selection.anchor.rowIndex, selection.focus.rowIndex);
  const maxRow = Math.max(selection.anchor.rowIndex, selection.focus.rowIndex);
  const minColumn = Math.min(selection.anchor.columnIndex, selection.focus.columnIndex);
  const maxColumn = Math.max(selection.anchor.columnIndex, selection.focus.columnIndex);
  return position.rowIndex >= minRow
    && position.rowIndex <= maxRow
    && position.columnIndex >= minColumn
    && position.columnIndex <= maxColumn;
}

type PendingApproval = Readonly<{
  action: StudioDatabaseAction;
  effect: StudioDatabaseActionEffect;
  purpose: string;
}>;

type MutationDialogState =
  | Readonly<{ kind: "insert"; table: CatalogTable }>
  | Readonly<{ columnName?: string; kind: "update"; row: Record<string, PreviewValue>; table: CatalogTable }>
  | Readonly<{ kind: "delete"; rows: Array<Record<string, PreviewValue>>; table: CatalogTable }>;

export type TableEditorAgentPageContext = Readonly<{
  catalogFingerprint: string;
  filterActive: boolean;
  schema?: string;
  table?: string;
  view: "data" | "definition";
}>;

type TableEditorProps = {
  catalog: Catalog | undefined;
  catalogError: string | undefined;
  connection: Connection | undefined;
  connectionError: string | undefined;
  onClose: () => void;
  onAgentPageContextChange?: (context: TableEditorAgentPageContext | undefined) => void;
  onRefreshCatalog: () => void | Promise<unknown>;
  refreshingCatalog: boolean;
};

const PAGE_SIZE = 100;
const MAX_TABLE_FILTERS = 32;
const TABLE_EDITOR_STORAGE_VERSION = 2;

type PersistedTableEditorState = {
  activeWorkspace: "new" | "table";
  openTableKeys: string[];
  page: number;
  recentTables: RecentTableVisit[];
  selectedSchema?: string;
  selectedTableKey?: string;
  sidebarCollapsed: boolean;
  tableSearch: string;
  view: "data" | "definition";
};

export function TableEditor({
  catalog,
  catalogError,
  connection,
  connectionError,
  onClose,
  onAgentPageContextChange,
  onRefreshCatalog,
  refreshingCatalog,
}: TableEditorProps) {
  const storageKey = tableEditorStorageKey(catalog);
  const [restoredStorageKey, setRestoredStorageKey] = useState<string>();
  const allTables = useMemo(
    () => catalog?.schemas.flatMap((schema) => schema.tables) ?? [],
    [catalog],
  );
  const [tableSearch, setTableSearch] = useState("");
  const [tableFilters, setTableFilters] = useState<TableFilter[]>([]);
  const [tableSort, setTableSort] = useState<TableSort>();
  const [filterColumn, setFilterColumn] = useState<string>();
  const [permissionsPopoverOpen, setPermissionsPopoverOpen] = useState(false);
  const [selectedSchema, setSelectedSchema] = useState<string>();
  const [workspace, dispatchWorkspace] = useReducer(
    tableEditorWorkspaceReducer,
    INITIAL_TABLE_EDITOR_WORKSPACE_STATE,
  );
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [view, setView] = useState<"data" | "definition">("data");
  const [page, setPage] = useState(1);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [cellSelection, setCellSelection] = useState<TableCellSelection>();
  const previewRequestIds = useRef<Record<string, number>>({});
  const previewAbortControllers = useRef<Record<string, AbortController>>({});
  const [copiedColumn, setCopiedColumn] = useState<string>();
  const [writeCapabilities, setWriteCapabilities] = useState<WriteCapabilityState>({ status: "loading" });
  const [mutationDialog, setMutationDialog] = useState<MutationDialogState>();
  const [mutationFeedback, setMutationFeedback] = useState<MutationFeedback>();
  const [pendingApproval, setPendingApproval] = useState<PendingApproval>();
  const [mutationBusy, setMutationBusy] = useState(false);
  const [createTableOpen, setCreateTableOpen] = useState(false);
  const [pendingCreatedTableKey, setPendingCreatedTableKey] = useState<string>();
  const tabsRef = useRef<HTMLElement>(null);
  const selectedTableKey = workspace.active.kind === "table" ? workspace.active.key : undefined;
  const { openTableKeys, recentTables, sidebarCollapsed } = workspace;

  useEffect(() => {
    let current = true;
    if (!catalog?.connectionRef) {
      setWriteCapabilities({ error: "Governed database writes are unavailable for this catalog.", status: "unavailable" });
      return () => {
        current = false;
      };
    }

    setWriteCapabilities({ status: "loading" });
    void fetchStudioDatabaseActionCapabilities()
      .then((capabilities) => {
        if (current) setWriteCapabilities({ capabilities, status: "ready" });
      })
      .catch((error) => {
        if (current) setWriteCapabilities({ error: publicError(error), status: "unavailable" });
      });

    return () => {
      current = false;
    };
  }, [catalog?.connectionRef]);

  useEffect(() => {
    setMutationDialog(undefined);
    setMutationFeedback(undefined);
    setPendingApproval(undefined);
    setMutationBusy(false);
  }, [catalog?.fingerprint]);

  useEffect(() => {
    const restored = readPersistedTableEditorState(storageKey);
    const validTableKeys = new Set(allTables.map(tableKey));
    const defaultTableKey = allTables[0] ? tableKey(allTables[0]) : undefined;
    const restoredTableKey = restored?.activeWorkspace === "table"
      && restored.selectedTableKey
      && validTableKeys.has(restored.selectedTableKey)
      ? restored.selectedTableKey
      : undefined;
    const active = restored?.activeWorkspace === "new"
      ? { kind: "new" } as const
      : restoredTableKey
        ? { key: restoredTableKey, kind: "table" } as const
        : defaultTableKey
          ? { key: defaultTableKey, kind: "table" } as const
          : { kind: "new" } as const;
    const openTableKeys = (restored?.openTableKeys ?? [])
      .filter((key) => validTableKeys.has(key));
    if (active.kind === "table" && !openTableKeys.includes(active.key)) openTableKeys.push(active.key);

    setTableSearch(restored?.tableSearch ?? "");
    setTableFilters([]);
    setTableSort(undefined);
    setPermissionsPopoverOpen(false);
    setSelectedSchema(restored?.selectedSchema);
    dispatchWorkspace({
      state: {
        active,
        openTableKeys,
        recentTables: (restored?.recentTables ?? []).filter(({ key }) => validTableKeys.has(key)),
        sidebarCollapsed: restored?.sidebarCollapsed ?? false,
      },
      type: "restore",
    });
    setView(restored?.view ?? "data");
    setPage(restored?.page ?? 1);
    setSelectedRows(new Set());
    setCellSelection(undefined);
    setCopiedColumn(undefined);
    setPreviews({});
    for (const controller of Object.values(previewAbortControllers.current)) controller.abort();
    previewAbortControllers.current = {};
    setRestoredStorageKey(storageKey);
  }, [storageKey]);

  useEffect(() => {
    if (restoredStorageKey !== storageKey) return;
    if (selectedSchema && catalog?.schemas.some((schema) => schema.name === selectedSchema)) return;
    setSelectedSchema(catalog?.schemas[0]?.name);
  }, [catalog, restoredStorageKey, selectedSchema, storageKey]);

  useEffect(() => {
    if (restoredStorageKey !== storageKey) return;
    dispatchWorkspace({ type: "prune", validTableKeys: new Set(allTables.map(tableKey)) });
  }, [allTables, restoredStorageKey, storageKey]);

  useEffect(() => {
    if (!pendingCreatedTableKey) return;
    const createdTable = allTables.find((table) => tableKey(table) === pendingCreatedTableKey);
    if (!createdTable) return;
    dispatchWorkspace({ key: pendingCreatedTableKey, openedAt: Date.now(), type: "open-table" });
    setPendingCreatedTableKey(undefined);
  }, [allTables, pendingCreatedTableKey]);

  useEffect(() => {
    if (restoredStorageKey !== storageKey) return;
    writePersistedTableEditorState(storageKey, {
      activeWorkspace: workspace.active.kind,
      openTableKeys: openTableKeys.filter((key) => allTables.some((table) => tableKey(table) === key)),
      page,
      recentTables: recentTables.filter(({ key }) => allTables.some((table) => tableKey(table) === key)),
      selectedSchema,
      selectedTableKey,
      sidebarCollapsed,
      tableSearch,
      view,
    });
  }, [
    allTables,
    openTableKeys,
    page,
    recentTables,
    restoredStorageKey,
    selectedSchema,
    selectedTableKey,
    sidebarCollapsed,
    storageKey,
    tableSearch,
    view,
    workspace.active.kind,
  ]);

  const selectedTable = useMemo(
    () => allTables.find((table) => tableKey(table) === selectedTableKey),
    [allTables, selectedTableKey],
  );
  const selectedPreview = selectedTableKey ? previews[selectedTableKey] : undefined;

  const catalogFingerprint = catalog?.fingerprint;

  useEffect(() => {
    onAgentPageContextChange?.(catalogFingerprint && workspace.active.kind === "table"
      ? {
        catalogFingerprint,
        filterActive: tableFilters.length > 0,
        schema: selectedTable?.schema ?? selectedSchema,
        table: selectedTable?.name,
        view,
      }
      : undefined);
  }, [
    catalogFingerprint,
    onAgentPageContextChange,
    selectedSchema,
    selectedTable?.name,
    selectedTable?.schema,
    tableFilters.length,
    view,
    workspace.active.kind,
  ]);

  const loadPreview = useCallback(async (table: CatalogTable, _force = false) => {
    const key = tableKey(table);
    previewAbortControllers.current[key]?.abort();
    const controller = new AbortController();
    previewAbortControllers.current[key] = controller;
    const requestId = (previewRequestIds.current[key] ?? 0) + 1;
    previewRequestIds.current[key] = requestId;
    setPreviews((values) => ({ ...values, [key]: { status: "loading" } }));
    try {
      const hasTableQuery = tableFilters.length > 0 || tableSort !== undefined || page !== 1;
      const params = hasTableQuery
        ? new URLSearchParams({
          filters: JSON.stringify(tableFilters),
          page: String(page),
          pageSize: String(PAGE_SIZE),
          ...(tableSort ? { direction: tableSort.direction, sort: tableSort.column } : {}),
        })
        : undefined;
      const relationPath = `/api/data/${encodeURIComponent(table.schema)}/${encodeURIComponent(table.name)}`;
      const response = await fetch(params ? `${relationPath}?${params.toString()}` : relationPath, {
        signal: controller.signal,
      });
      const body = await response.json().catch(() => undefined) as { error?: { message?: string } } | TablePreview | undefined;
      if (!response.ok) {
        const message = body && typeof body === "object" && "error" in body ? body.error?.message : undefined;
        throw new Error(message || "Tessera could not load this table preview.");
      }
      if (previewRequestIds.current[key] !== requestId) return;
      setPreviews((values) => ({ ...values, [key]: { data: body as TablePreview, status: "ready" } }));
    } catch (error) {
      if (controller.signal.aborted) return;
      if (previewRequestIds.current[key] !== requestId) return;
      setPreviews((values) => ({
        ...values,
        [key]: { error: publicError(error), status: "error" },
      }));
    } finally {
      if (previewAbortControllers.current[key] === controller) delete previewAbortControllers.current[key];
    }
  }, [page, tableFilters, tableSort]);

  useEffect(() => () => {
    for (const controller of Object.values(previewAbortControllers.current)) controller.abort();
    previewAbortControllers.current = {};
  }, []);

  useEffect(() => {
    if (selectedTable) void loadPreview(selectedTable);
  }, [loadPreview, selectedTable]);

  useEffect(() => {
    setCellSelection(undefined);
  }, [page, selectedTableKey, tableFilters, tableSort]);

  const resetTableView = useCallback(() => {
    setView("data");
    setTableFilters([]);
    setTableSort(undefined);
    setPage(1);
    setSelectedRows(new Set());
    setCellSelection(undefined);
  }, []);

  const selectTable = useCallback((table: CatalogTable) => {
    const key = tableKey(table);
    dispatchWorkspace({ key, openedAt: Date.now(), type: "open-table" });
    resetTableView();
  }, [resetTableView]);

  const openNewWorkspace = useCallback(() => {
    if (selectedTableKey) previewAbortControllers.current[selectedTableKey]?.abort();
    dispatchWorkspace({ type: "open-new" });
    resetTableView();
  }, [resetTableView, selectedTableKey]);

  const selectSchema = useCallback((schemaName: string) => {
    setSelectedSchema(schemaName);
    const firstTable = catalog?.schemas.find((schema) => schema.name === schemaName)?.tables[0];
    if (firstTable) {
      selectTable(firstTable);
      return;
    }
    openNewWorkspace();
  }, [catalog?.schemas, openNewWorkspace, selectTable]);

  const closeTable = useCallback((key: string, command: TableTabCloseCommand = "close") => {
    const targetIndex = openTableKeys.indexOf(key);
    if (targetIndex === -1) return;
    const closedKeys = command === "close-all"
      ? [...openTableKeys]
      : command === "close-others"
        ? openTableKeys.filter((candidate) => candidate !== key)
        : command === "close-right"
          ? openTableKeys.slice(targetIndex + 1)
          : [key];
    for (const closedKey of closedKeys) {
      previewAbortControllers.current[closedKey]?.abort();
      delete previewAbortControllers.current[closedKey];
      delete previewRequestIds.current[closedKey];
    }
    if (closedKeys.length) {
      const closed = new Set(closedKeys);
      setPreviews((current) => Object.fromEntries(
        Object.entries(current).filter(([previewKey]) => !closed.has(previewKey)),
      ));
    }
    dispatchWorkspace({ command, key, type: "close-tabs" });
    window.requestAnimationFrame(() => {
      tabsRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
  }, [openTableKeys]);

  const filteredSchemas = useMemo(() => {
    const normalized = tableSearch.trim().toLocaleLowerCase("en-US");
    return (catalog?.schemas ?? []).flatMap((schema) => {
      if (selectedSchema && schema.name !== selectedSchema) return [];
      const tables = schema.tables.filter((table) => {
        if (!normalized) return true;
        return `${schema.name}.${table.name}`.toLocaleLowerCase("en-US").includes(normalized)
          || table.columns.some((column) => column.name.toLocaleLowerCase("en-US").includes(normalized));
      });
      return tables.length ? [{ ...schema, tables }] : [];
    });
  }, [catalog?.schemas, selectedSchema, tableSearch]);

  const preview = selectedPreview?.status === "ready" ? selectedPreview.data : undefined;
  const columns = preview?.columns ?? selectedTable?.columns ?? [];
  const filteredRows = useMemo<PreviewRow[]>(() => {
    const rows = preview?.rows ?? [];
    const incompleteByRow = new Map(
      (preview?.incompleteCells ?? []).map(({ columns: incompleteColumns, rowIndex }) => [rowIndex, new Set(incompleteColumns)]),
    );
    return rows.map((row, sourceIndex) => ({
      incompleteColumns: incompleteByRow.get(sourceIndex) ?? new Set<string>(),
      row,
      sourceIndex,
    }));
  }, [preview?.incompleteCells, preview?.rows]);
  const totalRowCount = preview?.totalRowCount ?? preview?.rowCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRowCount / PAGE_SIZE));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const visibleRows = filteredRows;
  const selectedTableDisplayName = selectedTable ? `${selectedTable.schema}.${selectedTable.name}` : "New";
  const hasQueryControls = tableFilters.length > 0 || tableSort !== undefined;
  const selectionIncludesPage = selectedTable !== undefined
    && visibleRows.length > 0
    && visibleRows.every(({ row, sourceIndex }) => selectedRows.has(stableRowKey(selectedTable, row, sourceIndex)));
  const selectionIncludesSomePageRows = selectedTable !== undefined
    && visibleRows.some(({ row, sourceIndex }) => selectedRows.has(stableRowKey(selectedTable, row, sourceIndex)));
  const selectedMutationRows = useMemo(
    () => selectedTable === undefined
      ? []
      : filteredRows
        .filter(({ row, sourceIndex }) => selectedRows.has(stableRowKey(selectedTable, row, sourceIndex)))
        .map(({ row }) => row),
    [filteredRows, selectedRows, selectedTable],
  );
  const writeCapability = writeCapabilities.status === "ready"
    ? writeCapabilities.capabilities.capabilities.find((capability) => capability.kind === "write")
    : undefined;
  const writeServiceAvailable = writeCapability !== undefined;
  const connectionCanWrite = connection?.connected === true
    && connection.credentialCanWrite !== false;
  const tableCanMutate = selectedTable !== undefined && isMutableTable(selectedTable);
  const tableHasPrimaryKey = Boolean(selectedTable?.primaryKey?.length);
  const writeBusy = mutationBusy || pendingApproval !== undefined;
  const canInsert = writeServiceAvailable && connectionCanWrite && tableCanMutate && !writeBusy;
  const canUpdate = canInsert && tableHasPrimaryKey;
  const canDelete = canUpdate && selectedMutationRows.length > 0;
  const ddlDialectSupported = connection?.dialect === "postgres" || connection?.dialect === "mysql";
  const canCreateTable = writeServiceAvailable
    && connectionCanWrite
    && ddlDialectSupported
    && Boolean(catalog?.schemas.length)
    && !writeBusy;
  const createTableUnavailableReason = !connection?.connected
    ? "Connect a database before creating a table."
    : !ddlDialectSupported
      ? "Table creation is currently available for PostgreSQL and MySQL connections."
      : !writeServiceAvailable
        ? "Governed database writes are unavailable for this workspace."
        : !connectionCanWrite
          ? "The current connection is read-only."
          : !catalog?.schemas.length
            ? "The current catalog does not expose a writable schema."
            : undefined;
  const writeStateLabel = writeCapabilities.status === "loading"
    ? "Checking write access"
    : !writeServiceAvailable
      ? "Writes unavailable"
      : !connectionCanWrite
        ? "Connection is read-only"
        : selectedTable && !tableCanMutate
          ? "View is read-only"
          : selectedTable && !tableHasPrimaryKey
            ? "Add rows only"
      : writeCapability.requiresApproval
        ? "Governed writes"
        : "Writes enabled";
  const writeStateDescription = writeCapabilities.status === "unavailable"
    ? writeCapabilities.error
    : !connectionCanWrite
      ? "The current connection does not permit database writes."
      : selectedTable && !tableCanMutate
        ? "Only base tables can be changed from this editor."
        : selectedTable && !tableHasPrimaryKey
          ? "Rows without a primary key cannot be updated or deleted safely."
          : writeCapability?.requiresApproval
            ? "Every database change is reviewed through the active permission policy."
            : "Database writes are available through the active permission policy.";
  const showMutationStatus = pendingApproval !== undefined || mutationFeedback !== undefined;
  const recentTableItems = recentTables.flatMap((visit) => {
    const table = allTables.find((candidate) => tableKey(candidate) === visit.key);
    return table ? [{ table, visit }] : [];
  });

  const copySelectedColumn = useCallback(async (columnName: string) => {
    if (!selectedTable) return;
    const values = visibleRows
      .filter(({ row, sourceIndex }) => selectedRows.has(stableRowKey(selectedTable, row, sourceIndex)))
      .map(({ row }) => displayValue(row[columnName]));
    if (!values.length || !await writeTextToClipboard(values.join("\n"))) return;
    setCopiedColumn(columnName);
    window.setTimeout(() => setCopiedColumn((current) => current === columnName ? undefined : current), 1800);
  }, [selectedRows, selectedTable, visibleRows]);

  const copyTableReference = useCallback(async () => {
    if (!selectedTable) return;
    if (await writeTextToClipboard(`${selectedTable.schema}.${selectedTable.name}`)) {
      setMutationFeedback({ message: `Copied ${selectedTable.schema}.${selectedTable.name}.`, tone: "success" });
    } else {
      setMutationFeedback({ message: "Clipboard access was denied by the browser.", tone: "error" });
    }
  }, [selectedTable]);

  const togglePageSelection = () => {
    if (!selectedTable) return;
    setSelectedRows((current) => {
      const next = new Set(current);
      if (selectionIncludesPage) visibleRows.forEach(({ row, sourceIndex }) => next.delete(stableRowKey(selectedTable, row, sourceIndex)));
      else visibleRows.forEach(({ row, sourceIndex }) => next.add(stableRowKey(selectedTable, row, sourceIndex)));
      return next;
    });
  };

  const completeSucceededMutation = useCallback(async (
    action: StudioDatabaseAction,
    effect: StudioDatabaseActionEffect,
  ) => {
    setMutationDialog(undefined);
    setPendingApproval(undefined);
    setSelectedRows(new Set());
    setCellSelection(undefined);
    const affectedRows = effect.result?.affectedRows;
    setMutationFeedback({
      message: action.kind === "data.ddl" || affectedRows === undefined
        ? `${databaseActionLabel(action)} completed.`
        : `${databaseActionLabel(action)} completed for ${affectedRows} ${affectedRows === 1 ? "row" : "rows"}.`,
      tone: "success",
    });
    if (action.kind === "data.ddl") {
      if (action.operation.kind === "create-table") {
        setPendingCreatedTableKey(tableKey({ name: action.relation.table, schema: action.relation.schema }));
      }
      await onRefreshCatalog();
      return;
    }
    const refreshedTable = allTables.find((table) => (
      table.schema === action.relation.schema && table.name === action.relation.table
    ));
    if (refreshedTable) await loadPreview(refreshedTable, true);
  }, [allTables, loadPreview, onRefreshCatalog]);

  const handleMutationEffect = useCallback(async (
    action: StudioDatabaseAction,
    purpose: string,
    effect: StudioDatabaseActionEffect,
  ): Promise<MutationSubmissionResult> => {
    if (effect.summary.status === "awaiting-approval" && effect.approval) {
      setMutationDialog(undefined);
      setPendingApproval({ action, effect, purpose });
      setMutationFeedback(undefined);
      return { accepted: true };
    }
    if (effect.summary.status === "succeeded") {
      await completeSucceededMutation(action, effect);
      return { accepted: true };
    }
    if (effect.summary.status === "cancelled") {
      setPendingApproval(undefined);
      const message = `${databaseActionLabel(action)} was not applied.`;
      setMutationFeedback({ message, tone: "success" });
      return { accepted: false, error: message };
    }
    setPendingApproval(undefined);
    const message = `${databaseActionLabel(action)} could not be completed (${effect.summary.status}).`;
    setMutationFeedback({ message, tone: "error" });
    return { accepted: false, error: message };
  }, [completeSucceededMutation]);

  const submitMutation = useCallback(async (
    action: StudioDatabaseAction,
    purpose: string,
  ): Promise<MutationSubmissionResult> => {
    const requestId = createDatabaseActionRequestId();
    setMutationBusy(true);
    setMutationFeedback(undefined);
    try {
      const effect = await submitStudioDatabaseAction({
        action,
        idempotencyKey: requestId,
        purpose,
        requestId,
      });
      return await handleMutationEffect(action, purpose, effect);
    } catch (error) {
      const message = publicError(error);
      setMutationFeedback({ message, tone: "error" });
      return { accepted: false, error: message };
    } finally {
      setMutationBusy(false);
    }
  }, [handleMutationEffect]);

  const respondToApproval = useCallback(async (decision: "approve" | "reject") => {
    const approval = pendingApproval?.effect.approval;
    if (!pendingApproval || !approval) return;
    const { action, effect, purpose } = pendingApproval;
    setMutationBusy(true);
    setMutationFeedback(undefined);
    try {
      const resolved = decision === "approve"
        ? await approveStudioDatabaseAction(effect.summary.requestId, approval.checkpointId)
        : await rejectStudioDatabaseAction(effect.summary.requestId, approval.checkpointId);
      await handleMutationEffect(action, purpose, resolved);
    } catch (error) {
      setMutationFeedback({ message: publicError(error), tone: "error" });
    } finally {
      setMutationBusy(false);
    }
  }, [handleMutationEffect, pendingApproval]);

  const submitInsert = useCallback((table: CatalogTable, values: DatabaseWriteValues) => {
    if (!catalog) return;
    const action: StudioDatabaseAction = {
      ...databaseActionEnvelope(catalog, table),
      kind: "data.insert",
      maxAffectedRows: 1,
      ...databaseActionReturning(catalog, table),
      values: [values],
    };
    void submitMutation(action, `Insert a row in ${table.schema}.${table.name} from Table Editor.`);
  }, [catalog, submitMutation]);

  const submitUpdate = useCallback((table: CatalogTable, row: Record<string, PreviewValue>, patch: DatabaseWriteValues) => {
    if (!catalog) return Promise.resolve({ accepted: false, error: "The database catalog is unavailable." } as const);
    const where = primaryKeyPredicate(table, row);
    if (!where) {
      const message = "This row no longer has a usable primary-key identity.";
      setMutationFeedback({ message, tone: "error" });
      return Promise.resolve({ accepted: false, error: message } as const);
    }
    const action: StudioDatabaseAction = {
      ...databaseActionEnvelope(catalog, table),
      kind: "data.update",
      maxAffectedRows: 1,
      patch,
      ...databaseActionReturning(catalog, table),
      where,
    };
    return submitMutation(action, `Update one row in ${table.schema}.${table.name} from Table Editor.`);
  }, [catalog, submitMutation]);

  const openDeleteDialog = useCallback(() => {
    if (!selectedTable || !selectedMutationRows.length) return;
    setMutationDialog({ kind: "delete", rows: selectedMutationRows, table: selectedTable });
  }, [selectedMutationRows, selectedTable]);

  const submitDelete = useCallback((table: CatalogTable, rows: Array<Record<string, PreviewValue>>) => {
    if (!catalog) return;
    const where = selectedPrimaryKeyPredicate(table, rows);
    if (!where) {
      setMutationFeedback({ message: "The selected rows no longer have usable primary-key identities.", tone: "error" });
      return;
    }
    const action: StudioDatabaseAction = {
      ...databaseActionEnvelope(catalog, table),
      kind: "data.delete",
      maxAffectedRows: rows.length,
      ...databaseActionReturning(catalog, table),
      where,
    };
    void submitMutation(action, `Delete ${rows.length} ${rows.length === 1 ? "row" : "rows"} from ${table.schema}.${table.name} in Table Editor.`);
  }, [catalog, submitMutation]);

  const submitCreateTable = useCallback((draft: CreateTableDraft) => {
    if (!catalog) return;
    const action: StudioDatabaseAction = {
      catalogFingerprint: catalog.fingerprint,
      connectionRef: catalog.connectionRef,
      databaseRef: catalog.databaseName,
      kind: "data.ddl",
      operation: {
        columns: draft.columns.map(({ dataType, name, nullable }) => ({ dataType, name, nullable })),
        kind: "create-table",
        primaryKey: draft.columns.filter(({ primaryKey }) => primaryKey).map(({ name }) => name),
      },
      relation: { schema: draft.schema, table: draft.name },
      version: 1,
    };
    setCreateTableOpen(false);
    dispatchWorkspace({ type: "open-new" });
    void submitMutation(action, `Create ${draft.schema}.${draft.name} from Table Editor.`);
  }, [catalog, submitMutation]);

  const activateWorkspaceTab = (index: number) => {
    if (index === openTableKeys.length) {
      openNewWorkspace();
    } else {
      const key = openTableKeys[index];
      const table = key ? allTables.find((candidate) => tableKey(candidate) === key) : undefined;
      if (table) selectTable(table);
    }
    window.requestAnimationFrame(() => {
      tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
    });
  };

  const handleWorkspaceTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const tabCount = openTableKeys.length + 1;
    let nextIndex: number | undefined;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabCount) % tabCount;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabCount;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabCount - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    activateWorkspaceTab(nextIndex);
  };

  const openCreateTable = () => {
    openNewWorkspace();
    setCreateTableOpen(true);
  };

  return (
    <section
      aria-label="Tessera Table Editor"
      className="table-editor"
      data-sidebar-collapsed={sidebarCollapsed || undefined}
    >
      {!sidebarCollapsed ? <aside className="table-editor-sidebar" id="table-editor-sidebar">
        <header className="table-editor-sidebar-header">
          <div className="table-editor-title-row">
            <Table2Icon aria-hidden="true" size={17} strokeWidth={1.8} />
            <h1>Table Editor</h1>
          </div>
          <TooltipIconButton
            aria-label="Close table editor"
            className="table-editor-icon-button"
            onClick={onClose}
            tooltip="Close data browser"
            type="button"
          >
            <XIcon aria-hidden="true" size={16} />
          </TooltipIconButton>
        </header>

        <div className="table-editor-sidebar-controls">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="Choose database schema"
                className="table-editor-schema-trigger"
                disabled={!catalog?.schemas.length}
                size="sm"
                type="button"
                variant="outline"
              >
                <DatabaseIcon aria-hidden="true" size={14} strokeWidth={1.8} />
                <span>{selectedSchema ?? "Select schema"}</span>
                <ChevronDownIcon aria-hidden="true" size={14} strokeWidth={1.8} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="table-editor-schema-menu"
              collisionPadding={8}
              sideOffset={4}
            >
              <DropdownMenuRadioGroup onValueChange={selectSchema} value={selectedSchema}>
                {(catalog?.schemas ?? []).map((schema) => (
                  <DropdownMenuRadioItem
                    className="table-editor-schema-menu-item"
                    key={schema.name}
                    value={schema.name}
                  >
                    <CheckIcon
                      aria-hidden="true"
                      className="table-editor-schema-menu-check"
                      size={14}
                      strokeWidth={2}
                    />
                    <span className="table-editor-schema-menu-name" title={schema.name}>{schema.name}</span>
                    <span
                      aria-label={`${schema.tables.length} ${schema.tables.length === 1 ? "table" : "tables"}`}
                      className="table-editor-schema-menu-count"
                    >
                      {schema.tables.length}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            className="table-editor-new-table-button"
            disabled={!canCreateTable}
            onClick={openCreateTable}
            size="sm"
            title={createTableUnavailableReason ?? "Create a table"}
            type="button"
            variant="outline"
          >
            <PlusIcon aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>New table</span>
          </Button>
        </div>

        <label className="table-editor-table-search">
          <SearchIcon aria-hidden="true" size={14} />
          <span className="sr-only">Search database tables</span>
          <Input
            aria-label="Search database tables"
            className="table-editor-search-input"
            onChange={(event) => setTableSearch(event.currentTarget.value)}
            placeholder="Search tables..."
            value={tableSearch}
          />
        </label>

        <div className="table-editor-tree" role="tree" aria-label="Database tables">
          {connectionError || catalogError ? (
            <TableEditorNotice>{connectionError ?? catalogError}</TableEditorNotice>
          ) : null}
          {!catalog && !catalogError ? <TableEditorTreeLoading /> : null}
          {catalog && filteredSchemas.length ? (
            <div className="table-editor-tree-heading" aria-hidden="true">
              <span>Tables</span>
              <span>{filteredSchemas.reduce((count, schema) => count + schema.tables.length, 0)}</span>
            </div>
          ) : null}
          {filteredSchemas.map((schema) => (
            <section className="table-editor-schema" key={schema.name}>
              {schema.tables.map((table) => {
                const key = tableKey(table);
                const active = key === selectedTableKey;
                return (
                  <Button
                    aria-current={active ? "page" : undefined}
                    className={cx("table-editor-table-link", active && "is-active")}
                    key={key}
                    onClick={() => selectTable(table)}
                    role="treeitem"
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Table2Icon aria-hidden="true" size={14} strokeWidth={1.8} />
                    <span>{table.name}</span>
                    <span className="table-editor-table-kind">{table.kind === "view" ? "view" : ""}</span>
                  </Button>
                );
              })}
            </section>
          ))}
          {catalog && filteredSchemas.length === 0 ? <TableEditorNotice>No tables match this search.</TableEditorNotice> : null}
        </div>

        <footer className="table-editor-sidebar-footer">
          <EyeIcon aria-hidden="true" size={14} />
          <span>Read-only catalog</span>
        </footer>
      </aside> : null}

      <section className={cx(
        "table-editor-main",
        workspace.active.kind === "new" && "is-new-workspace",
        showMutationStatus && "has-mutation-status",
      )}>
        <nav aria-label="Open tables" className="table-editor-tabs" ref={tabsRef} role="tablist">
          <TooltipIconButton
            aria-controls="table-editor-sidebar"
            aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? "Expand table navigation" : "Collapse table navigation"}
            className="table-editor-sidebar-toggle"
            onClick={() => dispatchWorkspace({ type: "toggle-sidebar" })}
            tooltip={sidebarCollapsed ? "Expand table navigation" : "Collapse table navigation"}
            type="button"
          >
            {sidebarCollapsed
              ? <PanelLeftOpenIcon aria-hidden="true" size={15} strokeWidth={1.8} />
              : <PanelLeftCloseIcon aria-hidden="true" size={15} strokeWidth={1.8} />}
          </TooltipIconButton>
          {openTableKeys.map((key) => {
            const table = allTables.find((candidate) => tableKey(candidate) === key);
            if (!table) return null;
            const active = key === selectedTableKey;
            const tabIndex = openTableKeys.indexOf(key);
            return (
              <ContextMenu key={key}>
                <ContextMenuTrigger asChild>
                  <div className={cx("table-editor-tab", active && "is-active")}>
                    <Button
                      aria-controls="table-editor-workspace-panel"
                      aria-selected={active}
                      onClick={() => selectTable(table)}
                      onKeyDown={(event) => handleWorkspaceTabKeyDown(event, tabIndex)}
                      role="tab"
                      size="sm"
                      tabIndex={active ? 0 : -1}
                      type="button"
                      variant="ghost"
                    >
                      <Table2Icon aria-hidden="true" size={14} strokeWidth={1.8} />
                      <span>{table.schema}.{table.name}</span>
                    </Button>
                    <TooltipIconButton
                      aria-label={`Close ${table.name}`}
                      className="table-editor-tab-close"
                      onClick={() => closeTable(key)}
                      tooltip={`Close ${table.name}`}
                      type="button"
                    >
                      <XIcon aria-hidden="true" size={13} />
                    </TooltipIconButton>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="table-editor-tab-context-menu">
                  <ContextMenuItem onSelect={() => closeTable(key)}><XIcon aria-hidden="true" /> Close</ContextMenuItem>
                  <ContextMenuItem disabled={openTableKeys.length <= 1} onSelect={() => closeTable(key, "close-others")}><ListXIcon aria-hidden="true" /> Close Others</ContextMenuItem>
                  <ContextMenuItem disabled={tabIndex === openTableKeys.length - 1} onSelect={() => closeTable(key, "close-right")}><PanelRightCloseIcon aria-hidden="true" /> Close to the Right</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => closeTable(key, "close-all")}><CircleXIcon aria-hidden="true" /> Close All</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          <Button
            aria-controls="table-editor-workspace-panel"
            aria-selected={workspace.active.kind === "new"}
            className={cx("table-editor-new-tab", workspace.active.kind === "new" && "is-active")}
            onClick={openNewWorkspace}
            onKeyDown={(event) => handleWorkspaceTabKeyDown(event, openTableKeys.length)}
            role="tab"
            size="sm"
            tabIndex={workspace.active.kind === "new" ? 0 : -1}
            type="button"
            variant="ghost"
          >
            <PlusIcon aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>New</span>
          </Button>
          <span className="table-editor-tabs-fill" />
        </nav>

        {workspace.active.kind === "new" ? (
          <>
            <TableMutationStatus
              busy={mutationBusy}
              feedback={mutationFeedback}
              onApprove={() => void respondToApproval("approve")}
              onReject={() => void respondToApproval("reject")}
              pendingApproval={pendingApproval}
            />
            <TableEditorNewWorkspace
              canCreateTable={canCreateTable}
              createTableUnavailableReason={createTableUnavailableReason}
              onCreateTable={openCreateTable}
              onSelectTable={selectTable}
              recentTables={recentTableItems}
            />
          </>
        ) : <>
        <header className="table-editor-toolbar">
          <TableFilterBar
            filters={tableFilters}
            initialColumn={filterColumn}
            key={selectedTableKey ?? "no-table"}
            onChange={(nextFilters) => {
              setTableFilters(nextFilters);
              setPage(1);
              setSelectedRows(new Set());
              setCellSelection(undefined);
            }}
            onInitialColumnHandled={() => setFilterColumn(undefined)}
            table={selectedTable}
          />
          <div className="table-editor-toolbar-actions">
            <TableSortPopover
              onApply={(nextSort) => {
                setTableSort(nextSort);
                setPage(1);
                setSelectedRows(new Set());
                setCellSelection(undefined);
              }}
              sort={tableSort}
              table={selectedTable}
            />
            <TablePermissionsPopover
              connection={connection}
              onOpenChange={setPermissionsPopoverOpen}
              open={permissionsPopoverOpen}
              requiresApproval={writeCapability?.requiresApproval === true}
              table={selectedTable}
              tableCanMutate={tableCanMutate}
              tableHasPrimaryKey={tableHasPrimaryKey}
              writeServiceAvailable={writeServiceAvailable}
              writeStateDescription={writeStateDescription}
              writeStateLabel={writeStateLabel}
            />
            <span aria-label={writeStateDescription} className="table-editor-write-state" title={writeStateDescription}>
              {writeCapabilities.status === "loading" ? <LoaderCircleIcon aria-hidden="true" className="spin" size={14} /> : <ShieldCheckIcon aria-hidden="true" size={14} strokeWidth={1.8} />}
              <span>{writeStateLabel}</span>
            </span>
            <Button
              className="table-editor-mutation-button"
              disabled={!canInsert || !selectedTable}
              onClick={() => selectedTable && setMutationDialog({ kind: "insert", table: selectedTable })}
              size="sm"
              type="button"
              variant="outline"
            >
              <PlusIcon aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>Add row</span>
            </Button>
            <Button
              className="table-editor-mutation-button table-editor-delete-button"
              disabled={!canDelete}
              onClick={openDeleteDialog}
              size="sm"
              type="button"
              variant="outline"
            >
              <Trash2Icon aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>Delete{selectedMutationRows.length ? ` (${selectedMutationRows.length})` : ""}</span>
            </Button>
            <TooltipIconButton
              aria-label="Refresh table preview"
              className="table-editor-toolbar-button"
              disabled={!selectedTable}
              onClick={() => selectedTable && void loadPreview(selectedTable, true)}
              tooltip="Refresh table preview"
              type="button"
            >
              <RefreshCwIcon aria-hidden="true" className={selectedPreview?.status === "loading" ? "spin" : undefined} size={15} />
            </TooltipIconButton>
            <TooltipIconButton
              aria-label="Refresh database catalog"
              className="table-editor-refresh-catalog"
              disabled={refreshingCatalog}
              onClick={onRefreshCatalog}
              tooltip="Refresh database catalog"
              type="button"
            >
              <RefreshCwIcon aria-hidden="true" className={refreshingCatalog ? "spin" : undefined} size={15} />
            </TooltipIconButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button aria-label="More table actions" className="table-editor-more-button" size="sm" title="More table actions" type="button" variant="outline">
                  <MoreHorizontalIcon aria-hidden="true" size={16} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="table-editor-action-menu" sideOffset={6}>
                <DropdownMenuLabel>{selectedTableDisplayName}</DropdownMenuLabel>
                <DropdownMenuItem disabled={!selectedTable} onSelect={() => setPermissionsPopoverOpen(true)}>
                  <ShieldCheckIcon aria-hidden="true" size={14} />
                  Database permissions
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canInsert || !selectedTable} onSelect={() => selectedTable && setMutationDialog({ kind: "insert", table: selectedTable })}>
                  <PlusIcon aria-hidden="true" size={14} />
                  Add row
                </DropdownMenuItem>
                <DropdownMenuItem className="table-editor-delete-menu-item" disabled={!canDelete} onSelect={openDeleteDialog}>
                  <Trash2Icon aria-hidden="true" size={14} />
                  Delete selected rows{selectedMutationRows.length ? ` (${selectedMutationRows.length})` : ""}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!selectedTable} onSelect={() => void copyTableReference()}>
                  <CopyIcon aria-hidden="true" size={14} />
                  Copy table reference
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!selectedTable} onSelect={() => setView("definition")}>
                  <FileCode2Icon aria-hidden="true" size={14} />
                  Open definition
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!selectedTable} onSelect={() => selectedTable && void loadPreview(selectedTable, true)}>
                  <RefreshCwIcon aria-hidden="true" size={14} />
                  Refresh preview
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!hasQueryControls} onSelect={() => { setTableFilters([]); setTableSort(undefined); setPage(1); setSelectedRows(new Set()); setCellSelection(undefined); }}>
                  <XIcon aria-hidden="true" size={14} />
                  Clear filters and sort
                </DropdownMenuItem>
                <DropdownMenuItem disabled={refreshingCatalog} onSelect={onRefreshCatalog}>
                  <DatabaseIcon aria-hidden="true" size={14} />
                  Refresh catalog
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <TableMutationStatus
          busy={mutationBusy}
          feedback={mutationFeedback}
          onApprove={() => void respondToApproval("approve")}
          onReject={() => void respondToApproval("reject")}
          pendingApproval={pendingApproval}
        />

        <div className="table-editor-content" id="table-editor-workspace-panel" role="tabpanel">
          {!selectedTable ? <TableEditorEmpty title="No table selected" text="Choose a table from the current database catalog." /> : null}
          {selectedTable && selectedPreview?.status === "loading" ? <TableGridLoading columns={columns} showRowActions={Boolean(selectedTable.primaryKey?.length)} /> : null}
          {selectedTable && selectedPreview?.status === "error" ? <TableEditorEmpty title="Preview unavailable" text={selectedPreview.error} /> : null}
          {selectedTable && (selectedPreview?.status === "idle" || selectedPreview === undefined) ? <TableGridLoading columns={columns} showRowActions={Boolean(selectedTable.primaryKey?.length)} /> : null}
          {selectedTable && preview && view === "data" ? (
            <TableDataGrid
              columns={columns}
              pageStart={pageStart}
              rows={visibleRows}
              cellSelection={cellSelection}
              selectedRows={selectedRows}
              table={selectedTable}
              activeFilters={tableFilters}
              activeSort={tableSort}
              togglePageSelection={togglePageSelection}
              toggleRow={(key) => setSelectedRows((current) => toggleSelectionKey(current, key))}
              allPageRowsSelected={selectionIncludesPage}
              somePageRowsSelected={selectionIncludesSomePageRows}
              onCellSelectionChange={setCellSelection}
              copiedColumn={copiedColumn}
              canUpdate={canUpdate}
              onCopyColumn={copySelectedColumn}
              onFilterColumn={(column) => {
                setFilterColumn(column);
              }}
              onSortColumn={(column, direction) => {
                setTableSort({ column, direction });
                setPage(1);
                setSelectedRows(new Set());
                setCellSelection(undefined);
              }}
              onEditRow={(row) => selectedTable && setMutationDialog({ kind: "update", row, table: selectedTable })}
              onUpdate={submitUpdate}
              />
          ) : null}
          {selectedTable && preview && view === "definition" ? <TableDefinition definition={preview.definition} table={preview.table} /> : null}
        </div>

        <footer className="table-editor-footer">
          <div className="table-editor-pagination">
            <span className="table-editor-page-summary">
              {preview
                ? totalRowCount === 0
                  ? "0 rows"
                  : `${pageStart + 1}-${Math.min(pageStart + PAGE_SIZE, totalRowCount)} of ${totalRowCount}${preview.truncated ? "+" : ""} rows`
                : "Loading rows"}
            </span>
            <TooltipIconButton aria-label="Previous page" className="table-editor-pagination-button" disabled={safePage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} tooltip="Previous page" type="button"><ChevronLeftIcon aria-hidden="true" size={15} /></TooltipIconButton>
            <span>Page {safePage}</span>
            <TooltipIconButton aria-label="Next page" className="table-editor-pagination-button" disabled={safePage >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} tooltip="Next page" type="button"><ChevronRightIcon aria-hidden="true" size={15} /></TooltipIconButton>
            {preview?.durationMs !== undefined ? <span className="table-editor-duration">{preview.durationMs} ms</span> : null}
          </div>
          <Tabs aria-label="Table view" className="table-editor-view-tabs" onValueChange={(value) => setView(value === "definition" ? "definition" : "data")} value={view}>
            <TabsList>
              <TabsTrigger value="data">Data</TabsTrigger>
              <TabsTrigger value="definition">Definition</TabsTrigger>
            </TabsList>
          </Tabs>
        </footer>
        </>}

        <span className="sr-only">Viewing {selectedTableDisplayName}</span>

        <TableMutationDialog
          busy={mutationBusy}
          dialog={mutationDialog}
          onClose={() => setMutationDialog(undefined)}
          onDelete={submitDelete}
          onInsert={submitInsert}
          onUpdate={submitUpdate}
        />
        <CreateTableDialog
          busy={mutationBusy}
          dialect={connection?.dialect ?? catalog?.dialect ?? "postgres"}
          existingRelations={allTables}
          initialSchema={selectedSchema}
          onOpenChange={setCreateTableOpen}
          onSubmit={submitCreateTable}
          open={createTableOpen}
          schemas={(catalog?.schemas ?? []).map(({ name }) => name)}
        />
      </section>
    </section>
  );
}

function TableEditorNewWorkspace({
  canCreateTable,
  createTableUnavailableReason,
  onCreateTable,
  onSelectTable,
  recentTables,
}: {
  canCreateTable: boolean;
  createTableUnavailableReason: string | undefined;
  onCreateTable: () => void;
  onSelectTable: (table: CatalogTable) => void;
  recentTables: readonly Readonly<{ table: CatalogTable; visit: RecentTableVisit }>[];
}) {
  return (
    <div className="table-editor-new-workspace" id="table-editor-workspace-panel" role="tabpanel">
      <div className="table-editor-new-workspace-inner">
        <Button
          className="table-editor-create-table-card"
          disabled={!canCreateTable}
          onClick={onCreateTable}
          title={createTableUnavailableReason ?? "Create a table"}
          type="button"
          variant="secondary"
        >
          <span className="table-editor-create-table-icon">
            <Table2Icon aria-hidden="true" size={18} strokeWidth={1.8} />
          </span>
          <span className="table-editor-create-table-copy">
            <strong>Create a table</strong>
            <small>{createTableUnavailableReason ?? "Design and create a new database table"}</small>
          </span>
        </Button>

        <section className="table-editor-recent">
          <header>
            <h2>Recent items</h2>
            {recentTables.length ? <span>{recentTables.length}</span> : null}
          </header>
          {recentTables.length ? (
            <div className="table-editor-recent-list">
              {recentTables.map(({ table, visit }) => (
                <Button
                  className="table-editor-recent-item"
                  key={visit.key}
                  onClick={() => onSelectTable(table)}
                  type="button"
                  variant="ghost"
                >
                  <span className="table-editor-recent-icon">
                    <Table2Icon aria-hidden="true" size={14} strokeWidth={1.8} />
                  </span>
                  <span>{table.schema}.{table.name}</span>
                  <time dateTime={new Date(visit.openedAt).toISOString()}>{recentVisitLabel(visit.openedAt)}</time>
                </Button>
              ))}
            </div>
          ) : (
            <p className="table-editor-recent-empty">Tables you open will appear here.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function TableDataGrid({
  activeFilters,
  activeSort,
  allPageRowsSelected,
  cellSelection,
  canUpdate,
  copiedColumn,
  columns,
  onCellSelectionChange,
  onCopyColumn,
  onFilterColumn,
  onSortColumn,
  onEditRow,
  onUpdate,
  pageStart,
  rows,
  selectedRows,
  somePageRowsSelected,
  table,
  togglePageSelection,
  toggleRow,
}: {
  activeFilters: TableFilter[];
  activeSort: TableSort | undefined;
  allPageRowsSelected: boolean;
  cellSelection: TableCellSelection | undefined;
  canUpdate: boolean;
  copiedColumn?: string;
  columns: CatalogColumn[];
  onCellSelectionChange: (selection: TableCellSelection) => void;
  pageStart: number;
  rows: PreviewRow[];
  selectedRows: Set<string>;
  somePageRowsSelected: boolean;
  table: CatalogTable;
  togglePageSelection: () => void;
  toggleRow: (key: string) => void;
  onCopyColumn: (columnName: string) => void;
  onFilterColumn: (columnName: string) => void;
  onSortColumn: (columnName: string, direction: SortDirection) => void;
  onEditRow: (row: Record<string, PreviewValue>) => void;
  onUpdate: (table: CatalogTable, row: Record<string, PreviewValue>, patch: DatabaseWriteValues) => Promise<MutationSubmissionResult>;
}) {
  const showRowActions = Boolean(table.primaryKey?.length);
  const gridRef = useRef<HTMLTableElement>(null);
  const draggingSelection = useRef(false);

  const copySelectedCells = useCallback(async () => {
    if (!cellSelection) return;
    const copiedText = selectedCellsToTsv(columns, rows, cellSelection);
    if (!copiedText) return;
    await writeTextToClipboard(copiedText);
  }, [cellSelection, columns, rows]);

  const selectCell = (position: TableCellPosition, extendSelection: boolean) => {
    onCellSelectionChange(
      extendSelection && cellSelection
        ? { anchor: cellSelection.anchor, focus: position }
        : { anchor: position, focus: position },
    );
  };

  const focusCell = (position: TableCellPosition) => {
    window.requestAnimationFrame(() => {
      gridRef.current
        ?.querySelector<HTMLTableCellElement>(`[data-cell-position="${position.rowIndex}:${position.columnIndex}"]`)
        ?.focus();
    });
  };

  const moveCellFocus = (event: ReactKeyboardEvent<HTMLTableCellElement>, position: TableCellPosition) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase("en-US") === "c") {
      event.preventDefault();
      void copySelectedCells();
      return;
    }
    const nextPosition = {
      ArrowDown: { columnIndex: position.columnIndex, rowIndex: Math.min(rows.length - 1, position.rowIndex + 1) },
      ArrowLeft: { columnIndex: Math.max(0, position.columnIndex - 1), rowIndex: position.rowIndex },
      ArrowRight: { columnIndex: Math.min(columns.length - 1, position.columnIndex + 1), rowIndex: position.rowIndex },
      ArrowUp: { columnIndex: position.columnIndex, rowIndex: Math.max(0, position.rowIndex - 1) },
    }[event.key];
    if (!nextPosition) return;
    event.preventDefault();
    selectCell(nextPosition, event.shiftKey);
    focusCell(nextPosition);
  };

  return (
    <div className="table-editor-grid-scroll">
      <table aria-label={`${table.schema}.${table.name} data`} className="table-editor-grid" ref={gridRef} role="grid">
        <colgroup>
          <col className="table-editor-selection-column" />
          {columns.map((column) => <col className="table-editor-data-column" key={column.name} />)}
          {showRowActions ? <col className="table-editor-row-action-column" /> : null}
        </colgroup>
        <thead>
          <tr role="row">
            <th className="table-editor-selection-cell" role="columnheader">
              <Checkbox
                aria-label="Select visible rows"
                checked={allPageRowsSelected ? true : somePageRowsSelected ? "indeterminate" : false}
                onCheckedChange={togglePageSelection}
              />
            </th>
            {columns.map((column) => {
              const primaryKey = table.primaryKey?.includes(column.name) ?? false;
              const columnHasFilter = activeFilters.some((filter) => filter.column === column.name);
              const columnSort = activeSort?.column === column.name ? activeSort.direction : undefined;
              return (
                <th className={cx((columnHasFilter || columnSort) && "is-query-active")} key={column.name} role="columnheader">
                  <div className="table-editor-column-header">
                    <span className="table-editor-column-name">
                      {primaryKey ? <KeyRoundIcon aria-hidden="true" size={12} strokeWidth={1.8} /> : null}
                      <span>{column.name}</span>
                    </span>
                    <span className="table-editor-column-type">
                      {compactDataType(column.dataType)}
                      {columnSort ? <span className="table-editor-column-sort-state" title={`Sorted ${columnSort === "asc" ? "ascending" : "descending"}`}>{columnSort === "asc" ? "ASC" : "DESC"}</span> : null}
                      {columnHasFilter ? <FilterIcon aria-label="Filtered column" className="table-editor-column-filter-state" size={11} strokeWidth={2} /> : null}
                    </span>
                    <TooltipIconButton
                      aria-label={`Copy selected values from ${column.name}`}
                      className="table-editor-column-copy"
                      disabled={!rows.some(({ row, sourceIndex }) => selectedRows.has(stableRowKey(table, row, sourceIndex)))}
                      onClick={() => void onCopyColumn(column.name)}
                      tooltip="Copy selected values"
                      type="button"
                    >
                      {copiedColumn === column.name ? <CheckIcon aria-hidden="true" size={12} /> : <CopyIcon aria-hidden="true" size={12} />}
                    </TooltipIconButton>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button aria-label={`Column actions for ${column.name}`} className="table-editor-column-menu-button" size="icon-xs" type="button" variant="ghost">
                          <ChevronDownIcon aria-hidden="true" size={13} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="table-editor-action-menu" sideOffset={4}>
                        <DropdownMenuLabel>{column.name}{columnSort ? ` · ${columnSort === "asc" ? "ascending" : "descending"}` : ""}</DropdownMenuLabel>
                        <DropdownMenuItem onSelect={() => onSortColumn(column.name, "asc")}>
                          <ArrowUpDownIcon aria-hidden="true" size={14} /> Sort ascending
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onSortColumn(column.name, "desc")}>
                          <ArrowUpDownIcon aria-hidden="true" className="table-editor-sort-desc" size={14} /> Sort descending
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onFilterColumn(column.name)}>
                          <FilterIcon aria-hidden="true" size={14} /> Filter by this column
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!rows.some(({ row, sourceIndex }) => selectedRows.has(stableRowKey(table, row, sourceIndex)))} onSelect={() => onCopyColumn(column.name)}>
                          <CopyIcon aria-hidden="true" size={14} /> Copy selected values
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </th>
              );
            })}
            {showRowActions ? <th aria-label="Row actions" className="table-editor-row-action-header" role="columnheader" /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ incompleteColumns, row, sourceIndex }, rowIndex) => {
            const selectionKey = stableRowKey(table, row, sourceIndex);
            const rowNumber = pageStart + rowIndex + 1;
            return (
              <tr aria-selected={selectedRows.has(selectionKey)} className={selectedRows.has(selectionKey) ? "is-selected" : undefined} key={selectionKey} role="row">
                <td className="table-editor-selection-cell" role="gridcell">
                  <Checkbox
                    aria-label={`Select row ${rowNumber}`}
                    checked={selectedRows.has(selectionKey)}
                    onCheckedChange={() => toggleRow(selectionKey)}
                  />
                </td>
                {columns.map((column, columnIndex) => {
                  const value = row[column.name];
                  const formatted = displayValue(value);
                  const jsonColumn = isJsonColumnType(column.dataType);
                  const position = { columnIndex, rowIndex };
                  const cellSelected = isCellSelected(position, cellSelection);
                  const cellFocused = cellSelection !== undefined
                    && cellSelection.focus.rowIndex === rowIndex
                    && cellSelection.focus.columnIndex === columnIndex;
                  return (
                    <td
                      aria-selected={cellSelected}
                      className={cx(value === null && "is-null", cellSelected && "is-cell-selected", cellFocused && "is-cell-focus")}
                      data-cell-position={`${rowIndex}:${columnIndex}`}
                      key={column.name}
                      onFocus={(event) => {
                        if (!eventOriginatedWithinCurrentTarget(event)) return;
                        if (!cellFocused) selectCell(position, false);
                      }}
                      onKeyDown={(event) => {
                        if (!eventOriginatedWithinCurrentTarget(event)) return;
                        if (jsonColumn && (event.key === "Enter" || event.key === " ")) {
                          event.preventDefault();
                          event.currentTarget.querySelector<HTMLButtonElement>(".table-editor-json-cell-trigger")?.click();
                          return;
                        }
                        moveCellFocus(event, position);
                      }}
                      onPointerDown={(event) => {
                        if (!eventOriginatedWithinCurrentTarget(event)) return;
                        if (event.button !== 0) return;
                        draggingSelection.current = true;
                        event.currentTarget.focus();
                        selectCell(position, event.shiftKey);
                      }}
                      onPointerEnter={(event) => {
                        if (!eventOriginatedWithinCurrentTarget(event)) return;
                        if (draggingSelection.current && event.buttons === 1) selectCell(position, true);
                      }}
                      onPointerUp={(event) => {
                        if (!eventOriginatedWithinCurrentTarget(event)) return;
                        draggingSelection.current = false;
                      }}
                      role="gridcell"
                      tabIndex={cellFocused || (!cellSelection && rowIndex === 0 && columnIndex === 0) ? 0 : -1}
                      title={formatted}
                    >
                      {value === null ? <span>NULL</span> : jsonColumn ? (
                        <JsonCellEditor
                          cacheKey={`json-cell:${tableKey(table)}:${selectionKey}:${column.name}`}
                          canEdit={canUpdate}
                          columnName={column.name}
                          incomplete={incompleteColumns.has(column.name)}
                          onSave={(json) => onUpdate(table, row, { [column.name]: json })}
                          relationName={`${table.schema}.${table.name}`}
                          value={formatted}
                        />
                      ) : formatted || <span className="table-editor-empty-value">EMPTY</span>}
                    </td>
                  );
                })}
                {showRowActions ? (
                  <td className="table-editor-row-action-cell" role="gridcell">
                    <TooltipIconButton
                      aria-label={`Edit row ${rowNumber}`}
                      className="table-editor-row-edit"
                      disabled={!canUpdate}
                      onClick={() => onEditRow(row)}
                      tooltip={canUpdate ? "Edit row" : "A writable connection and primary key are required"}
                      type="button"
                    >
                      <PencilIcon aria-hidden="true" size={13} strokeWidth={1.8} />
                    </TooltipIconButton>
                  </td>
                ) : null}
              </tr>
            );
          })}
          {!rows.length ? (
            <tr>
              <td className="table-editor-no-rows" colSpan={columns.length + 1 + (showRowActions ? 1 : 0)} role="gridcell">No rows match this filter.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function TableMutationStatus({
  busy,
  feedback,
  onApprove,
  onReject,
  pendingApproval,
}: {
  busy: boolean;
  feedback: MutationFeedback | undefined;
  onApprove: () => void;
  onReject: () => void;
  pendingApproval: PendingApproval | undefined;
}) {
  if (!pendingApproval && !feedback) return null;

  const approval = pendingApproval?.effect.approval;
  const tone = pendingApproval ? "notice" : feedback?.tone;
  const message = pendingApproval
    ? `Approval is required to ${databaseActionLabel(pendingApproval.action).toLocaleLowerCase("en-US")}. The change has not been applied.`
    : feedback?.message;

  return (
    <section className="table-editor-mutation-status" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
      <div className="table-editor-mutation-status-icon">
        {tone === "error" ? <CircleAlertIcon aria-hidden="true" size={16} /> : pendingApproval ? <ShieldCheckIcon aria-hidden="true" size={16} /> : <CheckIcon aria-hidden="true" size={16} />}
      </div>
      <div className="table-editor-mutation-status-copy">
        <strong>{pendingApproval ? "Approval required" : tone === "error" ? "Database action failed" : "Database action complete"}</strong>
        <p>{message}</p>
      </div>
      {approval && pendingApproval ? (
        <div className="table-editor-approval-actions">
          <Button disabled={busy} onClick={onReject} size="sm" type="button" variant="outline">
            <CircleAlertIcon aria-hidden="true" size={13} />
            Reject
          </Button>
          <Button disabled={busy} onClick={onApprove} size="sm" type="button">
            {busy ? <LoaderCircleIcon aria-hidden="true" className="spin" size={13} /> : <ShieldCheckIcon aria-hidden="true" size={13} />}
            {busy ? "Working" : "Approve"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function TableMutationDialog({
  busy,
  dialog,
  onClose,
  onDelete,
  onInsert,
  onUpdate,
}: {
  busy: boolean;
  dialog: MutationDialogState | undefined;
  onClose: () => void;
  onDelete: (table: CatalogTable, rows: Array<Record<string, PreviewValue>>) => void;
  onInsert: (table: CatalogTable, values: DatabaseWriteValues) => void;
  onUpdate: (table: CatalogTable, row: Record<string, PreviewValue>, patch: DatabaseWriteValues) => void;
}) {
  if (!dialog) return null;

  const handleOpenChange = (open: boolean) => {
    if (!open && !busy) onClose();
  };

  if (dialog.kind === "delete") {
    const count = dialog.rows.length;
    return (
      <Dialog onOpenChange={handleOpenChange} open>
        <DialogContent className="table-editor-dialog sm:max-w-md" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Delete {count === 1 ? "row" : `${count} rows`}</DialogTitle>
            <DialogDescription>
              {count === 1
                ? `Delete the selected row from ${dialog.table.schema}.${dialog.table.name}?`
                : `Delete ${count} selected rows from ${dialog.table.schema}.${dialog.table.name}?`}
            </DialogDescription>
          </DialogHeader>
          <p className="table-editor-dialog-note">This action uses the table primary key and follows the active approval policy.</p>
          <DialogFooter>
            <Button disabled={busy} onClick={onClose} type="button" variant="outline">Cancel</Button>
            <Button
              className="table-editor-dialog-delete"
              disabled={busy}
              onClick={() => onDelete(dialog.table, dialog.rows)}
              type="button"
            >
              {busy ? <LoaderCircleIcon aria-hidden="true" className="spin" size={15} /> : <Trash2Icon aria-hidden="true" size={15} />}
              Delete {count === 1 ? "row" : "rows"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const isInsert = dialog.kind === "insert";
  const row = dialog.kind === "update" ? dialog.row : undefined;
  const dialogKey = `${dialog.kind}:${tableKey(dialog.table)}:${row ? JSON.stringify(row) : "new"}`;

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent className="table-editor-dialog table-editor-row-dialog max-h-[calc(100dvh-2rem)] overflow-hidden sm:max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{isInsert ? "Add row" : "Edit row"}</DialogTitle>
          <DialogDescription>
            {isInsert
              ? `Add one row to ${dialog.table.schema}.${dialog.table.name}.`
              : `Change one row in ${dialog.table.schema}.${dialog.table.name}. Primary-key values remain fixed.`}
          </DialogDescription>
        </DialogHeader>
        <TableRowMutationForm
          busy={busy}
          key={dialogKey}
          mode={dialog.kind}
          onCancel={onClose}
          onSubmit={(values) => {
            if (dialog.kind === "insert") onInsert(dialog.table, values);
            else onUpdate(dialog.table, dialog.row, values);
          }}
          row={row}
          table={dialog.table}
        />
      </DialogContent>
    </Dialog>
  );
}

function TableFilterBar({
  filters,
  initialColumn,
  onChange,
  onInitialColumnHandled,
  table,
}: {
  filters: TableFilter[];
  initialColumn?: string;
  onChange: (filters: TableFilter[]) => void;
  onInitialColumnHandled: () => void;
  table: CatalogTable | undefined;
}) {
  const [draftColumn, setDraftColumn] = useState<string>();
  const [draftOperator, setDraftOperator] = useState<TableFilterOperator>();
  const [draftValue, setDraftValue] = useState("");

  useEffect(() => {
    if (!initialColumn) return;
    const isKnownColumn = table?.columns.some((column) => column.name === initialColumn);
    if (isKnownColumn && filters.length < MAX_TABLE_FILTERS) {
      setDraftColumn(initialColumn);
      setDraftOperator(undefined);
      setDraftValue("");
    }
    onInitialColumnHandled();
  }, [filters.length, initialColumn, onInitialColumnHandled, table?.columns]);

  const resetDraft = () => {
    setDraftColumn(undefined);
    setDraftOperator(undefined);
    setDraftValue("");
  };

  const chooseColumn = (column: string) => {
    setDraftColumn(column);
    setDraftOperator(undefined);
    setDraftValue("");
  };

  const commitFilter = (operator: TableFilterOperator, rawValue = "") => {
    if (!draftColumn || filters.length >= MAX_TABLE_FILTERS) return;
    const value = tableFilterNeedsValue(operator) ? rawValue.trim() : "";
    if (tableFilterNeedsValue(operator) && !value) return;
    onChange([...filters, { column: draftColumn, operator, value }]);
    resetDraft();
  };

  const chooseOperator = (operator: TableFilterOperator) => {
    if (!tableFilterNeedsValue(operator)) {
      commitFilter(operator);
      return;
    }
    setDraftOperator(operator);
  };

  const selectedColumn = table?.columns.find((column) => column.name === draftColumn);
  const canAddFilter = Boolean(table?.columns.length) && filters.length < MAX_TABLE_FILTERS;
  const placeholder = filters.length
    ? "Add more filters..."
    : tableFilterPlaceholder(table);

  return (
    <div aria-label="Table filters" className={cx("table-editor-filter-bar", filters.length > 0 && "has-filters")}>
      <SearchIcon aria-hidden="true" size={15} />
      <div className="table-editor-filter-scroll">
        {filters.map((filter, index) => {
          const option = tableFilterOperator(filter.operator);
          const value = tableFilterNeedsValue(filter.operator) ? filter.value : option.label;
          return (
            <div
              className="table-editor-active-filter"
              key={`${filter.column}-${filter.operator}-${index}`}
              title={`${filter.column} ${option.label}${filter.value ? ` ${filter.value}` : ""}`}
            >
              <strong>{filter.column}</strong>
              <code>{option.symbol}</code>
              {tableFilterNeedsValue(filter.operator) ? <span>{value}</span> : null}
              <Button
                aria-label={`Remove ${filter.column} filter`}
                onClick={() => onChange(filters.filter((_, filterIndex) => filterIndex !== index))}
                size="icon-xs"
                title="Remove filter"
                type="button"
                variant="ghost"
              >
                <XIcon aria-hidden="true" size={12} />
              </Button>
            </div>
          );
        })}

        {draftColumn === undefined ? (
          <Combobox disabled={!canAddFilter} onValueChange={chooseColumn}>
            <ComboboxTrigger className="table-editor-filter-column-trigger">
              <ComboboxInput
                aria-label="Choose a filter column"
                className="table-editor-filter-column-search"
                placeholder={canAddFilter ? placeholder : filters.length >= MAX_TABLE_FILTERS ? "Filter limit reached" : "Select a table to filter"}
                wrapperClassName="table-editor-filter-column-input"
              />
            </ComboboxTrigger>
            <ComboboxContent className="table-editor-filter-column-menu" sideOffset={5}>
              <ComboboxList ariaLabel="Filter columns" className="table-editor-filter-column-list">
                {table?.columns.map((column) => (
                  <ComboboxItem className="table-editor-filter-column-option" key={column.name} keywords={[column.dataType]} textValue={column.name} value={column.name}>
                    <span>{column.name}</span>
                    <code>{compactDataType(column.dataType)}</code>
                  </ComboboxItem>
                ))}
                <ComboboxEmpty>No columns match this search.</ComboboxEmpty>
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        ) : draftOperator === undefined ? (
          <Popover
            modal={false}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) resetDraft();
            }}
            open
          >
            <PopoverTrigger asChild>
              <Button aria-label={`Choose an operator for ${draftColumn}`} className="table-editor-filter-draft-trigger" size="sm" type="button" variant="ghost">
                <strong>{draftColumn}</strong>
                <ChevronDownIcon aria-hidden="true" size={13} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="table-editor-popover table-editor-filter-operator-menu" side="bottom" sideOffset={5}>
              {TABLE_FILTER_OPERATOR_GROUPS.map((group) => (
                <section className="table-editor-filter-operator-group" key={group.label}>
                  <h3>{group.label}</h3>
                  {group.operators.map((operator) => (
                    <Button key={operator.value} onClick={() => chooseOperator(operator.value)} type="button" variant="ghost">
                      <span>{operator.label}</span>
                      <code>{operator.symbol}</code>
                    </Button>
                  ))}
                </section>
              ))}
            </PopoverContent>
          </Popover>
        ) : (
          <form
            className="table-editor-filter-value-draft"
            onSubmit={(event) => {
              event.preventDefault();
              commitFilter(draftOperator, draftValue);
            }}
          >
            <span title={selectedColumn?.dataType}>{draftColumn}</span>
            <Button
              aria-label={`Change operator for ${draftColumn}`}
              onClick={() => setDraftOperator(undefined)}
              size="xs"
              title={tableFilterOperator(draftOperator).label}
              type="button"
              variant="ghost"
            >
              {tableFilterOperator(draftOperator).symbol}
            </Button>
            {tableFilterNeedsValue(draftOperator) ? (
              <Input
                aria-label={`Filter ${draftColumn} value`}
                autoFocus
                className="table-editor-filter-value-input"
                inputMode={selectedColumn && isNumericColumn(selectedColumn) ? "decimal" : undefined}
                onChange={(event) => setDraftValue(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") resetDraft();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitFilter(draftOperator, event.currentTarget.value);
                  }
                }}
                placeholder="Enter value..."
                value={draftValue}
              />
            ) : null}
            <Button
              aria-label="Apply filter"
              disabled={!draftValue.trim()}
              size="icon-xs"
              title="Apply filter"
              type="submit"
              variant="ghost"
            >
              <SearchIcon aria-hidden="true" size={13} />
            </Button>
            <Button
              aria-label="Cancel filter"
              onClick={resetDraft}
              size="icon-xs"
              title="Cancel filter"
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden="true" size={13} />
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

function TableSortPopover({
  onApply,
  sort,
  table,
}: {
  onApply: (sort: TableSort | undefined) => void;
  sort: TableSort | undefined;
  table: CatalogTable | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [draftSort, setDraftSort] = useState<TableSort>();

  useEffect(() => {
    if (open) setDraftSort(sort ? { ...sort } : undefined);
  }, [open, sort]);

  const hasChanges = !tableSortEqual(draftSort, sort);
  const buttonText = sort ? "Sorted by 1 rule" : "Sort";

  return (
    <Popover modal={false} onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Sort table rows"
          className={cx("table-editor-query-button", sort && "is-active")}
          disabled={!table}
          size="sm"
          title={sort ? `Sorted by ${sort.column} ${sort.direction === "asc" ? "ascending" : "descending"}` : "Sort rows"}
          type="button"
          variant="outline"
        >
          <ArrowUpDownIcon aria-hidden="true" size={14} strokeWidth={1.8} />
          <span>{buttonText}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="table-editor-popover table-editor-sort-popover" side="bottom" sideOffset={6}>
        <div className="table-editor-popover-body">
          {draftSort ? (
            <div className="table-editor-sort-row">
              <div className="table-editor-sort-row-name">
                <span>{"sort by"}</span>
                <strong>{draftSort.column}</strong>
              </div>
              <div className="table-editor-sort-direction">
                <span>ascending:</span>
                <Switch
                  checked={draftSort.direction === "asc"}
                  aria-label={`Sort ${draftSort.column} ${draftSort.direction === "asc" ? "ascending" : "descending"}`}
                  className="table-editor-sort-switch"
                  onCheckedChange={(checked) => setDraftSort((current) => current ? { ...current, direction: checked ? "asc" : "desc" } : current)}
                />
              </div>
              <Button
                aria-label={`Remove sort for ${draftSort.column}`}
                className="table-editor-popover-remove"
                onClick={() => setDraftSort(undefined)}
                size="icon-xs"
                title="Remove sort"
                type="button"
                variant="ghost"
              >
                <XIcon aria-hidden="true" size={14} strokeWidth={1.8} />
              </Button>
            </div>
          ) : (
            <div className="table-editor-popover-empty">
              <strong>No sorts applied to this view</strong>
              <span>Add a column below to sort the view</span>
            </div>
          )}
        </div>
        <div className="table-editor-popover-footer">
          <Select key={draftSort?.column ?? "empty"} onValueChange={(column) => setDraftSort((current) => ({ column, direction: current?.direction ?? "asc" }))}>
            <SelectTrigger aria-label="Choose a column to sort" className="table-editor-popover-pick-select" size="sm">
              <SelectValue placeholder={draftSort ? "Change sort column" : "Pick a column to sort by"} />
            </SelectTrigger>
            <SelectContent className="table-editor-popover-select-content" position="popper">
              {table?.columns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button disabled={!hasChanges} onClick={() => { onApply(draftSort); setOpen(false); }} size="sm" type="button">Apply sorting</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TablePermissionsPopover({
  connection,
  onOpenChange,
  open,
  requiresApproval,
  table,
  tableCanMutate,
  tableHasPrimaryKey,
  writeServiceAvailable,
  writeStateDescription,
  writeStateLabel,
}: {
  connection: Connection | undefined;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  requiresApproval: boolean;
  table: CatalogTable | undefined;
  tableCanMutate: boolean;
  tableHasPrimaryKey: boolean;
  writeServiceAvailable: boolean;
  writeStateDescription: string | undefined;
  writeStateLabel: string;
}) {
  const connectionCanWrite = connection?.connected === true
    && connection.credentialCanWrite !== false;
  const canInsert = writeServiceAvailable && connectionCanWrite && tableCanMutate;
  const canUpdate = canInsert && tableHasPrimaryKey;
  const rows = [
    { label: "Read", state: "Allowed", detail: "Catalog and bounded previews" },
    { label: "Insert", state: canInsert ? "Available" : "Blocked", detail: canInsert ? "Typed action, policy checked" : "Requires a writable base table" },
    { label: "Update", state: canUpdate ? "Available" : "Blocked", detail: canUpdate ? "Primary key and policy checked" : "Requires a primary key" },
    { label: "Delete", state: canUpdate ? "Available" : "Blocked", detail: canUpdate ? "Approval may be required" : "Requires update access" },
  ] as const;

  return (
    <Popover modal={false} onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Show database permissions"
          className="table-editor-query-button table-editor-permission-button"
          disabled={!table}
          size="icon-sm"
          title="Database permissions"
          type="button"
          variant="outline"
        >
          <ShieldCheckIcon aria-hidden="true" size={14} strokeWidth={1.8} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="table-editor-popover table-editor-permissions-popover" side="bottom" sideOffset={6}>
        <div className="table-editor-permissions-summary">
          <header className="table-editor-popover-heading">
            <strong>Database permissions</strong>
            <span>{table ? `${table.schema}.${table.name}` : "Choose a table first."}</span>
          </header>
          <div className="table-editor-permissions-state">
            <ShieldCheckIcon aria-hidden="true" size={17} />
            <div>
              <strong>{writeStateLabel}</strong>
              <span>{writeStateDescription ?? "Permission state is unavailable."}</span>
            </div>
          </div>
          <dl className="table-editor-permissions-grid">
            <div><dt>Connection</dt><dd>{connection?.connected ? connection.dialect : "Unavailable"}</dd></div>
            <div><dt>Table type</dt><dd>{table?.kind ?? "None selected"}</dd></div>
            <div><dt>Primary key</dt><dd>{tableHasPrimaryKey ? "Present" : "Missing"}</dd></div>
            <div><dt>Approval</dt><dd>{requiresApproval ? "Required for writes" : "Policy allows direct writes"}</dd></div>
          </dl>
          <div className="table-editor-permission-list">
            {rows.map((row) => (
              <div key={row.label}>
                <span>{row.label}</span>
                <strong data-state={row.state === "Blocked" ? "blocked" : "available"}>{row.state}</strong>
                <small>{row.detail}</small>
              </div>
            ))}
          </div>
          <p className="table-editor-permissions-note">Permission policy is configured in Settings. Every mutation still passes through the typed action and capability broker.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

type RowMutationField = Readonly<{
  initialNull: boolean;
  initialValue: string;
  isNull: boolean;
  touched: boolean;
  value: string;
}>;

function TableRowMutationForm({
  busy,
  mode,
  onCancel,
  onSubmit,
  row,
  table,
}: {
  busy: boolean;
  mode: "insert" | "update";
  onCancel: () => void;
  onSubmit: (values: DatabaseWriteValues) => void;
  row: Record<string, PreviewValue> | undefined;
  table: CatalogTable;
}) {
  const [fields, setFields] = useState<Record<string, RowMutationField>>(() => createRowMutationFields(table, row));
  const [error, setError] = useState<string>();
  const primaryKey = new Set(table.primaryKey ?? []);

  const updateField = (column: CatalogColumn, next: Partial<RowMutationField>) => {
    setFields((current) => ({
      ...current,
      [column.name]: { ...current[column.name]!, ...next, touched: true },
    }));
    setError(undefined);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values: Record<string, PreviewValue> = {};

    for (const column of table.columns) {
      if (mode === "update" && primaryKey.has(column.name)) continue;
      const field = fields[column.name];
      if (!field) continue;
      const changed = field.isNull !== field.initialNull || (!field.isNull && field.value !== field.initialValue);
      if (mode === "insert" ? !field.touched : !changed) continue;

      const parsed = parseEditorWriteValue(column, field);
      if (parsed === undefined) {
        setError(`Enter a valid value for ${column.name}.`);
        return;
      }
      values[column.name] = parsed;
    }

    if (!Object.keys(values).length) {
      setError(mode === "insert" ? "Enter at least one value before adding a row." : "Change at least one non-primary-key value before saving.");
      return;
    }

    onSubmit(values);
  };

  return (
    <form className="table-editor-row-form" onSubmit={handleSubmit}>
      <div className="table-editor-row-form-fields">
        {table.columns.map((column) => {
          const field = fields[column.name]!;
          const immutable = mode === "update" && primaryKey.has(column.name);
          const nullLabelId = `table-editor-null-${column.name}`;
          const fieldLabelId = `table-editor-field-label-${column.name}`;
          return (
            <div className={cx("table-editor-row-field", immutable && "is-immutable")} key={column.name}>
              <label id={fieldLabelId}>
                <span>{column.name}</span>
                <code>{compactDataType(column.dataType)}</code>
                {!column.nullable ? <span className="table-editor-required-mark">required</span> : null}
              </label>
              {immutable ? (
                <output className="table-editor-immutable-value">{displayValue(row?.[column.name])}</output>
              ) : isBooleanColumn(column) ? (
                <Select
                  onValueChange={(value) => updateField(column, { isNull: false, value: value === "__database_default__" ? "" : value })}
                  value={field.value || (mode === "insert" ? "__database_default__" : "false")}
                >
                  <SelectTrigger
                    aria-labelledby={fieldLabelId}
                    className="table-editor-field-select"
                    disabled={busy || field.isNull}
                    id={`table-editor-value-${column.name}`}
                    size="sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {mode === "insert" ? <SelectItem value="__database_default__">Use database default</SelectItem> : null}
                    <SelectItem value="true">true</SelectItem>
                    <SelectItem value="false">false</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="table-editor-field-input"
                  disabled={busy || field.isNull}
                  id={`table-editor-value-${column.name}`}
                  inputMode={isNumericColumn(column) ? "decimal" : undefined}
                  onChange={(event) => updateField(column, { isNull: false, value: event.currentTarget.value })}
                  type={isNumericColumn(column) ? "number" : "text"}
                  value={field.value}
                />
              )}
              {column.nullable ? (
                <label className="table-editor-null-toggle" htmlFor={nullLabelId}>
                  <Checkbox
                    checked={field.isNull}
                    disabled={busy}
                    id={nullLabelId}
                    onCheckedChange={(checked) => updateField(column, { isNull: checked === true })}
                  />
                  <span>Set NULL</span>
                </label>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? <p className="table-editor-row-form-error" role="alert">{error}</p> : null}
      <DialogFooter>
        <Button disabled={busy} onClick={onCancel} type="button" variant="outline">Cancel</Button>
        <Button disabled={busy} type="submit">
          {busy ? <LoaderCircleIcon aria-hidden="true" className="spin" size={15} /> : null}
          {mode === "insert" ? "Add row" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function TableDefinition({ definition, table }: { definition?: string; table: CatalogTable }) {
  const [copied, setCopied] = useState(false);
  const { resolvedTheme } = useStudioTheme();
  const sql = definition ?? buildClientTableDefinition(table);
  const lineCount = sql.split(/\r?\n/).length;
  const indexCount = (table.indexes ?? []).filter((index) => !index.isConstraint).length;
  const file = useMemo(() => ({ name: `${table.name}.sql`, contents: sql }), [sql, table.name]);
  const options = useMemo(() => ({
    theme: { dark: "pierre-dark" as const, light: "pierre-light" as const },
    themeType: resolvedTheme,
    overflow: "scroll" as const,
    disableFileHeader: true,
    unsafeCSS: `:host { --diffs-bg: var(--table-editor-background); --diffs-light-bg: var(--table-editor-background); --diffs-dark-bg: var(--table-editor-background); --diffs-light: var(--table-editor-text); --diffs-dark: var(--table-editor-text); --diffs-light-number: var(--table-editor-subtle); --diffs-dark-number: var(--table-editor-subtle); --diffs-font-family: var(--font-mono); --diffs-font-size: 12px; --diffs-line-height: 1.55; }`,
  }), [resolvedTheme]);

  const copy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="table-editor-definition">
      <header className="table-editor-definition-header">
        <div className="table-editor-definition-heading">
          <span className="table-editor-definition-icon" aria-hidden="true">
            <FileCode2Icon size={15} strokeWidth={1.8} />
          </span>
          <div className="table-editor-definition-heading-copy">
            <div className="table-editor-definition-title-row">
              <code>{table.name}.sql</code>
              <span className="table-editor-definition-kind">SQL</span>
            </div>
            <div className="table-editor-definition-meta">
              <span>{table.schema}.{table.name}</span>
              <span aria-hidden="true">·</span>
              <span>{lineCount} lines</span>
              {indexCount ? <><span aria-hidden="true">·</span><span>{indexCount} {indexCount === 1 ? "index" : "indexes"}</span></> : null}
            </div>
          </div>
        </div>
        <div className="table-editor-definition-actions">
          <span className="table-editor-definition-readonly"><EyeIcon aria-hidden="true" size={13} /> Read only</span>
          <Button className="table-editor-definition-copy" onClick={() => void copy()} size="sm" type="button" variant="outline">
            {copied ? <CheckIcon aria-hidden="true" size={14} /> : <CopyIcon aria-hidden="true" size={14} />}
            {copied ? "Copied" : "Copy SQL"}
          </Button>
        </div>
      </header>
      <div className="table-editor-definition-editor" role="region" aria-label="SQL table definition">
        <HighlightedFile className="table-editor-definition-code" file={file} options={options} />
      </div>
    </section>
  );
}

function TableGridLoading({ columns, showRowActions }: { columns: CatalogColumn[]; showRowActions: boolean }) {
  const loadingColumns = columns.length
    ? columns.map((column) => column.name)
    : Array.from({ length: 5 }, (_, index) => `loading-column-${index}`);

  return (
    <div className="table-editor-grid-scroll">
      <table aria-busy="true" aria-label="Loading table preview" className="table-editor-grid table-editor-grid-loading">
        <colgroup>
          <col className="table-editor-selection-column" />
          {loadingColumns.map((column) => <col className="table-editor-data-column" key={column} />)}
          {showRowActions ? <col className="table-editor-row-action-column" /> : null}
        </colgroup>
        <thead>
          <tr>
            <th className="table-editor-selection-cell"><Skeleton className="table-editor-loading-checkbox" /></th>
            {loadingColumns.map((column) => <th key={column}><Skeleton /></th>)}
            {showRowActions ? <th className="table-editor-row-action-header" /> : null}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 12 }, (_, rowIndex) => (
            <tr key={rowIndex}>
              <td className="table-editor-selection-cell"><Skeleton className="table-editor-loading-checkbox" /></td>
              {loadingColumns.map((column, columnIndex) => <td key={column}><Skeleton style={{ width: `${48 + ((rowIndex * 17 + columnIndex * 13) % 35)}%` }} /></td>)}
              {showRowActions ? <td className="table-editor-row-action-cell" /> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableEditorTreeLoading() {
  return (
    <div aria-label="Loading database tables" className="table-editor-tree-loading">
      {Array.from({ length: 14 }, (_, index) => (
        <Skeleton key={index} style={{ width: `${61 + ((index * 17) % 34)}%` }} />
      ))}
    </div>
  );
}

function TableEditorNotice({ children }: { children: string | undefined }) {
  return (
    <Alert className="table-editor-notice" role="status">
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function TableEditorEmpty({ text, title }: { text: string; title: string }) {
  return (
    <div className="table-editor-empty">
      <Table2Icon aria-hidden="true" size={22} strokeWidth={1.6} />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function tableEditorStorageKey(catalog: Catalog | undefined): string {
  if (!catalog) return `tessera.table-editor:${TABLE_EDITOR_STORAGE_VERSION}:pending`;
  return `tessera.table-editor:${TABLE_EDITOR_STORAGE_VERSION}:${catalog.dialect}:${encodeURIComponent(catalog.databaseName)}`;
}

/**
 * The drawer only retains navigation chrome, never query results or values
 * from the database. A re-open always fetches a fresh bounded preview.
 */
function readPersistedTableEditorState(storageKey: string): PersistedTableEditorState | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== TABLE_EDITOR_STORAGE_VERSION || !isRecord(parsed.state)) return undefined;
    const state = parsed.state;
    const openTableKeys = Array.isArray(state.openTableKeys)
      ? state.openTableKeys.filter((value): value is string => typeof value === "string" && value.length <= 513).slice(0, 24)
      : [];
    const recentTables = Array.isArray(state.recentTables)
      ? state.recentTables.flatMap((value): RecentTableVisit[] => {
        if (!isRecord(value)) return [];
        const key = safeStoredOptionalText(value.key);
        const openedAt = typeof value.openedAt === "number" && Number.isFinite(value.openedAt) && value.openedAt > 0
          ? Math.floor(value.openedAt)
          : undefined;
        return key && openedAt ? [{ key, openedAt }] : [];
      }).slice(0, 8)
      : [];
    return {
      activeWorkspace: state.activeWorkspace === "new" ? "new" : "table",
      openTableKeys,
      page: typeof state.page === "number" && Number.isInteger(state.page) && state.page > 0 ? Math.min(state.page, 10_000) : 1,
      recentTables,
      selectedSchema: safeStoredOptionalText(state.selectedSchema),
      selectedTableKey: safeStoredOptionalText(state.selectedTableKey),
      sidebarCollapsed: state.sidebarCollapsed === true,
      tableSearch: safeStoredText(state.tableSearch),
      view: state.view === "definition" ? "definition" : "data",
    };
  } catch {
    return undefined;
  }
}

function writePersistedTableEditorState(storageKey: string, state: PersistedTableEditorState): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ version: TABLE_EDITOR_STORAGE_VERSION, state }));
  } catch {
    // Persistence is an enhancement. The table browser stays fully usable.
  }
}

function safeStoredText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 512) : "";
}

function safeStoredOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 513 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tableKey(table: Pick<CatalogTable, "name" | "schema">): string {
  return `${table.schema}\u0000${table.name}`;
}

function recentVisitLabel(openedAt: number, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - openedAt) / 1_000));
  if (elapsedSeconds < 60) return "Just now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short" }).format(openedAt);
}

function isMutableTable(table: CatalogTable): boolean {
  return table.kind === "table" || table.kind === "partitioned-table";
}

function databaseActionEnvelope(catalog: Catalog, table: CatalogTable): DatabaseActionEnvelope {
  return {
    version: 1,
    connectionRef: catalog.connectionRef,
    databaseRef: catalog.databaseName,
    catalogFingerprint: catalog.fingerprint,
    relation: { schema: table.schema, table: table.name },
  };
}

function databaseActionReturning(
  catalog: Catalog,
  table: CatalogTable,
): Readonly<{ returning?: string[] }> {
  return catalog.dialect === "postgres" && table.primaryKey?.length
    ? { returning: [...table.primaryKey] }
    : {};
}

function databaseActionLabel(action: StudioDatabaseAction): string {
  switch (action.kind) {
    case "data.insert":
      return "Insert";
    case "data.update":
      return "Update";
    case "data.delete":
      return "Delete";
    case "data.ddl":
      return "Schema change";
  }
}

function createDatabaseActionRequestId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId
    ? `studio-database-${randomId}`
    : `studio-database-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function primaryKeyPredicate(
  table: CatalogTable,
  row: Record<string, PreviewValue>,
): DatabaseActionPredicate | undefined {
  const primaryKey = table.primaryKey;
  if (!primaryKey?.length) return undefined;

  const items = primaryKey.map((column) => {
    const value = row[column];
    if (value === null || value === undefined) return undefined;
    return { kind: "comparison" as const, column, op: "eq" as const, value };
  });
  if (items.some((item) => item === undefined)) return undefined;

  return { kind: "all", items: items as Array<Extract<DatabaseActionPredicate, { kind: "comparison" }>> };
}

function selectedPrimaryKeyPredicate(
  table: CatalogTable,
  rows: Array<Record<string, PreviewValue>>,
): DatabaseActionPredicate | undefined {
  const items = rows.map((row) => primaryKeyPredicate(table, row));
  if (!items.length || items.some((item) => item === undefined)) return undefined;
  const predicates = items as DatabaseActionPredicate[];
  return predicates.length === 1 ? predicates[0] : { kind: "any", items: predicates };
}

function stableRowKey(
  table: CatalogTable,
  row: Record<string, PreviewValue>,
  sourceIndex: number,
): string {
  const primaryKey = table.primaryKey;
  if (primaryKey?.length) {
    const values = primaryKey.map((column) => row[column]);
    if (values.every((value) => value !== null && value !== undefined)) {
      return `primary:${tableKey(table)}:${JSON.stringify(values)}`;
    }
  }
  return `preview:${tableKey(table)}:${sourceIndex}`;
}

function toggleSelectionKey(values: Set<string>, value: string): Set<string> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function createRowMutationFields(
  table: CatalogTable,
  row: Record<string, PreviewValue> | undefined,
): Record<string, RowMutationField> {
  return Object.fromEntries(table.columns.map((column) => {
    const source = row?.[column.name];
    const initialNull = source === null;
    return [column.name, {
      initialNull,
      initialValue: source === null || source === undefined ? "" : String(source),
      isNull: initialNull,
      touched: false,
      value: source === null || source === undefined ? "" : String(source),
    }];
  }));
}

function parseEditorWriteValue(
  column: CatalogColumn,
  field: RowMutationField,
): PreviewValue | undefined {
  if (field.isNull) return null;
  if (isBooleanColumn(column)) {
    if (field.value === "true") return true;
    if (field.value === "false") return false;
    return undefined;
  }
  if (isNumericColumn(column)) {
    if (!field.value.trim()) return undefined;
    const value = Number(field.value);
    return Number.isFinite(value) ? value : undefined;
  }
  return field.value;
}

function isBooleanColumn(column: CatalogColumn): boolean {
  return /\b(bool|boolean)\b/i.test(column.dataType);
}

function isNumericColumn(column: CatalogColumn): boolean {
  return /\b(?:smallint|bigint|integer|int\d*|serial|decimal|numeric|real|double precision|float\d*|money)\b/i.test(column.dataType);
}

function compactDataType(value: string): string {
  return value
    .replace("timestamp with time zone", "timestamptz")
    .replace("character varying", "varchar")
    .replace(" without time zone", "");
}

function buildClientTableDefinition(table: CatalogTable): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const relation = `${quote(table.schema)}.${quote(table.name)}`;
  const lines = table.columns
    .slice()
    .sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0))
    .map((column) => `  ${quote(column.name)} ${column.dataType}${column.nullable ? "" : " NOT NULL"}${column.defaultValue ? ` DEFAULT ${column.defaultValue}` : ""}`);
  if (table.primaryKey?.length) lines.push(`  CONSTRAINT ${quote(`${table.name}_pkey`)} PRIMARY KEY (${table.primaryKey.map(quote).join(", ")})`);
  for (const foreignKey of table.foreignKeys ?? []) {
    lines.push(`  CONSTRAINT ${quote(foreignKey.name)} FOREIGN KEY (${foreignKey.columns.map(quote).join(", ")}) REFERENCES ${quote(foreignKey.referencedSchema)}.${quote(foreignKey.referencedTable)} (${foreignKey.referencedColumns.map(quote).join(", ")})`);
  }
  const tableDefinition = `CREATE TABLE ${relation} (\n${lines.join(",\n")}\n);`;
  const indexDefinitions = (table.indexes ?? [])
    .filter((index) => !index.isConstraint)
    .map((index) => index.definition?.trim() || `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${relation}${index.method ? ` USING ${index.method}` : ""} (${index.columns.map(quote).join(", ")})`)
    .map((index) => index.endsWith(";") ? index : `${index};`);
  return [tableDefinition, ...indexDefinitions].join("\n\n");
}

type TableFilterOperatorOption = Readonly<{
  label: string;
  symbol: string;
  value: TableFilterOperator;
}>;

const TABLE_FILTER_OPERATORS: readonly TableFilterOperatorOption[] = [
  { label: "Equals", symbol: "=", value: "equals" },
  { label: "Not equal", symbol: "<>", value: "not_equals" },
  { label: "Greater than", symbol: ">", value: "gt" },
  { label: "Less than", symbol: "<", value: "lt" },
  { label: "Greater or equal", symbol: ">=", value: "gte" },
  { label: "Less or equal", symbol: "<=", value: "lte" },
  { label: "Contains", symbol: "~~", value: "contains" },
  { label: "Is null", symbol: "NULL", value: "is_null" },
  { label: "Is not null", symbol: "NOT NULL", value: "is_not_null" },
] as const;

const TABLE_FILTER_OPERATOR_GROUPS: ReadonlyArray<Readonly<{
  label: string;
  operators: readonly TableFilterOperatorOption[];
}>> = [
  { label: "Comparison", operators: TABLE_FILTER_OPERATORS.slice(0, 6) },
  { label: "Pattern matching", operators: TABLE_FILTER_OPERATORS.slice(6, 7) },
  { label: "Null", operators: TABLE_FILTER_OPERATORS.slice(7) },
];

function tableFilterOperator(operator: TableFilterOperator): TableFilterOperatorOption {
  return TABLE_FILTER_OPERATORS.find((option) => option.value === operator) ?? TABLE_FILTER_OPERATORS[0]!;
}

function tableFilterPlaceholder(table: CatalogTable | undefined): string {
  const names = table?.columns.slice(0, 3).map((column) => column.name) ?? [];
  return names.length ? `Filter by ${names.join(", ")}...` : "Select a table to filter";
}

function tableFilterNeedsValue(operator: TableFilterOperator): boolean {
  return operator !== "is_null" && operator !== "is_not_null";
}

function tableSortEqual(left: TableSort | undefined, right: TableSort | undefined): boolean {
  return left?.column === right?.column && left?.direction === right?.direction;
}

function displayValue(value: PreviewValue | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function selectedCellsToTsv(
  columns: CatalogColumn[],
  rows: PreviewRow[],
  selection: TableCellSelection,
): string {
  const firstRow = Math.max(0, Math.min(selection.anchor.rowIndex, selection.focus.rowIndex));
  const lastRow = Math.min(rows.length - 1, Math.max(selection.anchor.rowIndex, selection.focus.rowIndex));
  const firstColumn = Math.max(0, Math.min(selection.anchor.columnIndex, selection.focus.columnIndex));
  const lastColumn = Math.min(columns.length - 1, Math.max(selection.anchor.columnIndex, selection.focus.columnIndex));
  if (firstRow > lastRow || firstColumn > lastColumn) return "";

  return rows
    .slice(firstRow, lastRow + 1)
    .map(({ row }) => columns
      .slice(firstColumn, lastColumn + 1)
      .map((column) => displayValue(row[column.name]).replaceAll("\t", " ").replace(/\r?\n/g, " "))
      .join("\t"))
    .join("\n");
}

async function writeTextToClipboard(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back to the browser's synchronous clipboard command below.
    }
  }
  if (typeof document === "undefined") return false;

  const clipboardSource = document.createElement("textarea");
  clipboardSource.value = value;
  clipboardSource.setAttribute("aria-hidden", "true");
  clipboardSource.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(clipboardSource);
  clipboardSource.focus();
  clipboardSource.select();
  try {
    return document.execCommand("copy");
  } finally {
    clipboardSource.remove();
  }
}

function publicError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Tessera could not load this table preview.";
}
