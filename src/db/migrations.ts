import { isMuboError, MuboError } from "../core/errors.ts";
import type { MuboDatabase } from "./database.ts";
import type { ColumnDefinition, IndexDefinition, MuboSchema, TableDefinition } from "./schema.ts";

export interface MigrationOptions {
  mode?: "apply" | "check" | "off";
  safeOnly?: boolean;
  table?: string;
}

export interface MigrationPlan {
  id: string | null;
  statements: string[];
  changes: string[];
}

export interface MigrationResult {
  status: "applied" | "pending" | "none" | "off";
  id: string | null;
  statements: string[];
  changes: string[];
}

interface ExistingColumn {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  unique: boolean;
}

interface ExistingIndex {
  name: string;
  unique: boolean;
  columns: string[];
  partial: boolean;
  where?: string;
}

interface ExistingForeignKey {
  table: string;
  column: string;
  onDelete: string;
  onUpdate: string;
}

interface ExistingTable {
  columns: Map<string, ExistingColumn>;
  indexes: Map<string, ExistingIndex>;
  foreignKeys: Map<string, ExistingForeignKey[]>;
  autoIncrement: boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new MuboError("MIGRATION_ERROR", `Invalid SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function normalizeType(type: string): string {
  return type.trim().toUpperCase();
}

function defaultSql(column: ColumnDefinition): string | null {
  if (column.sqlDefault !== undefined) return column.sqlDefault;
  if (column.default === undefined) return null;
  if (column.default === null) return "NULL";
  if (typeof column.default === "boolean") return column.default ? "1" : "0";
  if (typeof column.default === "number") {
    if (!Number.isFinite(column.default)) {
      throw new MuboError("MIGRATION_ERROR", `Invalid numeric default: ${column.default}`);
    }
    return String(column.default);
  }
  return `'${column.default.replace(/'/g, "''")}'`;
}

