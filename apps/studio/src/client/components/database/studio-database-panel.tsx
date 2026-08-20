import { DatabaseIcon, RefreshCwIcon, Table2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  fetchStudioTablePreview,
  type StudioCatalog,
  type StudioCatalogTable,
  type StudioConnection,
  type StudioTablePreview,
} from "../../api/studio-api";
import { Button } from "../motion/button";

type SelectedTable = Readonly<{ schema: string; table: StudioCatalogTable }>;

export function StudioDatabasePanel({
  catalog,
  catalogError,
  connection,
  connectionError,
  onClose,
  onRefresh,
  open,
  refreshing,
}: {
  catalog: StudioCatalog | undefined;
  catalogError?: string;
  connection: StudioConnection | undefined;
  connectionError?: string;
  onClose(): void;
  onRefresh(): void;
  open: boolean;
  refreshing: boolean;
}) {
  const tables = useMemo<SelectedTable[]>(
    () => catalog?.schemas.flatMap((schema) => schema.tables.map((table) => ({ schema: schema.name, table }))) ?? [],
    [catalog],
  );
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string>();
  const [preview, setPreview] = useState<StudioTablePreview>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const selected = tables.find(({ schema, table }) => tableKey(schema, table.name) === selectedKey) ?? tables[0];
  const filteredTables = tables.filter(({ schema, table }) => `${schema}.${table.name}`.toLocaleLowerCase("en-US").includes(query.trim().toLocaleLowerCase("en-US")));

  useEffect(() => {
    if (!open || selectedKey || !tables[0]) return;
    setSelectedKey(tableKey(tables[0].schema, tables[0].table.name));
  }, [open, selectedKey, tables]);

  useEffect(() => {
    if (!open || !selected) {
      setPreview(undefined);
      setPreviewError(undefined);
      return;
    }
    const controller = new AbortController();
    setPreviewLoading(true);
    setPreviewError(undefined);
    void fetchStudioTablePreview(selected.schema, selected.table.name, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setPreview(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreviewError("Unable to load representative rows.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });
    return () => controller.abort();
  }, [open, selected]);

  return (
    <section aria-label="Database explorer" className="studio-database-panel" aria-hidden={!open}>
      <header className="studio-database-panel-header">
        <div className="studio-database-panel-title">
          <DatabaseIcon aria-hidden="true" size={18} />
          <div>
            <h2>Database</h2>
            <span>{connection?.connected ? connection.databaseName ?? catalog?.databaseName ?? "Connected" : "Not connected"}</span>
          </div>
        </div>
        <div className="studio-database-panel-actions">
          <Button aria-label="Refresh database catalog" disabled={refreshing} onClick={onRefresh} size="icon" type="button" variant="ghost">
            <RefreshCwIcon aria-hidden="true" className={refreshing ? "spin" : undefined} size={16} />
          </Button>
          <Button aria-label="Close database explorer" onClick={onClose} size="icon" type="button" variant="ghost">
            <XIcon aria-hidden="true" size={17} />
          </Button>
        </div>
      </header>
      {connectionError || catalogError ? (
        <p className="studio-database-panel-notice" role="alert">{connectionError ?? catalogError}</p>
      ) : null}
      {!catalog ? (
        <div className="studio-database-panel-empty">
          <DatabaseIcon aria-hidden="true" size={20} />
          <p>Connect a database in workspace settings to browse its tables.</p>
        </div>
      ) : (
        <div className="studio-database-browser">
          <aside className="studio-database-table-list">
            <label className="sr-only" htmlFor="database-table-search">Filter tables</label>
            <input id="database-table-search" onChange={(event) => setQuery(event.target.value)} placeholder="Filter tables" type="search" value={query} />
            <div className="studio-database-table-items">
              {filteredTables.map(({ schema, table }) => {
                const key = tableKey(schema, table.name);
                return (
                  <button className={key === selectedKey || (!selectedKey && selected?.table === table) ? "is-selected" : undefined} key={key} onClick={() => setSelectedKey(key)} type="button">
                    <Table2Icon aria-hidden="true" size={15} />
                    <span>{table.name}</span>
                    <small>{schema}</small>
                  </button>
                );
              })}
              {filteredTables.length === 0 ? <p>No matching tables.</p> : null}
            </div>
          </aside>
          <section className="studio-database-table-detail" aria-live="polite">
            {selected ? <DatabaseTableDetail preview={preview} previewError={previewError} previewLoading={previewLoading} selected={selected} /> : <p>No tables are available.</p>}
          </section>
        </div>
      )}
    </section>
  );
}

function DatabaseTableDetail({
  preview,
  previewError,
  previewLoading,
  selected,
}: {
  preview: StudioTablePreview | undefined;
  previewError: string | undefined;
  previewLoading: boolean;
  selected: SelectedTable;
}) {
  const { table } = selected;
  const columns = preview?.columns ?? table.columns;
  return (
    <>
      <header className="studio-database-table-heading">
        <div>
          <span>{selected.schema}</span>
          <h2>{table.name}</h2>
        </div>
        <p>{table.kind} · {columns.length} columns{preview?.totalRowCount === undefined ? "" : ` · ${preview.totalRowCount.toLocaleString()} rows`}</p>
      </header>
      <section className="studio-database-columns">
        <h3>Columns</h3>
        <div role="table">
          {columns.map((column) => (
            <div key={column.name} role="row">
              <strong role="cell">{column.name}</strong>
              <span role="cell">{column.dataType}</span>
              <span role="cell">{column.nullable ? "Nullable" : "Required"}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="studio-database-preview">
        <h3>Representative rows</h3>
        {previewLoading ? <p>Loading rows...</p> : null}
        {previewError ? <p className="studio-database-panel-notice">{previewError}</p> : null}
        {preview && preview.rows.length > 0 ? <PreviewTable columns={preview.columns.map((column) => column.name)} rows={preview.rows} /> : null}
        {preview && preview.rows.length === 0 ? <p>No rows are available for preview.</p> : null}
      </section>
    </>
  );
}

function PreviewTable({ columns, rows }: { columns: readonly string[]; rows: readonly Record<string, string | number | boolean | null>[] }) {
  return (
    <div className="studio-database-preview-scroll">
      <table>
        <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}>{displayValue(row[column])}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

function displayValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  return String(value);
}

function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}
