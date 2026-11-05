export type ColumnType = "text" | "integer" | "real" | "blob" | "numeric" | "boolean";

 /** A reference to a foreign key constraint, pointing to another table's column. */
export interface ReferenceDefinition {
  /** The referenced table name. */
  table: string;
  /** The referenced column name (optional). */
  column?: string;
  /** Action on foreign key delete. */
  onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
  /** Action on foreign key update. */
  onUpdate?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
}

/** Definition of a table column with type and constraints. */
export interface ColumnDefinition {
  /** SQL column type (e.g. "text", "integer", "real", "blob", "numeric", "boolean"). */
  type: ColumnType | string;
  /** Whether the column is a primary key. */
  primaryKey?: boolean;
  /** Whether the column auto-increments. */
  autoIncrement?: boolean;
  /** Whether the column cannot be NULL. */
  notNull?: boolean;
  /** Whether the column must be unique. */
  unique?: boolean;
  /** A default value stored as a literal. */
  default?: string | number | boolean | null;
  /** Raw SQL default expression (e.g. "CURRENT_TIMESTAMP"). */
  sqlDefault?: string;
  /** A foreign key reference. */
  references?: ReferenceDefinition;
}

/** Definition of an index on table columns. */
export interface IndexDefinition {
  /** The index name. */
  name: string;
  /** Column names included in the index. */
  columns: string[];
  /** Whether the index enforces uniqueness. */
  unique?: boolean;
  /** Optional partial index condition (SQL WHERE clause). */
  where?: string;
}

/** Definition of a table including its columns and indexes. */
export interface TableDefinition {
  /** Mapping of column names to their definitions. */
  columns: Record<string, ColumnDefinition>;
  /** Optional index definitions for the table. */
  indexes?: IndexDefinition[];
}

/** Definition of the application's database schema. */
export interface MuboSchema {
  /** Mapping of table names to their definitions. */
  tables: Record<string, TableDefinition>;
}

/** Identity function used to register a schema definition. */
export function defineSchema<const T extends MuboSchema>(schema: T): T {
  return schema;
}