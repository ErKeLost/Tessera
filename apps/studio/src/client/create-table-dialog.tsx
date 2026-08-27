import { KeyRoundIcon, LoaderCircleIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";

export type CreateTableDialect = "postgres" | "mysql" | "sqlite" | "turso" | "mongodb";

export type CreateTableColumn = Readonly<{
  dataType: string;
  name: string;
  nullable: boolean;
  primaryKey: boolean;
}>;

export type CreateTableDraft = Readonly<{
  columns: readonly CreateTableColumn[];
  name: string;
  schema: string;
}>;

type ColumnDraft = CreateTableColumn & Readonly<{ id: string }>;

type CreateTableDialogProps = Readonly<{
  busy: boolean;
  dialect: CreateTableDialect;
  existingRelations: readonly Readonly<{ name: string; schema: string }>[];
  initialSchema?: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: CreateTableDraft) => void;
  open: boolean;
  schemas: readonly string[];
}>;

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/u;
const MAX_CREATE_TABLE_COLUMNS = 64;

export function CreateTableDialog(props: CreateTableDialogProps) {
  if (!props.open) return null;
  return <CreateTableDialogContent {...props} />;
}

function CreateTableDialogContent({
  busy,
  dialect,
  existingRelations,
  initialSchema,
  onOpenChange,
  onSubmit,
  schemas,
}: CreateTableDialogProps) {
  const [schema, setSchema] = useState(() => (
    initialSchema && schemas.includes(initialSchema) ? initialSchema : schemas[0] ?? ""
  ));
  const [name, setName] = useState("");
  const [columns, setColumns] = useState<ColumnDraft[]>([
    { dataType: defaultDataType(dialect), id: "column-1", name: "id", nullable: false, primaryKey: true },
  ]);
  const [error, setError] = useState<string>();
  const nextColumnId = useRef(2);
  const dataTypes = dataTypesForDialect(dialect);

  const updateColumn = (id: string, patch: Partial<CreateTableColumn>) => {
    setColumns((current) => current.map((column) => column.id === id
      ? {
        ...column,
        ...patch,
        ...(patch.primaryKey === true ? { nullable: false } : {}),
      }
      : column));
    setError(undefined);
  };

  const addColumn = () => {
    if (columns.length >= MAX_CREATE_TABLE_COLUMNS) return;
    const id = `column-${nextColumnId.current}`;
    nextColumnId.current += 1;
    setColumns((current) => [
      ...current,
      { dataType: defaultDataType(dialect), id, name: "", nullable: true, primaryKey: false },
    ]);
    setError(undefined);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const draft: CreateTableDraft = {
      columns: columns.map(({ dataType, name: columnName, nullable, primaryKey }) => ({
        dataType: dataType.trim(),
        name: columnName.trim(),
        nullable,
        primaryKey,
      })),
      name: name.trim(),
      schema,
    };
    const validationError = validateCreateTableDraft(draft, existingRelations);
    if (validationError) {
      setError(validationError);
      return;
    }
    onSubmit(draft);
  };

  return (
    <Dialog onOpenChange={(open) => !busy && onOpenChange(open)} open>
      <DialogContent className="table-editor-dialog table-editor-create-dialog max-h-[calc(100dvh-2rem)] overflow-hidden sm:max-w-3xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Create a table</DialogTitle>
          <DialogDescription>
            Define a catalog-bound table. The active database policy reviews the exact generated schema change before it runs.
          </DialogDescription>
        </DialogHeader>

        <form className="table-editor-create-form" onSubmit={submit}>
          <div className="table-editor-create-relation-fields">
            <label>
              <span>Schema</span>
              <Select disabled={busy || schemas.length === 0} onValueChange={setSchema} value={schema}>
                <SelectTrigger aria-label="Table schema" className="table-editor-create-select">
                  <SelectValue placeholder="Select schema" />
                </SelectTrigger>
                <SelectContent className="table-editor-create-select-content" position="popper">
                  {schemas.map((schemaName) => <SelectItem key={schemaName} value={schemaName}>{schemaName}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label>
              <span>Table name</span>
              <Input
                aria-label="Table name"
                autoFocus
                className="table-editor-create-input"
                disabled={busy}
                maxLength={128}
                onChange={(event) => { setName(event.currentTarget.value); setError(undefined); }}
                placeholder="customers"
                value={name}
              />
            </label>
          </div>

          <section aria-label="Table columns" className="table-editor-create-columns">
            <header>
              <div>
                <strong>Columns</strong>
                <span>{columns.length} of {MAX_CREATE_TABLE_COLUMNS}</span>
              </div>
              <Button disabled={busy || columns.length >= MAX_CREATE_TABLE_COLUMNS} onClick={addColumn} size="sm" type="button" variant="outline">
                <PlusIcon aria-hidden="true" size={14} />
                Add column
              </Button>
            </header>

            <div className="table-editor-create-column-heading" aria-hidden="true">
              <span>Name</span>
              <span>Data type</span>
              <span>Nullable</span>
              <span>Primary</span>
              <span />
            </div>
            <div className="table-editor-create-column-list">
              {columns.map((column, index) => (
                <div className="table-editor-create-column" key={column.id}>
                  <Input
                    aria-label={`Column ${index + 1} name`}
                    className="table-editor-create-input"
                    disabled={busy}
                    maxLength={128}
                    onChange={(event) => updateColumn(column.id, { name: event.currentTarget.value })}
                    placeholder={index === 0 ? "id" : "column_name"}
                    value={column.name}
                  />
                  <Select disabled={busy} onValueChange={(dataType) => updateColumn(column.id, { dataType })} value={column.dataType}>
                    <SelectTrigger aria-label={`Column ${index + 1} data type`} className="table-editor-create-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="table-editor-create-select-content" position="popper">
                      {dataTypes.map((dataType) => <SelectItem key={dataType} value={dataType}>{dataType}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <label className="table-editor-create-check">
                    <Checkbox
                      aria-label={`Column ${index + 1} nullable`}
                      checked={column.nullable}
                      disabled={busy || column.primaryKey}
                      onCheckedChange={(checked) => updateColumn(column.id, { nullable: checked === true })}
                    />
                    <span>Nullable</span>
                  </label>
                  <label className="table-editor-create-check">
                    <Checkbox
                      aria-label={`Column ${index + 1} is in the primary key`}
                      checked={column.primaryKey}
                      disabled={busy}
                      onCheckedChange={(checked) => updateColumn(column.id, { primaryKey: checked === true })}
                    />
                    <KeyRoundIcon aria-hidden="true" size={13} />
                    <span>Primary key</span>
                  </label>
                  <Button
                    aria-label={`Remove column ${index + 1}`}
                    className="table-editor-create-remove"
                    disabled={busy || columns.length === 1}
                    onClick={() => setColumns((current) => current.filter(({ id }) => id !== column.id))}
                    size="icon-sm"
                    title="Remove column"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon aria-hidden="true" size={14} />
                  </Button>
                </div>
              ))}
            </div>
          </section>

          {error ? <p className="table-editor-create-error" role="alert">{error}</p> : null}

          <DialogFooter>
            <Button disabled={busy} onClick={() => onOpenChange(false)} type="button" variant="outline">Cancel</Button>
            <Button disabled={busy || schemas.length === 0} type="submit">
              {busy ? <LoaderCircleIcon aria-hidden="true" className="spin" size={14} /> : <PlusIcon aria-hidden="true" size={14} />}
              {busy ? "Submitting" : "Create table"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function validateCreateTableDraft(
  draft: CreateTableDraft,
  existingRelations: readonly Readonly<{ name: string; schema: string }>[],
): string | undefined {
  if (!draft.schema) return "Choose a schema.";
  if (!IDENTIFIER_PATTERN.test(draft.name)) {
    return "Table names must start with a letter or underscore and contain only letters, numbers, underscores, or dollar signs.";
  }
  if (existingRelations.some((relation) => (
    relation.schema === draft.schema && relation.name.toLocaleLowerCase("en-US") === draft.name.toLocaleLowerCase("en-US")
  ))) return `A table named ${draft.schema}.${draft.name} already exists.`;
  if (draft.columns.length === 0) return "Add at least one column.";

  const normalizedNames = new Set<string>();
  for (const [index, column] of draft.columns.entries()) {
    if (!IDENTIFIER_PATTERN.test(column.name)) {
      return `Column ${index + 1} needs a valid database identifier.`;
    }
    const normalized = column.name.toLocaleLowerCase("en-US");
    if (normalizedNames.has(normalized)) return `Column ${column.name} is duplicated.`;
    normalizedNames.add(normalized);
    if (!column.dataType) return `Choose a data type for ${column.name}.`;
  }
  return undefined;
}

function defaultDataType(dialect: CreateTableDialect): string {
  return dialect === "mysql" ? "bigint" : "uuid";
}

function dataTypesForDialect(dialect: CreateTableDialect): readonly string[] {
  if (dialect === "mysql") {
    return ["bigint", "int", "varchar(255)", "text", "decimal(12,2)", "boolean", "datetime", "timestamp", "json"];
  }
  return ["uuid", "bigint", "integer", "varchar(255)", "text", "numeric(12,2)", "boolean", "timestamp", "timestamptz", "date", "jsonb"];
}
