export type TableEditorWorkspace =
  | Readonly<{ kind: "new" }>
  | Readonly<{ key: string; kind: "table" }>;

export type RecentTableVisit = Readonly<{
  key: string;
  openedAt: number;
}>;

export type TableEditorWorkspaceState = Readonly<{
  active: TableEditorWorkspace;
  openTableKeys: readonly string[];
  recentTables: readonly RecentTableVisit[];
  sidebarCollapsed: boolean;
}>;

export type TableTabCloseCommand = "close" | "close-others" | "close-right" | "close-all";

export type TableEditorWorkspaceAction =
  | Readonly<{ state: TableEditorWorkspaceState; type: "restore" }>
  | Readonly<{ key: string; openedAt: number; type: "open-table" }>
  | Readonly<{ type: "open-new" }>
  | Readonly<{ command: TableTabCloseCommand; key: string; type: "close-tabs" }>
  | Readonly<{ collapsed?: boolean; type: "toggle-sidebar" }>
  | Readonly<{ validTableKeys: ReadonlySet<string>; type: "prune" }>;

export const INITIAL_TABLE_EDITOR_WORKSPACE_STATE: TableEditorWorkspaceState = Object.freeze({
  active: Object.freeze({ kind: "new" }),
  openTableKeys: Object.freeze([]),
  recentTables: Object.freeze([]),
  sidebarCollapsed: false,
});

const MAX_RECENT_TABLES = 8;

export function tableEditorWorkspaceReducer(
  state: TableEditorWorkspaceState,
  action: TableEditorWorkspaceAction,
): TableEditorWorkspaceState {
  switch (action.type) {
    case "restore":
      return normalizeWorkspaceState(action.state);
    case "open-table": {
      const openTableKeys = state.openTableKeys.includes(action.key)
        ? state.openTableKeys
        : [...state.openTableKeys, action.key];
      return {
        ...state,
        active: { key: action.key, kind: "table" },
        openTableKeys,
        recentTables: recordRecentTable(state.recentTables, action.key, action.openedAt),
      };
    }
    case "open-new":
      return state.active.kind === "new" ? state : { ...state, active: { kind: "new" } };
    case "close-tabs":
      return closeTableTabs(state, action.key, action.command);
    case "toggle-sidebar": {
      const sidebarCollapsed = action.collapsed ?? !state.sidebarCollapsed;
      return sidebarCollapsed === state.sidebarCollapsed ? state : { ...state, sidebarCollapsed };
    }
    case "prune": {
      const openTableKeys = state.openTableKeys.filter((key) => action.validTableKeys.has(key));
      const recentTables = state.recentTables.filter(({ key }) => action.validTableKeys.has(key));
      const active = state.active.kind === "table" && !action.validTableKeys.has(state.active.key)
        ? workspaceForLastTable(openTableKeys)
        : state.active;
      if (
        arraysEqual(openTableKeys, state.openTableKeys)
        && recentVisitsEqual(recentTables, state.recentTables)
        && active === state.active
      ) return state;
      return { ...state, active, openTableKeys, recentTables };
    }
  }
}

export function closeTableTabs(
  state: TableEditorWorkspaceState,
  targetKey: string,
  command: TableTabCloseCommand,
): TableEditorWorkspaceState {
  const targetIndex = state.openTableKeys.indexOf(targetKey);
  if (targetIndex === -1) return state;

  if (command === "close-all") {
    return { ...state, active: { kind: "new" }, openTableKeys: [] };
  }

  if (command === "close-others") {
    return {
      ...state,
      active: { key: targetKey, kind: "table" },
      openTableKeys: [targetKey],
    };
  }

  if (command === "close-right") {
    const openTableKeys = state.openTableKeys.slice(0, targetIndex + 1);
    const active = state.active.kind === "table" && !openTableKeys.includes(state.active.key)
      ? { key: targetKey, kind: "table" } as const
      : state.active;
    if (arraysEqual(openTableKeys, state.openTableKeys) && active === state.active) return state;
    return { ...state, active, openTableKeys };
  }

  const openTableKeys = state.openTableKeys.filter((key) => key !== targetKey);
  if (state.active.kind !== "table" || state.active.key !== targetKey) {
    return { ...state, openTableKeys };
  }
  const neighborKey = state.openTableKeys[targetIndex + 1] ?? state.openTableKeys[targetIndex - 1];
  return {
    ...state,
    active: neighborKey ? { key: neighborKey, kind: "table" } : { kind: "new" },
    openTableKeys,
  };
}

export function recordRecentTable(
  visits: readonly RecentTableVisit[],
  key: string,
  openedAt: number,
): readonly RecentTableVisit[] {
  const safeOpenedAt = Number.isFinite(openedAt) && openedAt > 0 ? Math.floor(openedAt) : Date.now();
  return [
    { key, openedAt: safeOpenedAt },
    ...visits.filter((visit) => visit.key !== key),
  ].slice(0, MAX_RECENT_TABLES);
}

function normalizeWorkspaceState(state: TableEditorWorkspaceState): TableEditorWorkspaceState {
  const openTableKeys = uniqueKeys(state.openTableKeys);
  const recentTables = state.recentTables
    .filter(({ key, openedAt }) => typeof key === "string" && key.length > 0 && Number.isFinite(openedAt) && openedAt > 0)
    .filter((visit, index, visits) => visits.findIndex(({ key }) => key === visit.key) === index)
    .slice(0, MAX_RECENT_TABLES);
  const active = state.active.kind === "table" && !openTableKeys.includes(state.active.key)
    ? workspaceForLastTable(openTableKeys)
    : state.active;
  return { active, openTableKeys, recentTables, sidebarCollapsed: state.sidebarCollapsed === true };
}

function uniqueKeys(keys: readonly string[]): readonly string[] {
  return keys
    .filter((key): key is string => typeof key === "string" && key.length > 0)
    .filter((key, index, values) => values.indexOf(key) === index)
    .slice(0, 24);
}

function workspaceForLastTable(keys: readonly string[]): TableEditorWorkspace {
  const key = keys.at(-1);
  return key ? { key, kind: "table" } : { kind: "new" };
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recentVisitsEqual(left: readonly RecentTableVisit[], right: readonly RecentTableVisit[]): boolean {
  return left.length === right.length
    && left.every((visit, index) => visit.key === right[index]?.key && visit.openedAt === right[index]?.openedAt);
}
