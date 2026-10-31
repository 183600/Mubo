import { AsyncLocalStorage } from "node:async_hooks";
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

interface TransactionContext {
  depth: number;
  active: boolean;
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
  private readonly transactionContext = new AsyncLocalStorage<TransactionContext>();
  private readonly transactionQueue: Array<() => void> = [];
  private transactionActive = false;

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

  exec(sql: string): void {
    this.timed(sql, () => this.raw.exec(sql));
  }

  transaction<T>(
    fn: (db: MuboDatabase) => T | Promise<T>,
    options: { immediate?: boolean } = {},
  ): T | Promise<T> {
    this.assertOpen();
    const current = this.transactionContext.getStore();
    if (current?.active) {
      return this.executeTransaction(fn, current.depth, options.immediate !== false);
    }
    if (this.transactionActive || this.transactionQueue.length > 0) {
      return this.enqueueTransaction(fn, options.immediate !== false);
    }
    this.transactionActive = true;
    try {
      const result = this.executeTransaction(fn, 0, options.immediate !== false);
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            this.finishTransaction();
            return value;
          },
          (error) => {
            this.finishTransaction();
            throw error;
          },
        );
      }
      this.finishTransaction();
      return result;
    } catch (error) {
      this.finishTransaction();
      throw error;
    }
  }

  private executeTransaction<T>(
    fn: (db: MuboDatabase) => T | Promise<T>,
    parentDepth: number,
    immediate: boolean,
  ): T | Promise<T> {
    const context: TransactionContext = { depth: parentDepth + 1, active: true };
    const savepoint = `mubo_sp_${parentDepth}`;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      context.active = false;
    };
    const commit = () => {
      try {
        if (parentDepth === 0) this.raw.run("COMMIT");
        else this.raw.run(`RELEASE ${savepoint}`);
      } finally {
        finish();
      }
    };
    const rollback = () => {
      try {
        if (parentDepth === 0) this.raw.run("ROLLBACK");
        else {
          this.raw.run(`ROLLBACK TO ${savepoint}`);
          this.raw.run(`RELEASE ${savepoint}`);
        }
      } catch {
        // The original error is more useful than a rollback failure.
      } finally {
        finish();
      }
    };
    try {
      if (parentDepth === 0) this.raw.run(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
      else this.raw.run(`SAVEPOINT ${savepoint}`);
      const result = this.transactionContext.run(context, () => fn(this));
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            try {
              commit();
              return value;
            } catch (error) {
              rollback();
              throw error;
            }
          },
          (error) => {
            rollback();
            throw error;
          },
        );
      }
      commit();
      return result;
    } catch (error) {
      rollback();
      throw error;
    }
  }

  private enqueueTransaction<T>(
    fn: (db: MuboDatabase) => T | Promise<T>,
    immediate: boolean,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.transactionQueue.push(() => {
        let result: T | Promise<T>;
        try {
          this.assertOpen();
          result = this.executeTransaction(fn, 0, immediate);
        } catch (error) {
          reject(error);
          this.finishTransaction();
          return;
        }
        if (result instanceof Promise) {
          result.then(
            (value) => {
              resolve(value);
              this.finishTransaction();
            },
            (error) => {
              reject(error);
              this.finishTransaction();
            },
          );
        } else {
          resolve(result);
          this.finishTransaction();
        }
      });
      this.drainTransactions();
    });
  }

  private drainTransactions(): void {
    if (this.transactionActive) return;
    const next = this.transactionQueue.shift();
    if (!next) return;
    this.transactionActive = true;
    next();
  }

  private finishTransaction(): void {
    this.transactionActive = false;
    this.drainTransactions();
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

  migrate(
    schema: MuboSchema = this.schema ?? { tables: {} },
    options: MigrationOptions = {},
  ): MigrationResult {
    this.assertOpen();
    return applyMigrations(this, schema, { table: "_mubo_migrations", safeOnly: true, ...options });
  }

  close(force = false): void {
    if (this.closed) return;
    this.closed = true;
    this.raw.close(force);
  }
}