function columnSql(name: string, column: ColumnDefinition, includePrimaryKey: boolean): string {
  const parts = [quoteIdentifier(name), normalizeType(column.type)];
  if (includePrimaryKey && column.primaryKey) {
    parts.push("PRIMARY KEY");
    if (column.autoIncrement) {
      if (normalizeType(column.type) !== "INTEGER") {
        throw new MuboError("MIGRATION_ERROR", `AUTOINCREMENT requires an INTEGER primary key: ${name}`);
      }
      parts.push("AUTOINCREMENT");
    }
  }
  if (column.notNull) parts.push("NOT NULL");
  if (column.unique && !column.primaryKey) parts.push("UNIQUE");
  const fallback = defaultSql(column);
  if (fallback !== null) parts.push(`DEFAULT ${fallback}`);
  if (column.references) {
    parts.push(
      `REFERENCES ${quoteIdentifier(column.references.table)}(${quoteIdentifier(
        column.references.column ?? "id",
      )})`,
    );
    if (column.references.onDelete) parts.push(`ON DELETE ${column.references.onDelete}`);
    if (column.references.onUpdate) parts.push(`ON UPDATE ${column.references.onUpdate}`);
  }
  return parts.join(" ");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTable(name: string, table: TableDefinition): void {
  quoteIdentifier(name);
  if (!isObject(table)) {
    throw new MuboError("MIGRATION_ERROR", `Invalid table definition: ${name}`);
  }
  if (!isObject(table.columns)) {
    throw new MuboError("MIGRATION_ERROR", `Table ${name} must define a columns object`);
  }
  const entries = Object.entries(table.columns);
  if (entries.length === 0) {
    throw new MuboError("MIGRATION_ERROR", `Table ${name} must define at least one column`);
  }
  for (const [columnName, column] of entries) {
    if (!isObject(column)) {
      throw new MuboError("MIGRATION_ERROR", `Invalid column definition for ${name}.${columnName}`);
    }
    for (const flag of ["primaryKey", "autoIncrement", "notNull", "unique"] as const) {
      if (column[flag] !== undefined && typeof column[flag] !== "boolean") {
        throw new MuboError("MIGRATION_ERROR", `Invalid ${flag} setting for ${name}.${columnName}`);
      }
    }
  }
  const primaryKeys = entries.filter(([, column]) => column.primaryKey);
  if (primaryKeys.length > 1) {
    throw new MuboError("MIGRATION_ERROR", `Table ${name} has multiple primary keys; use one composite key instead`);
  }
  for (const [columnName, column] of entries) {
    quoteIdentifier(columnName);
    if (typeof column.type !== "string" || !/^[A-Za-z][A-Za-z0-9 _(),]*$/.test(column.type)) {
      throw new MuboError("MIGRATION_ERROR", `Invalid column type for ${name}.${columnName}: ${String(column.type)}`);
    }
    if (
      column.default !== undefined &&
      column.default !== null &&
      typeof column.default !== "string" &&
      typeof column.default !== "number" &&
      typeof column.default !== "boolean"
    ) {
      throw new MuboError("MIGRATION_ERROR", `Invalid default value for ${name}.${columnName}`);
    }
    if (typeof column.default === "number" && !Number.isFinite(column.default)) {
      throw new MuboError("MIGRATION_ERROR", `Invalid numeric default: ${column.default}`);
    }
    if (
      column.sqlDefault !== undefined &&
      (typeof column.sqlDefault !== "string" || column.sqlDefault.trim().length === 0)
    ) {
      throw new MuboError("MIGRATION_ERROR", `Invalid SQL default for ${name}.${columnName}`);
    }
    if (column.autoIncrement && !column.primaryKey) {
      throw new MuboError(
        "MIGRATION_ERROR",
        `AUTOINCREMENT requires a primary key for ${name}.${columnName}`,
      );
    }
    const references = column.references;
    if (references !== undefined && references !== null) {
      if (!isObject(references)) {
        throw new MuboError("MIGRATION_ERROR", `Invalid references for ${name}.${columnName}`);
      }
      if (typeof references.table !== "string" || typeof (references.column ?? "id") !== "string") {
        throw new MuboError("MIGRATION_ERROR", `Invalid references for ${name}.${columnName}`);
      }
      quoteIdentifier(references.table);
      quoteIdentifier(references.column ?? "id");
      const actions = ["CASCADE", "SET NULL", "RESTRICT", "NO ACTION"];
      if (references.onDelete !== undefined && !actions.includes(references.onDelete)) {
        throw new MuboError(
          "MIGRATION_ERROR",
          `Invalid ON DELETE action for ${name}.${columnName}: ${String(references.onDelete)}`,
        );
      }
      if (references.onUpdate !== undefined && !actions.includes(references.onUpdate)) {
        throw new MuboError(
          "MIGRATION_ERROR",
          `Invalid ON UPDATE action for ${name}.${columnName}: ${String(references.onUpdate)}`,
        );
      }
      if (
        column.notNull &&
        (references.onDelete === "SET NULL" || references.onUpdate === "SET NULL")
      ) {
        throw new MuboError(
          "MIGRATION_ERROR",
          `SET NULL action cannot be used with NOT NULL column ${name}.${columnName}`,
        );
      }
    }
  }
  if (table.indexes !== undefined && !Array.isArray(table.indexes)) {
    throw new MuboError("MIGRATION_ERROR", `Indexes for ${name} must be an array`);
  }
  const columnNames = new Set(entries.map(([columnName]) => columnName));
  for (const index of table.indexes ?? []) validateIndex(name, index, columnNames);
}

function validateIndex(table: string, index: IndexDefinition, columnNames: Set<string>): void {
  if (!isObject(index)) {
    throw new MuboError("MIGRATION_ERROR", `Invalid index definition on ${table}`);
  }
  if (typeof index.name !== "string") {
    throw new MuboError("MIGRATION_ERROR", `Invalid SQL identifier: ${String(index.name)}`);
  }
  quoteIdentifier(index.name);
  if (index.unique !== undefined && typeof index.unique !== "boolean") {
    throw new MuboError("MIGRATION_ERROR", `Invalid unique setting for index ${index.name}`);
  }
  if (index.where !== undefined && typeof index.where !== "string") {
    throw new MuboError("MIGRATION_ERROR", `Invalid WHERE clause for index ${index.name}`);
  }
  if (!Array.isArray(index.columns)) {
    throw new MuboError("MIGRATION_ERROR", `Index ${index.name} on ${table} needs a columns array`);
  }
  if (index.columns.length === 0) {
    throw new MuboError("MIGRATION_ERROR", `Index ${index.name} on ${table} needs at least one column`);
  }
  for (const column of index.columns) {
    if (typeof column !== "string") {
      throw new MuboError("MIGRATION_ERROR", `Invalid SQL identifier: ${String(column)}`);
    }
    quoteIdentifier(column);
    if (!columnNames.has(column)) {
      throw new MuboError(
        "MIGRATION_ERROR",
        `Index ${index.name} on ${table} references unknown column ${column}`,
      );
    }
  }
}

function createTableSql(name: string, table: TableDefinition): string {
  const columns = Object.entries(table.columns).map(([columnName, column]) =>
    `  ${columnSql(columnName, column, true)}`,
  );
  return `CREATE TABLE ${quoteIdentifier(name)} (\n${columns.join(",\n")}\n)`;
}

function createIndexSql(table: string, index: IndexDefinition): string {
  const where = index.where ? ` WHERE ${index.where}` : "";
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(index.name)} ON ${quoteIdentifier(
    table,
  )} (${index.columns.map(quoteIdentifier).join(", ")})${where}`;
}

function tableExists(db: MuboDatabase, table: string): boolean {
  return (
    db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    null
  );
}

function indexWhere(sql: string | null | undefined): string | undefined {
  if (!sql) return undefined;
  const match = /\bWHERE\b([\s\S]*)$/i.exec(sql);
  const where = match?.[1]?.trim();
  return where ? where : undefined;
}

function normalizeWhere(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeDefault(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  let text = value.trim();
  if (!text || text.toUpperCase() === "NULL") return null;
  while (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0;
    let wrapped = true;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === "(") depth++;
      else if (char === ")") depth--;
      if (depth === 0 && index > 0 && index < text.length - 1) {
        wrapped = false;
        break;
      }
      if (depth < 0) {
        wrapped = false;
        break;
      }
    }
    if (!wrapped) break;
    text = text.slice(1, -1).trim();
  }
  if (!text || text.toUpperCase() === "NULL") return null;
  return text;
}

function introspectTable(db: MuboDatabase, table: string): ExistingTable {
  const columns = new Map<string, ExistingColumn>();
  for (const row of db.query<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>(`PRAGMA table_info(${quoteIdentifier(table)})`).all()) {
    columns.set(row.name, {
      name: row.name,
      type: row.type,
      notNull: row.notnull === 1,
      defaultValue: row.dflt_value,
      primaryKey: row.pk > 0,
      unique: false,
    });
  }
  const indexes = new Map<string, ExistingIndex>();
  for (const row of db.query<{
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>(`PRAGMA index_list(${quoteIdentifier(table)})`).all()) {
    const indexColumns = db
      .query<{ name: string | null }>(`PRAGMA index_info(${quoteIdentifier(row.name)})`)
      .all()
      .map((item) => item.name ?? "");
    if (row.origin === "u" && row.unique === 1 && indexColumns.length === 1) {
      const column = columns.get(indexColumns[0]!);
      if (column) column.unique = true;
    }
    if (row.origin === "pk" || row.name.startsWith("sqlite_autoindex")) continue;
    const definition = db
      .query<{ sql: string | null }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(row.name);
    indexes.set(row.name, {
      name: row.name,
      unique: row.unique === 1,
      columns: indexColumns,
      partial: row.partial === 1,
      where: indexWhere(definition?.sql),
    });
  }
  const foreignKeys = new Map<string, ExistingForeignKey[]>();
  for (const row of db.query<{
    table: string;
    from: string;
    to: string | null;
    on_update: string;
    on_delete: string;
  }>(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all()) {
    const list = foreignKeys.get(row.from) ?? [];
    list.push({
      table: row.table,
      column: row.to ?? "id",
      onDelete: row.on_delete.toUpperCase(),
      onUpdate: row.on_update.toUpperCase(),
    });
    foreignKeys.set(row.from, list);
  }
  const definition = db
    .query<{ sql: string | null }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  const autoIncrement = /\bAUTOINCREMENT\b/i.test(definition?.sql ?? "");
  return { columns, indexes, foreignKeys, autoIncrement };
}

function validateSchema(schema: MuboSchema): void {
  if (!isObject(schema) || !isObject(schema.tables)) {
    throw new MuboError("MIGRATION_ERROR", "Invalid schema definition");
  }
  const indexOwners = new Map<string, string>();
  for (const [tableName, table] of Object.entries(schema.tables)) {
    validateTable(tableName, table);
    for (const index of table.indexes ?? []) {
      const owner = indexOwners.get(index.name);
      if (owner !== undefined) {
        const detail =
          owner === tableName
            ? `Index name ${index.name} is defined more than once on table ${tableName}`
            : `Index name ${index.name} is used by both ${owner} and ${tableName}`;
        throw new MuboError("MIGRATION_ERROR", detail);
      }
      indexOwners.set(index.name, tableName);
    }
  }
}

function planForSchema(db: MuboDatabase, schema: MuboSchema, safeOnly: boolean): { statements: string[]; changes: string[] } {
  const statements: string[] = [];
  const changes: string[] = [];
  validateSchema(schema);
  for (const [tableName, table] of Object.entries(schema.tables)) {
    if (!tableExists(db, tableName)) {
      statements.push(createTableSql(tableName, table));
      changes.push(`create table ${tableName}`);
      for (const index of table.indexes ?? []) {
        statements.push(createIndexSql(tableName, index));
        changes.push(`create index ${index.name} on ${tableName}`);
      }
      continue;
    }

    const existing = introspectTable(db, tableName);
    for (const [columnName, column] of Object.entries(table.columns)) {
      const current = existing.columns.get(columnName);
      if (!current) {
        if (column.primaryKey || column.autoIncrement || column.unique) {
          throw new MuboError(
            "MIGRATION_ERROR",
            `Cannot automatically add primary-key, auto-increment or UNIQUE column ${tableName}.${columnName}; use a manual migration`,
          );
        }
        const fallback = normalizeDefault(
          column.sqlDefault === undefined ? defaultSql(column) : column.sqlDefault,
        );
        if (column.notNull && fallback === null) {
          throw new MuboError(
            "MIGRATION_ERROR",
            `Cannot automatically add NOT NULL column ${tableName}.${columnName} without a default value`,
          );
        }
        statements.push(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${columnSql(columnName, column, false)}`);
        changes.push(`add column ${tableName}.${columnName}`);
        continue;
      }
      if (normalizeType(current.type) !== normalizeType(String(column.type))) {
        throw new MuboError(
          "MIGRATION_ERROR",
          `Column type change for ${tableName}.${columnName} (${current.type} -> ${column.type}) requires a manual migration`,
        );
      }
      if (current.primaryKey !== Boolean(column.primaryKey)) {
        throw new MuboError(
          "MIGRATION_ERROR",
          `Primary-key change for ${tableName}.${columnName} requires a manual migration`,
        );
      }
      if (column.primaryKey && Boolean(column.autoIncrement) !== existing.autoIncrement) {
        throw new MuboError(
          "MIGRATION_ERROR",
          `Auto-increment change for ${tableName}.${columnName} requires a manual migration`,
        );
      }
      const references = column.references;
      const currentReferences = existing.foreignKeys.get(columnName) ?? [];
      if (references) {
        const expectedColumn = references.column ?? "id";
        const expectedDelete = references.onDelete ?? "NO ACTION";
        const expectedUpdate = references.onUpdate ?? "NO ACTION";
        const sameReference = currentReferences.some(
          (reference) =>
            reference.table === references.table &&
            reference.column === expectedColumn &&
            reference.onDelete === expectedDelete &&
            reference.onUpdate === expectedUpdate,
        );
        if (!sameReference) {
          throw new MuboError(
            "MIGRATION_ERROR",
            `Foreign-key change for ${tableName}.${columnName} requires a manual migration`,
          );
        }
      } else if (currentReferences.length > 0) {
        throw new MuboError(
          "MIGRATION_ERROR",
          `Foreign-key change for ${tableName}.${columnName} requires a manual migration`,
        );
      }
      const expectedDefault = normalizeDefault(
        column.sqlDefault === undefined ? defaultSql(column) : column.sqlDefault,
      );
      if (expectedDefault !== normalizeDefault(current.defaultValue)) {
        throw new MuboError(
          "MIGRATION_ERROR",
          `Default value change for ${tableName}.${columnName} requires a manual migration`,
        );
      }
      if (current.notNull !== Boolean(column.notNull)) {
        const detail = safeOnly
          ? "safeOnly is enabled"
          : "automatic destructive migrations are not supported";
        throw new MuboError(
          "MIGRATION_ERROR",
          `Column nullability change for ${tableName}.${columnName} requires a manual migration (${detail})`,
        );
      }
      const wantsUnique = Boolean(column.unique) && !column.primaryKey;
      if (wantsUnique !== current.unique) {
        throw new MuboError(
          "MIGRATION_ERROR",
          `UNIQUE constraint change for ${tableName}.${columnName} requires a manual migration`,
        );
      }
    }

    for (const index of table.indexes ?? []) {
      const current = existing.indexes.get(index.name);
      if (!current) {
        statements.push(createIndexSql(tableName, index));
        changes.push(`create index ${index.name} on ${tableName}`);
        continue;
      }
      const sameColumns =
        current.columns.length === index.columns.length &&
        current.columns.every((column, position) => column === index.columns[position]);
      const sameWhere = normalizeWhere(current.where) === normalizeWhere(index.where);
      if (
        !sameColumns ||
        current.unique !== Boolean(index.unique) ||
        current.partial !== Boolean(index.where) ||
        !sameWhere
      ) {
        throw new MuboError(
          "MIGRATION_ERROR",
          `Index ${index.name} on ${tableName} already exists with a different definition; use a manual migration`,
        );
      }
    }
  }
  return { statements, changes };
}

