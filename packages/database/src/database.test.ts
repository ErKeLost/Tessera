import { describe, expect, test } from "bun:test";
import {
  catalogStats,
  finalizeCatalog,
  summarizeCatalog,
} from "./index";

const catalog = finalizeCatalog({
  connectorId: "primary",
  dialect: "postgres",
  databaseName: "warehouse",
  scannedAt: "2026-08-15T00:00:00.000Z",
  schemas: [{
    name: "public",
    tables: [{
      schema: "public",
      name: "orders",
      kind: "table",
      columns: [{ name: "id", dataType: "uuid", nullable: false, ordinal: 1 }],
      primaryKey: ["id"],
      foreignKeys: [],
      indexes: [{ name: "orders_status_idx", columns: ["status"], unique: false, method: "btree", isConstraint: false }],
    }],
  }],
});

describe("database catalog", () => {
  test("creates deterministic fingerprints", () => {
    expect(catalog.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(finalizeCatalog({ ...catalog, fingerprint: undefined } as never).fingerprint).toBe(catalog.fingerprint);
  });

  test("keeps lineage stable when only the catalog scan time changes", () => {
    const refreshed = finalizeCatalog({
      ...catalog,
      fingerprint: undefined,
      scannedAt: "2026-08-16T00:00:00.000Z",
    } as never);
    const changedStructure = finalizeCatalog({
      ...catalog,
      fingerprint: undefined,
      schemas: [{
        ...catalog.schemas[0],
        tables: [{
          ...catalog.schemas[0]!.tables[0]!,
          columns: [
            ...catalog.schemas[0]!.tables[0]!.columns,
            { name: "status", dataType: "text", nullable: true, ordinal: 2 },
          ],
        }],
      }],
    } as never);

    expect(refreshed.fingerprint).toBe(catalog.fingerprint);
    expect(changedStructure.fingerprint).not.toBe(catalog.fingerprint);
  });

  test("summarizes model context without comments by default", () => {
    const summary = JSON.parse(summarizeCatalog(catalog));
    expect(summary.tables[0]).toMatchObject({ schema: "public", name: "orders" });
    expect(summary.tables[0].columns[0]).toEqual({ name: "id", nullable: false, type: "uuid" });
  });

  test("reports aggregate catalog counts", () => {
    expect(catalogStats(catalog)).toEqual({ schemaCount: 1, tableCount: 1, columnCount: 1 });
  });

  test("keeps indexes in the catalog summary and fingerprint", () => {
    const summary = JSON.parse(summarizeCatalog(catalog));
    expect(summary.tables[0].indexes).toEqual([{
      name: "orders_status_idx",
      columns: ["status"],
      unique: false,
      method: "btree",
      isConstraint: false,
    }]);
    const withoutIndex = finalizeCatalog({
      ...catalog,
      fingerprint: undefined,
      schemas: [{
        ...catalog.schemas[0]!,
        tables: [{ ...catalog.schemas[0]!.tables[0]!, indexes: [] }],
      }],
    } as never);
    expect(withoutIndex.fingerprint).not.toBe(catalog.fingerprint);
  });
});
