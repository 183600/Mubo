import { AsyncLocalStorage } from "node:async_hooks";
import { Database as SQLiteDatabase, type SQLQueryBindings, type Statement } from "bun:sqlite";
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

interface QueuedTransaction {
  run: () => void;
  cancel: (error: MuboError) => void;
}

interface TransactionContext {
  depth: number;
  active: boolean;
  childActive: boolean;
  childQueue: QueuedTransaction[];
  parent?: TransactionContext;
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
  private readonly statementCache = new Map<string, Statement<unknown, QueryArgument[]>>();
  private readonly transactionContext = new AsyncLocalStorage<TransactionContext>();
  private readonly transactionQueue: QueuedTransaction[] = [];
  private transactionActive = false;

  constructor(options: MuboDatabaseOptions) {
    if (typeof options.path !== "string" || options.path.trim().length === 0) {
      throw new MuboError("CONFIG_ERROR", "Database path must not be empty");
    }
    const path = options.path.trim();
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new MuboError("CONFIG_ERROR", `Invalid database busy timeout: ${busyTimeoutMs}`);
    }
    const slowQueryMs = options.slowQueryMs ?? 200;
    if (!Number.isInteger(slowQueryMs) || slowQueryMs < 0) {
      throw new MuboError("CONFIG_ERROR", `Invalid slow query threshold: ${slowQueryMs}`);
    }
    if (options.wal !== undefined && typeof options.wal !== "boolean") {
      throw new MuboError("CONFIG_ERROR", "Invalid database WAL setting");
    }
    if (options.foreignKeys !== undefined && typeof options.foreignKeys !== "boolean") {
      throw new MuboError("CONFIG_ERROR", "Invalid database foreign keys setting");
    }
    this.path = path;
    this.slowQueryMs = slowQueryMs;
    this.logger = options.logger;
    this.schema = options.schema;
    if (path !== ":memory:") {
      ensureDataDir(path, options.dataDir ?? process.cwd());
    }
    try {
      this.raw = new SQLiteDatabase(path, { create: true, readwrite: true, strict: true });
    } catch (error) {
      throw new MuboError("CONFIG_ERROR", `Cannot open SQLite database at ${path}`, {
        cause: error,
      });
    }
    this.raw.run(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
    if (options.foreignKeys ?? true) this.raw.run("PRAGMA foreign_keys = ON");
    if (options.wal ?? true) {
      try {
        this.raw.run("PRAGMA journal_mode = WAL");
      } catch {
        // Some filesystems (or :memory:) do not support WAL; SQLite falls back safely.
      }
    }
    this.raw.run("PRAGMA synchronous = NORMAL");
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  get transactionBusy(): boolean {
    return this.transactionActive || this.transactionQueue.length > 0;
  }

  private assertOpen(): void {
    if (this.closed) throw new MuboError("MIGRATION_ERROR", "Database is closed");
  }

  private assertTransactionActive(): void {
    let context = this.transactionContext.getStore();
    while (context) {
      if (!context.active) {
        throw new MuboError("INTERNAL_ERROR", "Transaction is no longer active");
      }
      context = context.parent;
    }
  }

  private timed<T>(sql: string, operation: () => T): T {
    this.assertOpen();
    this.assertTransactionActive();
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

  private statement<Row>(sql: string): Statement<Row, QueryArgument[]> {
    const cached = this.statementCache.get(sql);
    if (cached) return cached as Statement<Row, QueryArgument[]>;
    const statement = this.raw.query<Row, QueryArgument[]>(sql);
    this.statementCache.set(sql, statement as Statement<unknown, QueryArgument[]>);
    return statement;
  }

  query<Row = Record<string, unknown>>(sql: string): QueryResult<Row> {
    return {
      all: (...params) => this.timed(sql, () => this.statement<Row>(sql).all(...normalizeParams(params))),
      get: (...params) => this.timed(sql, () => this.statement<Row>(sql).get(...normalizeParams(params))),
      run: (...params) => this.timed(sql, () => this.statement<Row>(sql).run(...normalizeParams(params))),
      values: (...params) => this.timed(sql, () => this.statement<Row>(sql).values(...normalizeParams(params))),
      iterate: (...params) => {
        this.assertOpen();
        this.assertTransactionActive();
        const context = this.transactionContext.getStore();
        const iterator = this.raw.query<Row, QueryArgument[]>(sql).iterate(...normalizeParams(params));
        const assertIteratorActive = () => {
          this.assertOpen();
          let current = context;
          while (current) {
            if (!current.active) {
              throw new MuboError("INTERNAL_ERROR", "Transaction is no longer active");
            }
            current = current.parent;
          }
        };
        return (function* () {
          try {
            while (true) {
              assertIteratorActive();
              const next = iterator.next();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            iterator.return?.();
          }
        })();
      },
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
    this.assertTransactionActive();
    const current = this.transactionContext.getStore();
    if (current?.active) {
      return this.runNestedTransaction(current, fn, options.immediate !== false);
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

  private runNestedTransaction<T>(
    parent: TransactionContext,
    fn: (db: MuboDatabase) => T | Promise<T>,
    immediate: boolean,
  ): T | Promise<T> {
    if (parent.childActive) {
      return new Promise<T>((resolve, reject) => {
        parent.childQueue.push({
          run: () => {
            let result: T | Promise<T>;
            try {
              result = this.executeTransaction(fn, parent.depth, immediate, parent);
            } catch (error) {
              reject(error);
              this.finishChildTransaction(parent);
              return;
            }
            if (result instanceof Promise) {
              result.then(
                (value) => {
                  resolve(value);
                  this.finishChildTransaction(parent);
                },
                (error) => {
                  reject(error);
                  this.finishChildTransaction(parent);
                },
              );
            } else {
              resolve(result);
              this.finishChildTransaction(parent);
            }
          },
          cancel: reject,
        });
      });
    }

    parent.childActive = true;
    let result: T | Promise<T>;
    try {
      result = this.executeTransaction(fn, parent.depth, immediate, parent);
    } catch (error) {
      this.finishChildTransaction(parent);
      throw error;
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          this.finishChildTransaction(parent);
          return value;
        },
        (error) => {
          this.finishChildTransaction(parent);
          throw error;
        },
      );
    }
    this.finishChildTransaction(parent);
    return result;
  }

  private finishChildTransaction(parent: TransactionContext): void {
    parent.childActive = false;
    const next = parent.childQueue.shift();
    if (!next) return;
    parent.childActive = true;
    next.run();
  }

  private executeTransaction<T>(
    fn: (db: MuboDatabase) => T | Promise<T>,
    parentDepth: number,
    immediate: boolean,
    parentContext?: TransactionContext,
  ): T | Promise<T> {
    const context: TransactionContext = {
      depth: parentDepth + 1,
      active: true,
      childActive: false,
      childQueue: [],
      parent: parentContext,
    };
    const savepoint = `mubo_sp_${parentDepth}`;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      context.active = false;
      const pending = context.childQueue.splice(0);
      context.childActive = false;
      if (pending.length === 0) return;
      const error = new MuboError(
        "INTERNAL_ERROR",
        "Nested transaction was cancelled because its parent transaction completed",
      );
      for (const task of pending) task.cancel(error);
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
      this.transactionQueue.push({
        run: () => {
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
        },
        cancel: (error) => reject(error),
      });
      this.drainTransactions();
    });
  }

  private drainTransactions(): void {
    if (this.transactionActive) return;
    const next = this.transactionQueue.shift();
    if (!next) return;
    this.transactionActive = true;
    next.run();
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
    this.statementCache.clear();
    const pending = this.transactionQueue.splice(0);
    if (pending.length > 0) {
      const error = new MuboError("MIGRATION_ERROR", "Database is closed");
      for (const task of pending) task.cancel(error);
    }
    this.raw.close(force);
  }
}
