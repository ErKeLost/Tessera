import { describe, expect, test } from "bun:test";
import {
  INITIAL_TABLE_EDITOR_WORKSPACE_STATE,
  closeTableTabs,
  recordRecentTable,
  tableEditorWorkspaceReducer,
  type TableEditorWorkspaceState,
} from "./table-editor-workspace";

function state(activeKey: string | "new" = "b"): TableEditorWorkspaceState {
  return {
    active: activeKey === "new" ? { kind: "new" } : { key: activeKey, kind: "table" },
    openTableKeys: ["a", "b", "c"],
    recentTables: [],
    sidebarCollapsed: false,
  };
}

describe("Table Editor workspace state", () => {
  test("closes the active tab and prefers its right neighbor", () => {
    expect(closeTableTabs(state(), "b", "close")).toMatchObject({
      active: { key: "c", kind: "table" },
      openTableKeys: ["a", "c"],
    });
  });

  test("closes the last tab into the pinned New workspace", () => {
    const only: TableEditorWorkspaceState = {
      ...state("a"),
      openTableKeys: ["a"],
    };
    expect(closeTableTabs(only, "a", "close")).toMatchObject({
      active: { kind: "new" },
      openTableKeys: [],
    });
  });

  test("supports every context-menu close command deterministically", () => {
    expect(closeTableTabs(state("c"), "b", "close-others")).toMatchObject({
      active: { key: "b", kind: "table" },
      openTableKeys: ["b"],
    });
    expect(closeTableTabs(state("c"), "b", "close-right")).toMatchObject({
      active: { key: "b", kind: "table" },
      openTableKeys: ["a", "b"],
    });
    expect(closeTableTabs(state(), "b", "close-all")).toMatchObject({
      active: { kind: "new" },
      openTableKeys: [],
    });
    const unchanged = state();
    expect(closeTableTabs(unchanged, "missing", "close")).toBe(unchanged);
  });

  test("keeps recent tables ordered, unique, and bounded", () => {
    let visits = recordRecentTable([], "table-0", 1);
    for (let index = 1; index < 10; index += 1) {
      visits = recordRecentTable(visits, `table-${index}`, index + 1);
    }
    visits = recordRecentTable(visits, "table-7", 20);
    expect(visits).toHaveLength(8);
    expect(visits[0]).toEqual({ key: "table-7", openedAt: 20 });
    expect(visits.filter(({ key }) => key === "table-7")).toHaveLength(1);
  });

  test("prunes stale catalog keys without reopening a table from New", () => {
    const restored = tableEditorWorkspaceReducer(INITIAL_TABLE_EDITOR_WORKSPACE_STATE, {
      state: state("new"),
      type: "restore",
    });
    const pruned = tableEditorWorkspaceReducer(restored, {
      type: "prune",
      validTableKeys: new Set(["a", "c"]),
    });
    expect(pruned.active).toEqual({ kind: "new" });
    expect(pruned.openTableKeys).toEqual(["a", "c"]);
  });
});
