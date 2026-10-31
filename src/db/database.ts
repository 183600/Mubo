import { Database as SQLiteDatabase, type SQLQueryBindings } from "bun:sqlite";
import { ensureDataDir } from "../core/config.ts";
import { MuboError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import {
  applyMigrations,
  planMigrations,
  type MigrationOptions,
  type MigrationPlan,
  type MigrationResult,
} from "./migrations.ts";
import type { MuboSchema } from "./schema.ts";

export type QueryArgument = SQLQueryBindings;

export interface MuboDatabaseOptions {
  path: string;
  dataDir?: string;
  wal?: boolean;
  busyTimeoutMs?: number;
  foreignKeys?: boolean;
  slowQueryMs?: number;
  logger?: Logger;
  schema?: MuboSchema;
}

export interface QueryResult<Row> {
  all(...params: unknown[]): Row[];
  get(...params: unknown[]): Row | null;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  values(...params: unknown[]): unknown[][];
  iterate(...params: unknown[]): IterableIterator<Row>;
}

function normalizeParams(params: unknown[]): QueryArgument[] {
  if (params.length === 1 && Array.isArray(params[0])) return params[0] as QueryArgument[];
  return params as QueryArgument[];
}

export class MuboDatabase {
  readonly raw: SQLiteDatabase;
  readonly path: string;
  readonly slowQueryMs: number;
  private readonly logger?: Logger;
  private readonly schema?: MuboSchema;
  private closed = false;
  private transactionDepth = 0;

  constructor(options: MuboDatabaseOptions) {
    this.path = options.path;
    this.slowQueryMs = options.slowQueryMs ?? 200;
    this.logger = options.logger;
    this.schema = options.schema;
    if (options.path !== ":memory:") {
      ensureDataDir(options.path, options.dataDir ?? process.cwd());
    }
    try {
      this.raw = new SQLiteDatabase(options.path, { create: true, readwrite: true, strict: true });
    } catch (error) {
      throw new MuboError("CONFIG_ERROR", `Cannot open SQLite database at ${options.path}`, {
        cause: error,
      });
    }
    this.raw.run(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000))}`);
    if (options.foreignKeys ?? true) this.raw.run("PRAGMA foreign_keys = ON");
    if (options.wal ?? true) {
      try {
        this.raw.run("PRAGMA journal_mode = WAL");
        this.raw.run("PRAGMA synchronous = NORMAL");
      } catch {
        // Some filesystems (or :memory:) do not support WAL; SQLite falls back safely.
      }
    }
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private assertOpen(): void {
    if (this.closed) throw new MuboError("MIGRATION_ERROR", "Database is closed");
  }

  private timed<T>(sql: string, operation: () => T): T {
    this.assertOpen();
    const start = performance.now();
    try {
      return operation();
    } finally {
      const duration = performance.now() - start;
      if (duration >= this.slowQueryMs) {
        this.logger?.warn("Slow SQL query", {
          durationMs: Math.round(duration * 100) / 100,
          sql: sql.replace(/\s+/g, " ").slice(0, 500),
        });
      }
    }
  }

  query<Row = Record<string, unknown>>(sql: string): QueryResult<Row> {
    const statement = () => this.raw.query<Row, QueryArgument[]>(sql);
    return {
      all: (...params) => this.timed(sql, () => statement().all(...normalizeParams(params))),
      get: (...params) => this.timed(sql, () => statement().get(...normalizeParams(params))),
      run: (...params) => this.timed(sql, () => statement().run(...normalizeParams(params))),
      values: (...params) => this.timed(sql, () => statement().values(...normalizeParams(params))),
      iterate: (...params) => statement().iterate(...normalizeParams(params)),
    };
  }

  exec(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.timed(sql, () => (this.raw.run as (...args: unknown[]) => { changes: number; lastInsertRowid: number | bigint })(sql, ...normalizeParams(params)));
  }

  async transaction<T>(
    fn: (db: MuboDatabase) => T | Promise<T>,
    options: { immediate?: boolean } = {},
  ): Promise<T> {
    this.assertOpen();
    const depth = this.transactionDepth;
    const savepoint = `mubo_sp_${depth}`;
    this.transactionDepth++;
    try {
      if (depth === 0) this.raw.run(options.immediate === false ? "BEGIN" : "BEGIN IMMEDIATE");
      else this.raw.run(`SAVEPOINT ${savepoint}`);
      const result = await fn(this);
      if (depth === 0) this.raw.run("COMMIT");
      else this.raw.run(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try {
        if (depth === 0) this.raw.run("ROLLBACK");
        else {
          this.raw.run(`ROLLBACK TO ${savepoint}`);
          this.raw.run(`RELEASE ${savepoint}`);
        }
      } catch {
        // The original error is more useful than a rollback failure.
      }
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  ping(): boolean {
    try {
      this.assertOpen();
      return this.raw.query("SELECT 1 AS ok").get() !== null;
    } catch {
      return false;
    }
  }

  plan(schema: MuboSchema = this.schema ?? { tables: {} }, options: MigrationOptions = {}): MigrationPlan {
    this.assertOpen();
    return planMigrations(this, schema, { table: "_mubo_migrations", safeOnly: true, ...options });
  }

  async migrate(
    schema: MuboSchema = this.schema ?? { tables: {} },
    options: MigrationOptions = {},
  ): Promise<MigrationResult> {
    this.assertOpen();
    return applyMigrations(this, schema, { table: "_mubo_migrations", safeOnly: true, ...options });
  }

  close(force = false): void {
    if (this.closed) return;
    this.closed = true;
    this.raw.close(force);
  }
}