function migrationId(statements: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(statements.join("\n---\n"));
  return hasher.digest("hex").slice(0, 24);
}

function migrationTableSql(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(
    table,
  )} (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL, meta TEXT)`;
}

export function planMigrations(
  db: MuboDatabase,
  schema: MuboSchema,
  options: MigrationOptions = {},
): MigrationPlan {
  const table = options.table ?? "_mubo_migrations";
  const safeOnly = options.safeOnly ?? true;
  const { statements, changes } = planForSchema(db, schema, safeOnly);
  if (statements.length === 0) return { id: null, statements: [], changes: [] };
  return { id: migrationId(statements), statements, changes };
}

export function applyMigrations(
  db: MuboDatabase,
  schema: MuboSchema,
  options: MigrationOptions = {},
): MigrationResult {
  const mode = options.mode ?? "apply";
  const table = options.table ?? "_mubo_migrations";
  const safeOnly = options.safeOnly ?? true;
  if (mode === "off") {
    return { status: "off", id: null, statements: [], changes: [] };
  }

  if (mode === "apply") db.exec(migrationTableSql(table));
  const initial = planMigrations(db, schema, { table, safeOnly });
  if (initial.statements.length === 0) {
    return { status: "none", id: null, statements: [], changes: [] };
  }
  if (mode === "check") {
    return { status: "pending", id: initial.id, statements: initial.statements, changes: initial.changes };
  }

  let applied: MigrationPlan | null = null;
  db.transaction(
    () => {
      const fresh = planMigrations(db, schema, { table, safeOnly });
      if (fresh.statements.length === 0 || fresh.id === null) return;
      for (const statement of fresh.statements) {
        try {
          db.exec(statement);
        } catch (error) {
          if (isMuboError(error)) throw error;
          const summary = statement.replace(/\s+/g, " ").slice(0, 200);
          throw new MuboError("MIGRATION_ERROR", `Failed to apply migration statement: ${summary}`, {
            cause: error,
            details: { statement },
          });
        }
      }
      const appliedAt = Date.now();
      const meta = JSON.stringify({ statements: fresh.statements, changes: fresh.changes });
      const alreadyApplied = db
        .query<{ id: string }>(`SELECT id FROM ${quoteIdentifier(table)} WHERE id = ?`)
        .get(fresh.id);
      if (alreadyApplied) {
        db.query(
          `UPDATE ${quoteIdentifier(table)} SET applied_at = ?, checksum = ?, meta = ? WHERE id = ?`,
        ).run(appliedAt, fresh.id, meta, fresh.id);
      } else {
        db.query(
          `INSERT INTO ${quoteIdentifier(table)} (id, applied_at, checksum, meta) VALUES (?, ?, ?, ?)`,
        ).run(fresh.id, appliedAt, fresh.id, meta);
      }
      applied = fresh;
    },
    { immediate: true },
  );

  const result = applied as MigrationPlan | null;
  if (!result) {
    return { status: "none", id: null, statements: [], changes: [] };
  }
  return {
    status: "applied",
    id: result.id,
    statements: result.statements,
    changes: result.changes,
  };
}
