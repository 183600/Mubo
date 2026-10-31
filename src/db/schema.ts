export type ColumnType = "text" | "integer" | "real" | "blob" | "numeric" | "boolean";

export interface ReferenceDefinition {
  table: string;
  column?: string;
  onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
  onUpdate?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
}

export interface ColumnDefinition {
  type: ColumnType | string;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  notNull?: boolean;
  unique?: boolean;
  default?: string | number | boolean | null;
  /** Raw SQL default expression, for example `CURRENT_TIMESTAMP`. */
  sqlDefault?: string;
  references?: ReferenceDefinition;
}

export interface IndexDefinition {
  name: string;
  columns: string[];
  unique?: boolean;
  where?: string;
}

export interface TableDefinition {
  columns: Record<string, ColumnDefinition>;
  indexes?: IndexDefinition[];
}

export interface MuboSchema {
  tables: Record<string, TableDefinition>;
}

export function defineSchema<const T extends MuboSchema>(schema: T): T {
  return schema;
}
