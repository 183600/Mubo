import { isMuboError, MuboError } from "../core/errors.ts";
import type { MuboDatabase } from "./database.ts";
import type { ColumnDefinition, IndexDefinition, MuboSchema, TableDefinition } from "./schema.ts";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface MigrationOptions {
  /** One of "apply", "check", or "off". Controls whether migrations run automatically. */
  mode?: "apply" | "check" | "off";
  /** When true, only append-only migrations are allowed (no column drops, type changes, etc.). */
  safeOnly?: boolean;
  /** Name of the migration history table. */
  table?: string;
  /** Lock strategy for concurrent migration safety. "file" uses a lock file, "sqlite" uses a SQLite lock. */
  lock?: "file" | "sqlite";
}

export interface MigrationPlan {
  /** Identifier (checksum) of the migration plan. */
  id: string | null;
  /** SQL statements that need to be executed. */
  statements: string[];
  /** Human-readable descriptions of the changes. */
  changes: string[];
}

/** Result of a migration operation. */
export interface MigrationResult {
  /** Status: "applied", "pending", "none", or "off". */
  status: "applied" | "pending" | "none" | "off";
  /** Identifier of the migration that was applied, or null. */
  id: string | null;
  /** SQL statements that were executed. */
  statements: string[];
  /** Human-readable descriptions of the changes. */
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
  descending: boolean;
  customCollation: boolean;
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

function findCaseInsensitive<T>(map: Map<string, T>, name: string): T | undefined {
  const exact = map.get(name);
  if (exact !== undefined) return exact;
  const key = name.toLowerCase();
  for (const [candidate, value] of map) {
    if (candidate.toLowerCase() === key) return value;
  }
  return undefined;
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
  const columnKeys = new Set<string>();
  for (const [columnName] of entries) {
    const key = columnName.toLowerCase();
    if (columnKeys.has(key)) {
      throw new MuboError("MIGRATION_ERROR", `Table ${name} defines column ${columnName} more than once`);
    }
    columnKeys.add(key);
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
    throw new MuboError(
      "MIGRATION_ERROR",
      `Table ${name} has multiple primary keys; declare a single primary key column or use a manual migration`,
    );
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
  const columnNames = new Set(entries.map(([columnName]) => columnName.toLowerCase()));
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
  if (
    index.where !== undefined &&
    (typeof index.where !== "string" || index.where.trim().length === 0)
  ) {
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
    if (!columnNames.has(column.toLowerCase())) {
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

function appendIndexPlan(
  statements: string[],
  changes: string[],
  db: MuboDatabase,
  table: string,
  index: IndexDefinition,
): void {
  ensureIndexNameAvailable(db, table, index.name);
  statements.push(createIndexSql(table, index));
  changes.push(`create index ${index.name} on ${table}`);
}

function tableExists(db: MuboDatabase, table: string): boolean {
  return (
    db
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name COLLATE NOCASE = ?",
      )
      .get(table) !== null
  );
}

function indexOwner(db: MuboDatabase, index: string): string | undefined {
  return db
    .query<{ tbl_name: string }>(
      "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name COLLATE NOCASE = ?",
    )
    .get(index)?.tbl_name;
}

function skipSqlIgnored(sql: string, index: number): number | undefined {
  const char = sql[index];
  if (char === "'" || char === '"' || char === "`") {
    for (let cursor = index + 1; cursor < sql.length; cursor++) {
      if (sql[cursor] !== char) continue;
      if (sql[cursor + 1] === char) {
        cursor++;
        continue;
      }
      return cursor;
    }
    return sql.length - 1;
  }
  if (char === "[") {
    const close = sql.indexOf("]", index + 1);
    return close === -1 ? sql.length - 1 : close;
  }
  if (char === "-" && sql[index + 1] === "-") {
    const newline = sql.indexOf("\n", index + 2);
    return newline === -1 ? sql.length - 1 : newline;
  }
  if (char === "/" && sql[index + 1] === "*") {
    const close = sql.indexOf("*/", index + 2);
    return close === -1 ? sql.length - 1 : close + 1;
  }
  return undefined;
}

function hasKeyword(sql: string | null | undefined, keyword: string): boolean {
  if (!sql) return false;
  const target = keyword.toUpperCase();
  for (let index = 0; index < sql.length; index++) {
    const skip = skipSqlIgnored(sql, index);
    if (skip !== undefined) {
      index = skip;
      continue;
    }
    if (sql.slice(index, index + target.length).toUpperCase() !== target) continue;
    const before = sql[index - 1];
    const after = sql[index + target.length];
    if (before && /[A-Za-z0-9_$]/.test(before)) continue;
    if (after && /[A-Za-z0-9_$]/.test(after)) continue;
    return true;
  }
  return false;
}

function viewExists(db: MuboDatabase, view: string): boolean {
  return (
    db
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'view' AND name COLLATE NOCASE = ?",
      )
      .get(view) !== null
  );
}

function ensureMigrationTableAvailable(db: MuboDatabase, table: string): void {
  const owner = indexOwner(db, table);
  if (owner !== undefined) {
    throw new MuboError(
      "MIGRATION_ERROR",
      `Migration table ${table} conflicts with an existing index on table ${owner}; use a different table name`,
    );
  }
  if (viewExists(db, table)) {
    throw new MuboError(
      "MIGRATION_ERROR",
      `Migration table ${table} conflicts with an existing view; use a different table name`,
    );
  }
}

const requiredMigrationColumns = ["id", "applied_at", "checksum", "meta"] as const;

function assertMigrationTableSchema(db: MuboDatabase, table: string): void {
  const columns = new Set(
    Array.from(introspectTable(db, table).columns.keys(), (name) => name.toLowerCase()),
  );
  const missing = requiredMigrationColumns.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new MuboError(
      "MIGRATION_ERROR",
      `Migration table ${table} is missing required column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}; use a different table name or repair it manually`,
    );
  }
}

function ensureIndexNameAvailable(db: MuboDatabase, table: string, index: string): void {
  const owner = indexOwner(db, index);
  if (owner !== undefined && owner.toLowerCase() !== table.toLowerCase()) {
    throw new MuboError(
      "MIGRATION_ERROR",
      `Index ${index} already exists on table ${owner}; use a different name or a manual migration`,
    );
  }
  if (owner === undefined && tableExists(db, index)) {
    throw new MuboError(
      "MIGRATION_ERROR",
      `Index ${index} conflicts with an existing table; use a different name or a manual migration`,
    );
  }
  if (owner === undefined && viewExists(db, index)) {
    throw new MuboError(
      "MIGRATION_ERROR",
      `Index ${index} conflicts with an existing view; use a different name or a manual migration`,
    );
  }
}

function indexWhere(sql: string | null | undefined): string | undefined {
  if (!sql) return undefined;
  let depth = 0;
  for (let index = 0; index < sql.length; index++) {
    const skip = skipSqlIgnored(sql, index);
    if (skip !== undefined) {
      index = skip;
      continue;
    }
    const char = sql[index];
    if (char === "(") {
      depth++;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || (char !== "W" && char !== "w")) continue;
    if (sql.slice(index, index + 5).toUpperCase() !== "WHERE") continue;
    const before = sql[index - 1];
    const after = sql[index + 5];
    if (before && /[A-Za-z0-9_$]/.test(before)) continue;
    if (after && /[A-Za-z0-9_$]/.test(after)) continue;
    const where = sql.slice(index + 5).trim();
    return where || undefined;
  }
  return undefined;
}

function stripOuterParentheses(value: string): string {
  let text = value.trim();
  while (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0;
    let wrapped = true;
    for (let index = 0; index < text.length; index++) {
      const skip = skipSqlIgnored(text, index);
      if (skip !== undefined) {
        index = skip;
        continue;
      }
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
    if (!wrapped || depth !== 0) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

function normalizeWhere(value: string | undefined): string {
  if (!value) return "";
  let result = "";
  let pendingSpace = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    const skip = skipSqlIgnored(value, index);
    if (skip !== undefined) {
      const comment =
        (char === "-" && value[index + 1] === "-") || (char === "/" && value[index + 1] === "*");
      if (comment) {
        pendingSpace = true;
      } else {
        if (pendingSpace && result.length > 0) result += " ";
        pendingSpace = false;
        result += value.slice(index, skip + 1);
      }
      index = skip;
      continue;
    }
    if (/\s/.test(char)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && result.length > 0) result += " ";
    pendingSpace = false;
    result += /[a-z]/.test(char) ? char.toUpperCase() : char;
  }
  return stripOuterParentheses(result);
}

function normalizeDefault(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = stripOuterParentheses(value);
  if (!text || text.toUpperCase() === "NULL") return null;
  if (/^[+-]?\d+$/.test(text)) {
    const negative = text.startsWith("-");
    const digits = text.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
    return negative && digits !== "0" ? `-${digits}` : digits;
  }
  if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric) && (!Number.isInteger(numeric) || Number.isSafeInteger(numeric))) {
      return String(numeric);
    }
  }
  if (/^(?:CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(text)) {
    return text.toUpperCase();
  }
  if (/^TRUE$/i.test(text)) return "1";
  if (/^FALSE$/i.test(text)) return "0";
  return text;
}

function isConstantAddColumnDefault(value: string): boolean {
  const text = stripOuterParentheses(value);
  if (
    /^(?:NULL|TRUE|FALSE)$/i.test(text)
  )
    return true;
  if (
    /^[+-]?(?:0x[0-9a-f]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?|\.[\d_]+(?:[eE][+-]?\d[\d_]*)?)$/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/^'(?:[^']|'')*'$/s.test(text)) return true;
  return /^[xX]'(?:[0-9a-fA-F]{2})*'$/.test(text);
}

function tableHasRows(db: MuboDatabase, table: string): boolean {
  return db.query<{ present: number }>(`SELECT 1 AS present FROM ${quoteIdentifier(table)} LIMIT 1`).get() !== null;
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
      .query<{ name: string | null }>("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
      .all(row.name)
      .map((item) => item.name ?? "");
    if (row.origin === "u" && row.unique === 1 && row.partial === 0 && indexColumns.length === 1) {
      const column = findCaseInsensitive(columns, indexColumns[0]!);
      if (column) column.unique = true;
    }
    if (row.origin === "pk" || row.name.startsWith("sqlite_autoindex")) continue;
    const definition = db
      .query<{ sql: string | null }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(row.name);
    const keyColumns = db
      .query<{ desc: number; key: number; coll: string }>(
        "SELECT desc, key, coll FROM pragma_index_xinfo(?) ORDER BY seqno",
      )
      .all(row.name)
      .filter((column) => column.key === 1);
    const descending = keyColumns.some((column) => column.desc === 1);
    const customCollation = keyColumns.some((column) => column.coll !== "BINARY");
    indexes.set(row.name, {
      name: row.name,
      unique: row.unique === 1,
      columns: indexColumns,
      descending,
      customCollation,
      partial: row.partial === 1,
      where: row.partial === 1 ? indexWhere(definition?.sql) : undefined,
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
    .query<{ sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name COLLATE NOCASE = ?",
    )
    .get(table);
  const autoIncrement = hasKeyword(definition?.sql, "AUTOINCREMENT");
  return { columns, indexes, foreignKeys, autoIncrement };
}

export function validateSchema(schema: MuboSchema): void {
  if (!isObject(schema) || !isObject(schema.tables)) {
    throw new MuboError("MIGRATION_ERROR", "Invalid schema definition");
  }
  const indexOwners = new Map<string, { table: string; index: string }>();
  const tableNames = new Map<string, string>();
  for (const [tableName, table] of Object.entries(schema.tables)) {
    const tableKey = tableName.toLowerCase();
    if (tableNames.has(tableKey)) {
      throw new MuboError("MIGRATION_ERROR", `Table ${tableName} is defined more than once`);
    }
    tableNames.set(tableKey, tableName);
    validateTable(tableName, table);
    for (const index of table.indexes ?? []) {
      const key = index.name.toLowerCase();
      const owner = indexOwners.get(key);
      if (owner !== undefined) {
        const detail =
          owner.table.toLowerCase() === tableKey
            ? `Index name ${index.name} is defined more than once on table ${tableName}`
            : `Index name ${index.name} is used by both ${owner.table} and ${tableName}`;
        throw new MuboError("MIGRATION_ERROR", detail);
      }
      indexOwners.set(key, { table: tableName, index: index.name });
    }
  }
  for (const [key, owner] of indexOwners) {
    const table = tableNames.get(key);
    if (table !== undefined) {
      throw new MuboError(
        "MIGRATION_ERROR",
        `Index name ${owner.index} conflicts with table ${table}; use a different name`,
      );
    }
  }
}

/** Plans the changes of a single column of an existing table. */
function planColumn(
  db: MuboDatabase,
  tableName: string,
  columnName: string,
  column: ColumnDefinition,
  existing: ExistingTable,
  safeOnly: boolean,
  statements: string[],
  changes: string[],
): void {
  const current = findCaseInsensitive(existing.columns, columnName);
  if (!current) {
    if (column.primaryKey || column.autoIncrement || column.unique) {
      throw new MuboError(
        "MIGRATION_ERROR",
        `Cannot automatically add primary-key, auto-increment or UNIQUE column ${tableName}.${columnName}; use a manual migration`,
      );
    }
    const defaultExpression = column.sqlDefault === undefined ? defaultSql(column) : column.sqlDefault;
    const fallback = normalizeDefault(defaultExpression);
    if (column.notNull && fallback === null && safeOnly) {
      throw new MuboError(
        "MIGRATION_ERROR",
        `Cannot automatically add NOT NULL column ${tableName}.${columnName} without a default value`,
      );
    }
    if (
      safeOnly &&
      defaultExpression !== null &&
      !isConstantAddColumnDefault(defaultExpression) &&
      tableHasRows(db, tableName)
    ) {
      throw new MuboError(
        "MIGRATION_ERROR",
        `Cannot automatically add column ${tableName}.${columnName} with a non-constant default to a non-empty table; use a manual migration`,
      );
    }
    statements.push(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${columnSql(columnName, column, false)}`);
    changes.push(`add column ${tableName}.${columnName}`);
    return;
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
  const currentReferences = findCaseInsensitive(existing.foreignKeys, columnName) ?? [];
  if (references) {
    const expectedColumn = references.column ?? "id";
    const expectedDelete = references.onDelete ?? "NO ACTION";
    const expectedUpdate = references.onUpdate ?? "NO ACTION";
    const sameReference = currentReferences.some(
      (reference) =>
        reference.table.toLowerCase() === references.table.toLowerCase() &&
        reference.column.toLowerCase() === expectedColumn.toLowerCase() &&
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

/** Plans the changes of a single index of an existing table. */
function planIndex(
  db: MuboDatabase,
  tableName: string,
  index: IndexDefinition,
  existing: ExistingTable,
  statements: string[],
  changes: string[],
): void {
  const current = findCaseInsensitive(existing.indexes, index.name);
  if (!current) {
    appendIndexPlan(statements, changes, db, tableName, index);
    return;
  }
  const sameColumns =
    current.columns.length === index.columns.length &&
    current.columns.every(
      (column, position) => column.toLowerCase() === index.columns[position]!.toLowerCase(),
    );
  const sameWhere = normalizeWhere(current.where) === normalizeWhere(index.where);
  if (
    !sameColumns ||
    current.descending ||
    current.customCollation ||
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

/** Plans the changes of a single table of the schema. */
function planTable(
  db: MuboDatabase,
  tableName: string,
  table: TableDefinition,
  safeOnly: boolean,
  statements: string[],
  changes: string[],
): void {
  if (!tableExists(db, tableName)) {
    const existingIndex = indexOwner(db, tableName);
    if (existingIndex !== undefined) {
      throw new MuboError(
        "MIGRATION_ERROR",
        `Table ${tableName} conflicts with an existing index on table ${existingIndex}; use a different name or a manual migration`,
      );
    }
    if (viewExists(db, tableName)) {
      throw new MuboError(
        "MIGRATION_ERROR",
        `Table ${tableName} conflicts with an existing view; use a different name or a manual migration`,
      );
    }
    statements.push(createTableSql(tableName, table));
    changes.push(`create table ${tableName}`);
    for (const index of table.indexes ?? []) {
      appendIndexPlan(statements, changes, db, tableName, index);
    }
    return;
  }

  const existing = introspectTable(db, tableName);
  const declaredColumns = new Set(
    Object.keys(table.columns).map((columnName) => columnName.toLowerCase()),
  );
  for (const existingColumn of existing.columns.keys()) {
    if (!declaredColumns.has(existingColumn.toLowerCase())) {
      throw new MuboError(
        "MIGRATION_ERROR",
        `Dropping column ${tableName}.${existingColumn} requires a manual migration`,
      );
    }
  }
  for (const [columnName, column] of Object.entries(table.columns)) {
    planColumn(db, tableName, columnName, column, existing, safeOnly, statements, changes);
  }
  for (const index of table.indexes ?? []) {
    planIndex(db, tableName, index, existing, statements, changes);
  }
}

function planForSchema(
  db: MuboDatabase,
  schema: MuboSchema,
  safeOnly: boolean,
): { statements: string[]; changes: string[] } {
  const statements: string[] = [];
  const changes: string[] = [];
  validateSchema(schema);
  for (const [tableName, table] of Object.entries(schema.tables)) {
    planTable(db, tableName, table, safeOnly, statements, changes);
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

interface NormalizedMigrationOptions {
  mode: "apply" | "check" | "off";
  safeOnly: boolean;
  table: string;
  lock: "file" | "sqlite";
}

function normalizeMigrationOptions(options: MigrationOptions): NormalizedMigrationOptions {
  const mode = options.mode ?? "apply";
  if (mode !== "apply" && mode !== "check" && mode !== "off") {
    throw new MuboError("MIGRATION_ERROR", `Invalid migration mode: ${String(mode)}`);
  }
  const table = options.table ?? "_mubo_migrations";
  quoteIdentifier(table);
  const safeOnly = options.safeOnly ?? true;
  if (typeof safeOnly !== "boolean") {
    throw new MuboError("MIGRATION_ERROR", "Invalid safeOnly migration setting");
  }
  const lock = options.lock ?? "sqlite";
  if (lock !== "file" && lock !== "sqlite") {
    throw new MuboError("MIGRATION_ERROR", `Invalid migration lock: ${String(lock)}`);
  }
  return { mode, table, safeOnly, lock };
}

const LOCK_RETRY_ATTEMPTS = 50;
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_STALE_AFTER_MS = 10 * 60 * 1000;

export interface FileLockOptions {
  attempts?: number;
  delayMs?: number;
  staleAfterMs?: number;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockInfo {
  pid?: number;
  createdAt?: number;
}

function readLockInfo(lockPath: string): LockInfo {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const stat = statSync(lockPath);
    const [pidText, timestampText] = raw.split("\n");
    const pid = Number.parseInt(pidText ?? "", 10);
    const timestamp = Number.parseInt(timestampText ?? "", 10);
    if (Number.isInteger(pid) && pid > 0) {
      return { pid, createdAt: Number.isFinite(timestamp) ? timestamp : stat.mtimeMs };
    }
    return { createdAt: stat.mtimeMs };
  } catch {
    return {};
  }
}

function isStaleLock(lockPath: string, staleAfterMs: number): boolean {
  const info = readLockInfo(lockPath);
  if (info.createdAt !== undefined && Date.now() - info.createdAt > staleAfterMs) return true;
  if (info.pid !== undefined && !processAlive(info.pid)) return true;
  return false;
}

export async function acquireFileLock(
  dbPath: string,
  table: string,
  options: FileLockOptions = {},
): Promise<string> {
  const attempts = options.attempts ?? LOCK_RETRY_ATTEMPTS;
  const delayMs = options.delayMs ?? LOCK_RETRY_DELAY_MS;
  const staleAfterMs = options.staleAfterMs ?? LOCK_STALE_AFTER_MS;
  const lockDir = dirname(dbPath === ":memory:" ? resolve(".mubo-locks") : dbPath);
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, `.${table}.lock`);
  let acquired = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
      acquired = true;
      break;
    } catch {
      if (isStaleLock(lockPath, staleAfterMs)) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
        }
        continue;
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (!acquired) {
    throw new MuboError("MIGRATION_ERROR", `Could not acquire file lock for migrations: ${lockPath}`);
  }
  return lockPath;
}

export function releaseFileLock(lockPath: string): void {
  try {
    const info = readLockInfo(lockPath);
    if (info.pid !== undefined && info.pid !== process.pid) return;
    rmSync(lockPath, { force: true });
  } catch {
    // Lock file may have been cleaned up externally.
  }
}

/**
 * Plans migrations by comparing the declared schema against the current database state.
 *
 * Returns the SQL statements and change descriptions needed to bring the
 * database up to date.
 */
export function planMigrations(
  db: MuboDatabase,
  schema: MuboSchema,
  options: MigrationOptions = {},
): MigrationPlan {
  const { safeOnly } = normalizeMigrationOptions(options);
  const { statements, changes } = planForSchema(db, schema, safeOnly);
  if (statements.length === 0) return { id: null, statements: [], changes: [] };
  return { id: migrationId(statements), statements, changes };
}

/** Executes the statements of a migration plan inside the migration transaction. */
function executeStatements(db: MuboDatabase, statements: string[]): void {
  for (const statement of statements) {
    try {
      db.exec(statement);
    } catch (error) {
      if (isMuboError(error) && error.code !== "DB_ERROR") throw error;
      const summary = statement.replace(/\s+/g, " ").slice(0, 200);
      // The SQLite reason is part of the message so the failure is actionable
      // without digging into the error cause.
      const reason = (error instanceof Error ? error.message : String(error))
        .replace(/\s+/g, " ")
        .slice(0, 200);
      throw new MuboError(
        "MIGRATION_ERROR",
        `Failed to apply migration statement: ${summary}${reason ? ` (${reason})` : ""}`,
        {
          cause: error,
          details: { statement },
        },
      );
    }
  }
}

/** Writes an applied migration into the migration history table. */
function recordMigration(
  db: MuboDatabase,
  table: string,
  migration: { id: string; statements: string[]; changes: string[] },
): void {
  const appliedAt = Date.now();
  const meta = JSON.stringify({ statements: migration.statements, changes: migration.changes });
  try {
    const alreadyApplied = db
      .query<{ id: string }>(`SELECT id FROM ${quoteIdentifier(table)} WHERE id = ?`)
      .get(migration.id);
    if (alreadyApplied) {
      db.query(
        `UPDATE ${quoteIdentifier(table)} SET applied_at = ?, checksum = ?, meta = ? WHERE id = ?`,
      ).run(appliedAt, migration.id, meta, migration.id);
    } else {
      db.query(
        `INSERT INTO ${quoteIdentifier(table)} (id, applied_at, checksum, meta) VALUES (?, ?, ?, ?)`,
      ).run(migration.id, appliedAt, migration.id, meta);
    }
  } catch (error) {
    if (isMuboError(error) && error.code !== "DB_ERROR") throw error;
    throw new MuboError(
      "MIGRATION_ERROR",
      `Failed to record migration history for ${migration.id}`,
      { cause: error, details: { migration: migration.id } },
    );
  }
}

/**
 * Applies planned migrations to the database.
 *
 * Mode "apply" runs pending migrations, "check" only checks for pending ones,
 * "off" does nothing. When safeOnly is enabled, destructive changes are
 * rejected.
 */
export async function applyMigrations(
  db: MuboDatabase,
  schema: MuboSchema,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const { mode, table, safeOnly, lock } = normalizeMigrationOptions(options);
  if (mode === "off") {
    return { status: "off", id: null, statements: [], changes: [] };
  }

  validateSchema(schema);
  if (mode === "apply") {
    if (db.transactionBusy) {
      throw new MuboError(
        "MIGRATION_ERROR",
        "Cannot apply migrations while another transaction is active",
      );
    }
    ensureMigrationTableAvailable(db, table);
    db.exec(migrationTableSql(table));
    assertMigrationTableSchema(db, table);
  } else if (mode === "check" && tableExists(db, table)) {
    assertMigrationTableSchema(db, table);
  }
  const initial = planMigrations(db, schema, { table, safeOnly });
  if (initial.statements.length === 0) {
    return { status: "none", id: null, statements: [], changes: [] };
  }
  if (mode === "check") {
    return { status: "pending", id: initial.id, statements: initial.statements, changes: initial.changes };
  }

  let lockPath: string | undefined;
  let applied: MigrationPlan | null = null;
  try {
    if (lock === "file") {
      lockPath = await acquireFileLock(db.path, table);
    }
    await db.transaction(
      () => {
        const fresh = planMigrations(db, schema, { table, safeOnly });
        if (fresh.statements.length === 0 || fresh.id === null) return;
        executeStatements(db, fresh.statements);
        recordMigration(db, table, {
          id: fresh.id,
          statements: fresh.statements,
          changes: fresh.changes,
        });
        applied = fresh;
      },
      { immediate: true },
    );
  } finally {
    if (lockPath !== undefined) releaseFileLock(lockPath);
  }

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
