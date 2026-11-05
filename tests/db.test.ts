import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMuboApp } from "../src/core/app.ts";
import { MuboDatabase } from "../src/db/database.ts";
import { defineSchema } from "../src/db/schema.ts";
import { MuboError } from "../src/core/errors.ts";
import { createLogger } from "../src/core/logger.ts";
import { acquireFileLock, releaseFileLock } from "../src/db/migrations.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mubo-db-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const baseSchema = defineSchema({
  tables: {
    users: {
      columns: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        email: { type: "text", notNull: true, unique: true },
        name: { type: "text", notNull: true },
        created_at: { type: "integer", notNull: true },
      },
      indexes: [{ name: "idx_users_created_at", columns: ["created_at"] }],
    },
  },
});

describe("database and automatic migrations", () => {
  test("creates schema, supports CRUD, and is idempotent", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const first = await db.migrate(baseSchema);
    expect(first.status).toBe("applied");
    expect(first.statements.some((sql) => sql.startsWith('CREATE TABLE "users"'))).toBe(true);

    db.query("INSERT INTO users (email, name, created_at) VALUES (?, ?, ?)").run(
      "a@example.com",
      "Alice",
      Date.now(),
    );
    const user = db.query<{ id: number; name: string }>("SELECT id, name FROM users WHERE email = ?").get(
      "a@example.com",
    );
    expect(user?.name).toBe("Alice");

    const second = await db.migrate(baseSchema);
    expect(second.status).toBe("none");
    expect(db.ping()).toBe(true);
    db.close();
  });

  test("applies NORMAL synchronous mode even when WAL is disabled", () => {
    const db = new MuboDatabase({ path: ":memory:", wal: false });
    expect(db.raw.query("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    db.close();
  });

  test("plans keyword-like identifiers idempotently, including partial indexes", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const schema = defineSchema({
      tables: {
        where: {
          columns: {
            id: { type: "integer", primaryKey: true },
            where: { type: "text" },
          },
          indexes: [
            {
              name: "idx_where_value",
              columns: ["where"],
              where: '"where" IS NOT NULL',
            },
          ],
        },
      },
    });

    expect((await db.migrate(schema)).status).toBe("applied");
    expect((await db.migrate(schema)).status).toBe("none");
    db.close();
  });

  test("exec runs multiple SQL statements", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE first (id INTEGER PRIMARY KEY); CREATE TABLE second (id INTEGER PRIMARY KEY);");
    const tables = db
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('first', 'second')")
      .all();
    expect(tables).toHaveLength(2);
    db.close();
  });

  test("reports SQLite failures as DB_ERROR with the failing statement", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    try {
      let caught: unknown;
      try {
        db.query("SELECT FROM WHERE").all();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MuboError);
      const failure = caught as MuboError;
      expect(failure.code).toBe("DB_ERROR");
      expect(failure.status).toBe(500);
      expect(failure.expose).toBe(false);
      expect(failure.details).toMatchObject({ sql: "SELECT FROM WHERE" });
      expect(failure.cause).toBeInstanceOf(Error);

      let execFailure: unknown;
      try {
        db.exec("NOT SQL");
      } catch (error) {
        execFailure = error;
      }
      expect(execFailure).toBeInstanceOf(MuboError);
      expect((execFailure as MuboError).code).toBe("DB_ERROR");
      expect((execFailure as MuboError).details).toMatchObject({ sql: "NOT SQL" });

      let iterateFailure: unknown;
      try {
        db.query("SELECT FROM WHERE").iterate().next();
      } catch (error) {
        iterateFailure = error;
      }
      expect(iterateFailure).toBeInstanceOf(MuboError);
      expect((iterateFailure as MuboError).code).toBe("DB_ERROR");
    } finally {
      db.close();
    }
  });

  test("reports constraint violations as DB_ERROR", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)");
    try {
      db.query("INSERT INTO users (email) VALUES (?)").run("ada@example.com");
      let caught: unknown;
      try {
        db.query("INSERT INTO users (email) VALUES (?)").run("ada@example.com");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MuboError);
      expect((caught as MuboError).code).toBe("DB_ERROR");
      expect((caught as MuboError).message).toContain("UNIQUE constraint failed");
    } finally {
      db.close();
    }
  });

  test("reports COMMIT failures as DB_ERROR and rolls back deferred violations", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (pid INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    `);
    try {
      let caught: unknown;
      try {
        db.transaction((tx) => {
          tx.query("INSERT INTO child (pid) VALUES (?)").run(999);
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MuboError);
      const failure = caught as MuboError;
      expect(failure.code).toBe("DB_ERROR");
      expect(failure.details).toMatchObject({ sql: "COMMIT" });
      expect(failure.cause).toBeInstanceOf(Error);
      expect(failure.message).toContain("FOREIGN KEY constraint failed");
      // The failed commit must leave the transaction rolled back.
      expect(db.query("SELECT COUNT(*) AS c FROM child").get()).toEqual({ c: 0 });
    } finally {
      db.close();
    }
  });

  test("reports a closed database with the DB_CLOSED code", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.close();

    let caught: unknown;
    try {
      db.query("SELECT 1").get();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MuboError);
    expect((caught as MuboError).code).toBe("DB_CLOSED");
    expect((caught as MuboError).status).toBe(503);
    expect((caught as MuboError).message).toBe("Database is closed");
  });

  test("cancels queued transactions with the DB_CLOSED code", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = db.transaction(async () => {
      await gate;
      return "active";
    });
    const queued = db.transaction(() => "queued");

    db.close();
    let caught: unknown;
    try {
      await queued;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MuboError);
    expect((caught as MuboError).code).toBe("DB_CLOSED");
    release();
    await expect(active).rejects.toThrow();
  });

  test("persists migrations and applies additive changes after restart", async () => {
    const path = join(tempDir(), "app.sqlite");
    const v1 = new MuboDatabase({ path });
    expect((await v1.migrate(baseSchema)).status).toBe("applied");
    v1.query("INSERT INTO users (email, name, created_at) VALUES (?, ?, ?)").run(
      "old@example.com",
      "Old",
      1,
    );
    v1.close();

    const v2Schema = defineSchema({
      tables: {
        ...baseSchema.tables,
        users: {
          columns: {
            ...baseSchema.tables.users.columns,
            nickname: { type: "text", default: "anonymous" },
          },
          indexes: [
            ...(baseSchema.tables.users.indexes ?? []),
            { name: "idx_users_email", columns: ["email"], unique: true },
          ],
        },
        notes: {
          columns: {
            id: { type: "integer", primaryKey: true },
            body: { type: "text", notNull: true },
          },
        },
      },
    });

    const v2 = new MuboDatabase({ path });
    const result = await v2.migrate(v2Schema);
    expect(result.status).toBe("applied");
    expect(result.changes).toContain("add column users.nickname");
    expect(result.changes).toContain("create table notes");
    const old = v2.query<{ nickname: string; name: string }>("SELECT nickname, name FROM users WHERE email = ?").get(
      "old@example.com",
    );
    expect(old).toEqual({ nickname: "anonymous", name: "Old" });
    expect((await v2.migrate(v2Schema)).status).toBe("none");
    v2.close();
  });


  test("honors NOT NULL on primary keys and rejects unsafe added constraints", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    await db.migrate(
      defineSchema({
        tables: {
          tokens: {
            columns: {
              id: { type: "text", primaryKey: true, notNull: true },
              value: { type: "text" },
            },
          },
        },
      }),
    );
    const columns = db.query<{ name: string; notnull: number }>('PRAGMA table_info("tokens")').all();
    expect(columns.find((column) => column.name === "id")?.notnull).toBe(1);

    const unsafeUnique = defineSchema({
      tables: {
        tokens: {
          columns: {
            id: { type: "text", primaryKey: true, notNull: true },
            value: { type: "text" },
            slug: { type: "text", unique: true },
          },
        },
      },
    });
    await expect(db.migrate(unsafeUnique)).rejects.toThrow(/UNIQUE column/);
    db.close();
  });
  test("detects unique-column and partial-index changes on existing schema", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const initial = defineSchema({
      tables: {
        users: {
          columns: {
            id: { type: "integer", primaryKey: true },
            email: { type: "text" },
          },
          indexes: [{ name: "idx_users_email", columns: ["email"] }],
        },
      },
    });
    await db.migrate(initial);

    await expect(
      db.migrate(
        defineSchema({
          tables: {
            users: {
              columns: {
                id: { type: "integer", primaryKey: true },
                email: { type: "text", unique: true },
              },
              indexes: [{ name: "idx_users_email", columns: ["email"] }],
            },
          },
        }),
      ),
    ).rejects.toThrow(/UNIQUE constraint change/);

    await expect(
      db.migrate(
        defineSchema({
          tables: {
            users: {
              columns: {
                id: { type: "integer", primaryKey: true },
                email: { type: "text" },
              },
              indexes: [{ name: "idx_users_email", columns: ["email"], where: "email IS NOT NULL" }],
            },
          },
        }),
      ),
    ).rejects.toThrow(/different definition/);

    const singleUniqueIndex = defineSchema({
      tables: {
        accounts: {
          columns: {
            id: { type: "integer", primaryKey: true },
            email: { type: "text" },
          },
          indexes: [{ name: "idx_accounts_email", columns: ["email"], unique: true }],
        },
      },
    });
    expect((await db.migrate(singleUniqueIndex)).status).toBe("applied");
    expect((await db.migrate(singleUniqueIndex)).status).toBe("none");
    db.close();
  });

  test("rejects existing indexes with custom collations", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); " +
        "CREATE INDEX idx_users_email ON users(email COLLATE NOCASE);",
    );
    await expect(
      db.migrate(
        defineSchema({
          tables: {
            users: {
              columns: {
                id: { type: "integer", primaryKey: true },
                email: { type: "text" },
              },
              indexes: [{ name: "idx_users_email", columns: ["email"] }],
            },
          },
        }),
      ),
    ).rejects.toThrow(/different definition/);
    db.close();
  });

  test("introspects existing indexes with quoted names", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); ' +
        'CREATE INDEX "idx-email weird" ON users(email);',
    );
    const schema = defineSchema({
      tables: {
        users: {
          columns: {
            id: { type: "integer", primaryKey: true },
            email: { type: "text" },
          },
        },
      },
    });
    expect((await db.migrate(schema)).status).toBe("none");
    db.close();
  });

  test("does not collapse whitespace inside index string literals", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec(
      "CREATE TABLE labels (id INTEGER PRIMARY KEY, name TEXT); " +
        "CREATE INDEX idx_labels_name ON labels(name) WHERE name = 'a  b';",
    );
    const schema = defineSchema({
      tables: {
        labels: {
          columns: {
            id: { type: "integer", primaryKey: true },
            name: { type: "text" },
          },
          indexes: [
            { name: "idx_labels_name", columns: ["name"], where: "name = 'a b'" },
          ],
        },
      },
    });
    expect(() => db.migrate(schema)).toThrow(/different definition/);
    db.close();
  });

  test("rejects existing indexes with descending columns", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); " +
        "CREATE INDEX idx_users_email ON users(email DESC);",
    );
    expect(() =>
      db.migrate(
        defineSchema({
          tables: {
            users: {
              columns: {
                id: { type: "integer", primaryKey: true },
                email: { type: "text" },
              },
              indexes: [{ name: "idx_users_email", columns: ["email"] }],
            },
          },
        }),
      ),
    ).toThrow(/different definition/);
    db.close();
  });

  test("does not treat partial unique indexes as full column constraints", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec(
      "CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT); " +
        "CREATE UNIQUE INDEX idx_accounts_email ON accounts(email) WHERE email IS NOT NULL;",
    );

    const schema = defineSchema({
      tables: {
        accounts: {
          columns: {
            id: { type: "integer", primaryKey: true },
            email: { type: "text", unique: true },
          },
        },
      },
    });
    expect(() => db.migrate(schema)).toThrow(/UNIQUE constraint change/);

    const partial = defineSchema({
      tables: {
        accounts: {
          columns: {
            id: { type: "integer", primaryKey: true },
            email: { type: "text" },
          },
          indexes: [
            { name: "idx_accounts_email", columns: ["email"], unique: true, where: "email IS NOT NULL" },
          ],
        },
      },
    });
    expect((await db.migrate(partial)).status).toBe("none");
    db.close();
  });

  test("rejects index names that already exist on another table", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE legacy (id INTEGER PRIMARY KEY); CREATE INDEX idx_shared ON legacy(id);");

    const schema = defineSchema({
      tables: {
        notes: {
          columns: {
            id: { type: "integer", primaryKey: true },
            legacy_id: { type: "integer" },
          },
          indexes: [{ name: "idx_shared", columns: ["legacy_id"] }],
        },
      },
    });
    expect(() => db.migrate(schema)).toThrow(/already exists on table legacy/);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get(),
    ).toBeNull();
    db.close();
  });

  test("rejects table and index names that collide globally", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE legacy (id INTEGER PRIMARY KEY); CREATE INDEX idx_taken ON legacy(id);");

    expect(() =>
      db.migrate(
        defineSchema({
          tables: {
            notes: {
              columns: { id: { type: "integer", primaryKey: true } },
              indexes: [{ name: "legacy", columns: ["id"] }],
            },
          },
        }),
      ),
    ).toThrow(/conflicts with an existing table/);

    expect(() =>
      db.migrate(
        defineSchema({
          tables: {
            idx_taken: { columns: { id: { type: "integer", primaryKey: true } } },
          },
        }),
      ),
    ).toThrow(/conflicts with an existing index/);

    expect(() =>
      db.plan(
        defineSchema({
          tables: {
            users: {
              columns: { id: { type: "integer", primaryKey: true } },
              indexes: [{ name: "users", columns: ["id"] }],
            },
          },
        }),
      ),
    ).toThrow(/Index name users conflicts with table users/);

    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notes', 'idx_taken')").get(),
    ).toBeNull();
    db.close();
  });

  test("rejects collisions with existing SQLite views", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE VIEW legacy_view AS SELECT 1 AS id");

    expect(() =>
      db.migrate(
        defineSchema({
          tables: {
            legacy_view: { columns: { id: { type: "integer", primaryKey: true } } },
          },
        }),
      ),
    ).toThrow(/Table legacy_view conflicts with an existing view/);

    expect(() =>
      db.migrate(
        defineSchema({
          tables: {
            notes: {
              columns: { id: { type: "integer", primaryKey: true } },
              indexes: [{ name: "legacy_view", columns: ["id"] }],
            },
          },
        }),
      ),
    ).toThrow(/Index legacy_view conflicts with an existing view/);

    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get(),
    ).toBeNull();
    db.close();
  });

  test("treats SQLite identifiers case-insensitively during planning", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    await db.migrate(
      defineSchema({
        tables: {
          Users: {
            columns: {
              ID: { type: "integer", primaryKey: true, autoIncrement: true },
              EMAIL: { type: "text", notNull: true },
              CREATED_AT: { type: "integer", notNull: true },
            },
            indexes: [{ name: "IDX_USERS_CREATED", columns: ["CREATED_AT"] }],
          },
        },
      }),
    );

    const equivalent = defineSchema({
      tables: {
        users: {
          columns: {
            id: { type: "integer", primaryKey: true, autoIncrement: true },
            email: { type: "text", notNull: true },
            created_at: { type: "integer", notNull: true },
          },
          indexes: [{ name: "idx_users_created", columns: ["created_at"] }],
        },
      },
    });
    expect((await db.migrate(equivalent)).status).toBe("none");
    db.close();
  });

  test("rejects primary-key and foreign-key changes on existing columns", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const initial = defineSchema({
      tables: {
        parents: {
          columns: { id: { type: "integer", primaryKey: true } },
        },
        children: {
          columns: {
            id: { type: "integer", primaryKey: true },
            parent_id: {
              type: "integer",
              references: { table: "parents", onDelete: "CASCADE" },
            },
            legacy_id: { type: "integer" },
          },
        },
      },
    });
    await db.migrate(initial);
    expect((await db.migrate(initial)).status).toBe("none");

    expect(() =>
      db.migrate(
        defineSchema({
          tables: {
            parents: {
              columns: { id: { type: "integer", primaryKey: true } },
            },
            children: {
              columns: {
                id: { type: "integer", primaryKey: true },
                parent_id: {
                  type: "integer",
                  references: { table: "parents", onDelete: "RESTRICT" },
                },
                legacy_id: { type: "integer" },
              },
            },
          },
        }),
      ),
    ).toThrow(/Foreign-key change/);

    expect(() =>
      db.migrate(
        defineSchema({
          tables: {
            parents: {
              columns: { id: { type: "integer", primaryKey: true } },
            },
            children: {
              columns: {
                id: { type: "integer", primaryKey: true },
                parent_id: {
                  type: "integer",
                  references: { table: "parents", onDelete: "CASCADE" },
                },
                legacy_id: {
                  type: "integer",
                  references: { table: "parents" },
                },
              },
            },
          },
        }),
      ),
    ).toThrow(/Foreign-key change/);

    expect(() =>
      db.migrate(
        defineSchema({
          tables: {
            parents: {
              columns: { id: { type: "integer" } },
            },
            children: {
              columns: {
                id: { type: "integer", primaryKey: true },
                parent_id: {
                  type: "integer",
                  references: { table: "parents", onDelete: "CASCADE" },
                },
                legacy_id: { type: "integer" },
              },
            },
          },
        }),
      ),
    ).toThrow(/Primary-key change/);
    db.close();
  });

  test("accepts common parameterized column types", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const result = await db.migrate(
      defineSchema({
        tables: {
          prices: {
            columns: {
              id: { type: "integer", primaryKey: true },
              amount: { type: "decimal(10,2)", notNull: true },
            },
          },
        },
      }),
    );
    expect(result.status).toBe("applied");
    const columns = db.query<{ name: string; type: string }>('PRAGMA table_info("prices")').all();
    expect(columns.find((column) => column.name === "amount")?.type).toBe("DECIMAL(10,2)");
    db.close();
  });

  test("rejects malformed schema definitions", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const cases: Array<{ schema: unknown; message: RegExp }> = [
      { schema: { tables: null }, message: /Invalid schema definition/ },
      { schema: { tables: { invalid: null } }, message: /Invalid table definition/ },
      { schema: { tables: { items: { columns: null } } }, message: /must define a columns object/ },
      {
        schema: { tables: { items: { columns: { id: null } } } },
        message: /Invalid column definition/,
      },
      {
        schema: {
          tables: { items: { columns: { id: { type: "text", default: { bad: true } } } } },
        },
        message: /Invalid default value/,
      },
      {
        schema: {
          tables: { items: { columns: { id: { type: "text", sqlDefault: 42 } } } },
        },
        message: /Invalid SQL default/,
      },
      {
        schema: {
          tables: {
            items: {
              columns: { id: { type: "text" } },
              indexes: [{ name: "idx_items", columns: "id" }],
            },
          },
        },
        message: /needs a columns array/,
      },
      { schema: { tables: { empty: { columns: {} } } }, message: /at least one column/ },
      {
        schema: {
          tables: { items: { columns: { id: { type: "text" }, ID: { type: "text" } } } },
        },
        message: /defines column ID more than once/,
      },
      {
        schema: {
          tables: {
            items: { columns: { id: { type: "text" } } },
            Items: { columns: { id: { type: "text" } } },
          },
        },
        message: /Table Items is defined more than once/,
      },
      {
        schema: {
          tables: {
            first: {
              columns: { id: { type: "text" } },
              indexes: [{ name: "shared_idx", columns: ["id"] }],
            },
            second: {
              columns: { id: { type: "text" } },
              indexes: [{ name: "SHARED_IDX", columns: ["id"] }],
            },
          },
        },
        message: /Index name SHARED_IDX is used by both first and second/,
      },
      {
        schema: {
          tables: {
            multi: {
              columns: {
                a: { type: "text", primaryKey: true },
                b: { type: "text", primaryKey: true },
              },
            },
          },
        },
        message: /multiple primary keys/,
      },
      {
        schema: { tables: { "bad-name": { columns: { id: { type: "text" } } } } },
        message: /Invalid SQL identifier/,
      },
      {
        schema: { tables: { items: { columns: { id: { type: "text!" } } } } },
        message: /Invalid column type/,
      },
      {
        schema: { tables: { items: { columns: { id: { type: "integer", autoIncrement: true } } } } },
        message: /AUTOINCREMENT requires a primary key/,
      },
      {
        schema: {
          tables: {
            items: {
              columns: {
                parent_id: {
                  type: "text",
                  notNull: true,
                  references: { table: "parents", onDelete: "SET NULL" },
                },
              },
            },
          },
        },
        message: /SET NULL action cannot be used with NOT NULL column items.parent_id/,
      },
      {
        schema: {
          tables: {
            items: {
              columns: { id: { type: "text", primaryKey: true, autoIncrement: true } },
            },
          },
        },
        message: /AUTOINCREMENT requires an INTEGER primary key/,
      },
      {
        schema: {
          tables: {
            items: {
              columns: { id: { type: "text" } },
              indexes: [{ name: "idx_items", columns: [] }],
            },
          },
        },
        message: /needs at least one column/,
      },
      {
        schema: {
          tables: {
            items: {
              columns: { id: { type: "text" } },
              indexes: [{ name: "bad name", columns: ["id"] }],
            },
          },
        },
        message: /Invalid SQL identifier/,
      },
      {
        schema: { tables: { items: { columns: { id: { type: 42 } } } } },
        message: /Invalid column type/,
      },
      {
        schema: { tables: { items: { columns: { id: { type: "text", notNull: "yes" } } } } },
        message: /Invalid notNull setting/,
      },
      {
        schema: { tables: { items: { columns: { id: { type: "text", sqlDefault: "   " } } } } },
        message: /Invalid SQL default/,
      },
      {
        schema: {
          tables: {
            items: {
              columns: { id: { type: "text" } },
              indexes: [{ name: "idx_items", columns: ["id"], where: 42 }],
            },
          },
        },
        message: /Invalid WHERE clause/,
      },
      {
        schema: {
          tables: {
            items: {
              columns: { id: { type: "text" } },
              indexes: [{ name: "idx_items", columns: ["id"], where: "   " }],
            },
          },
        },
        message: /Invalid WHERE clause/,
      },
      {
        schema: {
          tables: {
            items: {
              columns: { id: { type: "text" } },
              indexes: [{ name: "idx_items", columns: ["missing"] }],
            },
          },
        },
        message: /references unknown column missing/,
      },
      {
        schema: {
          tables: {
            items: {
              columns: {
                parent_id: { type: "text", references: { table: "parents", onDelete: 42 } },
              },
            },
          },
        },
        message: /Invalid ON DELETE action/,
      },
      {
        schema: {
          tables: {
            first: {
              columns: { id: { type: "text" } },
              indexes: [{ name: "shared_idx", columns: ["id"] }],
            },
            second: {
              columns: { id: { type: "text" } },
              indexes: [{ name: "shared_idx", columns: ["id"] }],
            },
          },
        },
        message: /Index name shared_idx is used by both first and second/,
      },
    ];

    for (const item of cases) {
      expect(() => db.plan(item.schema as never)).toThrow(item.message);
    }
    db.close();
  });

  test("logs slow queries and rejects operations after close", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    const db = new MuboDatabase({
      path: ":memory:",
      slowQueryMs: 0,
      logger: createLogger({ level: "warn", json: true }),
    });
    try {
      expect(db.query("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(1);
    const entry = JSON.parse(warnings[0]!);
    expect(entry.message).toBe("Slow SQL query");
    expect(entry.sql).toBe("SELECT 1 AS ok");

    db.close();
    expect(() => db.query("SELECT 1").get()).toThrow(/Database is closed/);
    expect(() => db.query("SELECT 1").iterate()).toThrow(/Database is closed/);
    expect(() => db.exec("SELECT 1")).toThrow(/Database is closed/);
    expect(db.ping()).toBe(false);
  });

  test("rejects invalid foreign-key actions", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const invalid = defineSchema({
      tables: {
        parents: { columns: { id: { type: "integer", primaryKey: true } } },
        children: {
          columns: {
            id: { type: "integer", primaryKey: true },
            parent_id: {
              type: "integer",
              references: {
                table: "parents",
                onDelete: "CASCADE; DROP TABLE parents" as never,
              },
            },
          },
        },
      },
    });
    expect(() => db.migrate(invalid)).toThrow(/Invalid ON DELETE action/);
    expect(() => db.plan(invalid)).toThrow(/Invalid ON DELETE action/);
    db.close();
  });

  test("detects auto-increment changes on existing primary keys", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const plain = defineSchema({
      tables: {
        counters: {
          columns: {
            id: { type: "integer", primaryKey: true },
            name: { type: "text" },
          },
        },
      },
    });
    await db.migrate(plain);

    expect(() =>
      db.migrate(
        defineSchema({
          tables: {
            counters: {
              columns: {
                id: { type: "integer", primaryKey: true, autoIncrement: true },
                name: { type: "text" },
              },
            },
          },
        }),
      ),
    ).toThrow(/Auto-increment change/);

    const auto = new MuboDatabase({ path: ":memory:" });
    const autoIncrementing = defineSchema({
      tables: {
        counters: {
          columns: {
            id: { type: "integer", primaryKey: true, autoIncrement: true },
            name: { type: "text" },
          },
        },
      },
    });
    await auto.migrate(autoIncrementing);
    expect(() =>
      auto.migrate(
        defineSchema({
          tables: {
            counters: {
              columns: {
                id: { type: "integer", primaryKey: true },
                name: { type: "text" },
              },
            },
          },
        }),
      ),
    ).toThrow(/Auto-increment change/);

    db.close();
    auto.close();
  });

  test("rejects migration history tables missing required columns", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE _mubo_migrations (id TEXT PRIMARY KEY)");

    expect(() => db.migrate(baseSchema)).toThrow(
      /Migration table _mubo_migrations is missing required columns: applied_at, checksum, meta/,
    );
    expect(() => db.migrate(baseSchema, { mode: "check" })).toThrow(
      /missing required columns: applied_at, checksum, meta/,
    );
    db.close();
  });

  test("rolls back schema changes when migration history cannot be recorded", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    expect((await db.migrate(baseSchema)).status).toBe("applied");
    const withNotes = defineSchema({
      tables: {
        ...baseSchema.tables,
        notes: {
          columns: {
            id: { type: "integer", primaryKey: true },
            body: { type: "text", notNull: true },
          },
        },
      },
    });
    db.exec(
      "CREATE TRIGGER fail_migration_history BEFORE INSERT ON _mubo_migrations BEGIN SELECT RAISE(ABORT, 'history blocked'); END",
    );

    expect(() => db.migrate(withNotes)).toThrow(/Failed to record migration history/);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get(),
    ).toBeNull();
    expect(db.query<{ count: number }>("SELECT COUNT(*) AS count FROM _mubo_migrations").get()).toEqual({
      count: 1,
    });
    db.close();
  });

  test("rejects dropping declared columns while leaving unrelated tables untouched", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const withNotes = defineSchema({
      tables: {
        ...baseSchema.tables,
        notes: {
          columns: {
            id: { type: "integer", primaryKey: true },
            body: { type: "text", notNull: true },
          },
        },
      },
    });
    expect((await db.migrate(withNotes)).status).toBe("applied");

    const withoutName = defineSchema({
      tables: {
        users: {
          columns: {
            id: { type: "integer", primaryKey: true, autoIncrement: true },
            email: { type: "text", notNull: true, unique: true },
            created_at: { type: "integer", notNull: true },
          },
          indexes: [{ name: "idx_users_created_at", columns: ["created_at"] }],
        },
        notes: withNotes.tables.notes,
      },
    });
    expect(() => db.migrate(withoutName)).toThrow(/Dropping column users\.name/);
    expect((await db.migrate(baseSchema)).status).toBe("none");

    db.exec("CREATE TABLE legacy (id INTEGER PRIMARY KEY)");
    expect((await db.migrate(withNotes)).status).toBe("none");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy'").get(),
    ).toBeTruthy();
    db.close();
  });

  test("accepts a destructive change after the SQL was applied manually", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const withName = defineSchema({
      tables: {
        users: {
          columns: {
            id: { type: "integer", primaryKey: true, autoIncrement: true },
            name: { type: "text" },
          },
        },
      },
    });
    const withoutName = defineSchema({
      tables: {
        users: {
          columns: { id: { type: "integer", primaryKey: true, autoIncrement: true } },
        },
      },
    });
    expect((await db.migrate(withName)).status).toBe("applied");
    await expect(db.migrate(withoutName)).rejects.toThrow(/Dropping column users\.name/);

    // The documented escape hatch: destructive SQL is applied by hand and the
    // automatic migration then sees the updated structure.
    db.exec("ALTER TABLE users DROP COLUMN name");
    expect((await db.migrate(withoutName)).status).toBe("none");
    expect(
      db.query("SELECT name FROM pragma_table_info('users') WHERE name = 'name'").get(),
    ).toBeNull();
    db.close();
  });

  test("repairs missing schema objects even when a plan was applied before", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const schema = defineSchema({
      tables: {
        users: {
          columns: {
            id: { type: "integer", primaryKey: true },
            email: { type: "text", notNull: true },
          },
          indexes: [{ name: "idx_users_email", columns: ["email"], unique: true }],
        },
      },
    });
    expect((await db.migrate(schema)).status).toBe("applied");
    db.exec("DROP TABLE users");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get(),
    ).toBeNull();

    const repaired = await db.migrate(schema);
    expect(repaired.status).toBe("applied");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get(),
    ).toBeTruthy();
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_email'").get(),
    ).toBeTruthy();
    const history = db
      .query<{ count: number }>("SELECT COUNT(*) AS count FROM _mubo_migrations")
      .get();
    expect(history?.count).toBe(1);
    db.close();
  });

  test("detects nullability changes on primary-key columns", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    await db.migrate(
      defineSchema({
        tables: {
          tokens: {
            columns: {
              id: { type: "text", primaryKey: true },
              value: { type: "text" },
            },
          },
        },
      }),
    );
    expect(() =>
      db.migrate(
        defineSchema({
          tables: {
            tokens: {
              columns: {
                id: { type: "text", primaryKey: true, notNull: true },
                value: { type: "text" },
              },
            },
          },
        }),
      ),
    ).toThrow(/nullability change/);
    db.close();
  });

  test("detects default-value changes on existing columns", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const initial = defineSchema({
      tables: {
        settings: {
          columns: {
            id: { type: "integer", primaryKey: true },
            role: { type: "text", default: "member" },
            enabled: { type: "boolean", default: true },
            code: { type: "text", sqlDefault: "(lower('X'))" },
            updated_at: { type: "integer", sqlDefault: "CURRENT_TIMESTAMP" },
          },
        },
      },
    });
    await db.migrate(initial);
    expect((await db.migrate(initial)).status).toBe("none");

    expect(() =>
      db.migrate(
        defineSchema({
          tables: {
            settings: {
              columns: {
                id: { type: "integer", primaryKey: true },
                role: { type: "text", default: "admin" },
                enabled: { type: "boolean", default: true },
                code: { type: "text", sqlDefault: "(lower('X'))" },
                updated_at: { type: "integer", sqlDefault: "CURRENT_TIMESTAMP" },
              },
            },
          },
        }),
      ),
    ).toThrow(/Default value change for settings\.role/);

    expect(() =>
      db.migrate(
        defineSchema({
          tables: {
            settings: {
              columns: {
                id: { type: "integer", primaryKey: true },
                role: { type: "text" },
                enabled: { type: "boolean", default: true },
                code: { type: "text", sqlDefault: "(lower('X'))" },
                updated_at: { type: "integer", sqlDefault: "CURRENT_TIMESTAMP" },
              },
            },
          },
        }),
      ),
    ).toThrow(/Default value change for settings\.role/);
    db.close();
  });

  test("treats equivalent numeric and keyword defaults as unchanged", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const initial = defineSchema({
      tables: {
        metrics: {
          columns: {
            id: { type: "integer", primaryKey: true },
            ratio: { type: "real", sqlDefault: "1.0" },
            count: { type: "integer", sqlDefault: "0007" },
            updated_at: { type: "text", sqlDefault: "current_timestamp" },
            enabled: { type: "boolean", sqlDefault: "true" },
          },
        },
      },
    });
    await db.migrate(initial);

    const equivalent = defineSchema({
      tables: {
        metrics: {
          columns: {
            id: { type: "integer", primaryKey: true },
            ratio: { type: "real", sqlDefault: "1" },
            count: { type: "integer", sqlDefault: "7" },
            updated_at: { type: "text", sqlDefault: "CURRENT_TIMESTAMP" },
            enabled: { type: "boolean", sqlDefault: "TRUE" },
          },
        },
      },
    });
    expect((await db.migrate(equivalent)).status).toBe("none");

    const changed = defineSchema({
      tables: {
        metrics: {
          columns: {
            id: { type: "integer", primaryKey: true },
            ratio: { type: "real", sqlDefault: "2.0" },
            count: { type: "integer", sqlDefault: "7" },
            updated_at: { type: "text", sqlDefault: "CURRENT_TIMESTAMP" },
            enabled: { type: "boolean", sqlDefault: "TRUE" },
          },
        },
      },
    });
    expect(() => db.migrate(changed)).toThrow(/Default value change for metrics\.ratio/);
    db.close();
  });

  test("normalizes parenthesized defaults containing quoted parentheses", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const schema = defineSchema({
      tables: {
        settings: {
          columns: {
            id: { type: "integer", primaryKey: true },
            note: { type: "text", sqlDefault: "((')'))" },
            label: { type: "text", sqlDefault: "(replace('a)b', 'x', 'y'))" },
            rank: { type: "text", sqlDefault: "((1 /* ) */))" },
          },
        },
      },
    });
    expect((await db.migrate(schema)).status).toBe("applied");
    expect((await db.migrate(schema)).status).toBe("none");
    db.close();
  });

  test("treats boolean SQL literals as numeric defaults", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const literals = defineSchema({
      tables: {
        settings: {
          columns: {
            id: { type: "integer", primaryKey: true },
            enabled: { type: "boolean", sqlDefault: "TRUE" },
            disabled: { type: "boolean", sqlDefault: "false" },
          },
        },
      },
    });
    expect((await db.migrate(literals)).status).toBe("applied");

    const booleans = defineSchema({
      tables: {
        settings: {
          columns: {
            id: { type: "integer", primaryKey: true },
            enabled: { type: "boolean", default: true },
            disabled: { type: "boolean", default: false },
          },
        },
      },
    });
    expect((await db.migrate(booleans)).status).toBe("none");
    db.close();
  });

  test("treats parenthesized NULL sql defaults as no default", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const schema = defineSchema({
      tables: {
        settings: {
          columns: {
            id: { type: "integer", primaryKey: true },
            note: { type: "text", sqlDefault: "(NULL)" },
          },
        },
      },
    });
    expect((await db.migrate(schema)).status).toBe("applied");
    expect((await db.migrate(schema)).status).toBe("none");
    db.close();
  });

  test("stores value defaults literally and keeps sql defaults as SQL", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const schema = defineSchema({
      tables: {
        events: {
          columns: {
            id: { type: "integer", primaryKey: true, autoIncrement: true },
            literal: { type: "text", default: "CURRENT_TIMESTAMP" },
            generated: { type: "text", sqlDefault: "CURRENT_TIMESTAMP" },
          },
        },
      },
    });
    expect((await db.migrate(schema)).status).toBe("applied");
    expect((await db.migrate(schema)).status).toBe("none");

    db.query("INSERT INTO events (id) VALUES (1)").run();
    const row = db.query<{ literal: string; generated: string }>(
      "SELECT literal, generated FROM events WHERE id = 1",
    ).get();
    expect(row?.literal).toBe("CURRENT_TIMESTAMP");
    expect(row?.generated).not.toBe("CURRENT_TIMESTAMP");
    expect(String(row?.generated)).toMatch(/^\d{4}-\d{2}-\d{2} /);
    db.close();
  });

  test("ignores keyword-like identifiers and defaults when detecting autoincrement", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const schema = defineSchema({
      tables: {
        items: {
          columns: {
            id: { type: "integer", primaryKey: true },
            autoincrement: { type: "text" },
            note: { type: "text", default: "AUTOINCREMENT" },
          },
        },
      },
    });
    expect((await db.migrate(schema)).status).toBe("applied");
    expect((await db.migrate(schema)).status).toBe("none");

    const withAutoIncrement = defineSchema({
      tables: {
        counters: {
          columns: {
            id: { type: "integer", primaryKey: true, autoIncrement: true },
            label: { type: "text" },
          },
        },
      },
    });
    expect((await db.migrate(withAutoIncrement)).status).toBe("applied");
    expect((await db.migrate(withAutoIncrement)).status).toBe("none");

    db.exec("CREATE TABLE commented (id INTEGER PRIMARY KEY /* AUTOINCREMENT */)");
    const commented = defineSchema({
      tables: { commented: { columns: { id: { type: "integer", primaryKey: true } } } },
    });
    expect((await db.migrate(commented)).status).toBe("none");
    db.close();
  });

  test("ignores WHERE keywords inside index comments", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); " +
        "CREATE INDEX idx_users_email ON users(email) /* WHERE ignored */ WHERE EMAIL  IS  NOT NULL /* trailing */;",
    );
    const schema = defineSchema({
      tables: {
        users: {
          columns: {
            id: { type: "integer", primaryKey: true },
            email: { type: "text" },
          },
          indexes: [
            { name: "idx_users_email", columns: ["email"], where: "email is not null" },
          ],
        },
      },
    });
    expect((await db.migrate(schema)).status).toBe("none");
    db.close();
  });

  test("ignores redundant parentheses around index predicates", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); " +
        "CREATE INDEX idx_users_email ON users(email) WHERE (((email IS NOT NULL)));",
    );
    const schema = defineSchema({
      tables: {
        users: {
          columns: {
            id: { type: "integer", primaryKey: true },
            email: { type: "text" },
          },
          indexes: [
            { name: "idx_users_email", columns: ["email"], where: "email is not null" },
          ],
        },
      },
    });
    expect((await db.migrate(schema)).status).toBe("none");
    db.close();
  });

  test("rejects non-constant defaults on added columns when the table has rows", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const initial = defineSchema({
      tables: {
        settings: {
          columns: {
            id: { type: "integer", primaryKey: true },
          },
        },
      },
    });
    await db.migrate(initial);
    db.exec("INSERT INTO settings (id) VALUES (1)");

    for (const sqlDefault of ["(lower('X'))", "(1 + 2)"]) {
      const next = defineSchema({
        tables: {
          settings: {
            columns: {
              id: { type: "integer", primaryKey: true },
              created: { type: "text", sqlDefault },
            },
          },
        },
      });
      expect(() => db.plan(next)).toThrow(/non-constant default/);
    }
    db.close();

    const empty = new MuboDatabase({ path: ":memory:" });
    await empty.migrate(initial);
    const next = defineSchema({
      tables: {
        settings: {
          columns: {
            id: { type: "integer", primaryKey: true },
            created: { type: "text", sqlDefault: "CURRENT_TIMESTAMP" },
          },
        },
      },
    });
    expect((await empty.migrate(next)).status).toBe("applied");
    expect(
      empty.query<{ name: string }>("PRAGMA table_info(settings)").all().map((column) => column.name),
    ).toContain("created");
    empty.close();
  });

  test("rejects added NOT NULL columns when the SQL default is NULL", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    await db.migrate(
      defineSchema({
        tables: { settings: { columns: { id: { type: "integer", primaryKey: true } } } },
      }),
    );

    for (const sqlDefault of ["NULL", "(NULL)", "(( NULL ))"]) {
      const next = defineSchema({
        tables: {
          settings: {
            columns: {
              id: { type: "integer", primaryKey: true },
              note: { type: "text", notNull: true, sqlDefault },
            },
          },
        },
      });
      expect(() => db.plan(next)).toThrow(/without a default value/);
    }
    db.close();
  });

  test("caches prepared statements while honoring schema changes and iterators", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    const raw = db.raw as any;
    const originalQuery = raw.query.bind(raw);
    let compiled = 0;
    raw.query = (sql: string) => {
      compiled++;
      return originalQuery(sql);
    };
    try {
      db.query("INSERT INTO items (name) VALUES (?)").run("a");
      db.query("INSERT INTO items (name) VALUES (?)").run("b");
      expect(compiled).toBe(1);

      const select = db.query<{ name: string; extra?: string | null }>("SELECT * FROM items ORDER BY id");
      expect(select.all().map((row) => row.name)).toEqual(["a", "b"]);
      expect(select.all()).toHaveLength(2);
      expect(compiled).toBe(2);

      db.exec("ALTER TABLE items ADD COLUMN extra TEXT DEFAULT 'x'");
      expect(select.all().map((row) => row.extra)).toEqual(["x", "x"]);

      expect([...select.iterate()]).toHaveLength(2);
      expect(compiled).toBe(3);
    } finally {
      raw.query = originalQuery;
      db.close();
    }
  });

  test("guards iterators after their transaction or database closes", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
    db.query("INSERT INTO items (id) VALUES (?)").run(1);

    let inTransaction!: IterableIterator<{ id: number }>;
    db.transaction(() => {
      inTransaction = db.query<{ id: number }>("SELECT id FROM items").iterate();
      expect(inTransaction.next().value).toEqual({ id: 1 });
    });
    expect(() => inTransaction.next()).toThrow(/Transaction is no longer active/);

    const afterClose = db.query<{ id: number }>("SELECT id FROM items").iterate();
    db.close();
    expect(() => afterClose.next()).toThrow(/Database is closed/);
  });

  test("nested transaction rollback rolls back the outer transaction", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    let caught: unknown;
    try {
      db.transaction(() => {
        db.query("INSERT INTO items (name) VALUES (?)").run("outer");
        db.transaction(() => {
          db.query("INSERT INTO items (name) VALUES (?)").run("inner");
          throw new Error("inner boom");
        });
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(
      db.query<{ count: number }>("SELECT COUNT(*) AS count FROM items").get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  test("iterate works outside a transaction and stops after close", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    db.query("INSERT INTO items (name) VALUES ('a'), ('b')").run();
    const rows = [
      ...db.query<{ name: string }>("SELECT name FROM items ORDER BY id").iterate(),
    ];
    expect(rows.map((row) => row.name)).toEqual(["a", "b"]);
    db.close();
    expect(() => db.query("SELECT 1").iterate().next()).toThrow(/Database is closed/);
  });

  test("rejects invalid database options before opening SQLite", async () => {
    expect(() => new MuboDatabase({ path: "" })).toThrow(/path must not be empty/);
    expect(() => new MuboDatabase({ path: "   " })).toThrow(/path must not be empty/);
    const trimmed = new MuboDatabase({ path: "  :memory:  " });
    expect(trimmed.path).toBe(":memory:");
    expect(trimmed.ping()).toBe(true);
    trimmed.close();
    expect(() => new MuboDatabase({ path: ":memory:", busyTimeoutMs: -1 })).toThrow(
      /Invalid database busy timeout/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", busyTimeoutMs: Number.NaN })).toThrow(
      /Invalid database busy timeout/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", busyTimeoutMs: 1.5 })).toThrow(
      /Invalid database busy timeout/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", busyTimeoutMs: "5000" as never })).toThrow(
      /Invalid database busy timeout/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", slowQueryMs: -1 })).toThrow(
      /Invalid slow query threshold/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", slowQueryMs: Number.POSITIVE_INFINITY })).toThrow(
      /Invalid slow query threshold/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", slowQueryMs: 1.5 })).toThrow(
      /Invalid slow query threshold/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", slowQueryMs: "200" as never })).toThrow(
      /Invalid slow query threshold/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", wal: "yes" as never })).toThrow(
      /Invalid database WAL setting/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", foreignKeys: 1 as never })).toThrow(
      /Invalid database foreign keys setting/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", foreignKeys: "true" as never })).toThrow(
      /Invalid database foreign keys setting/,
    );
  });

  test("creates the configured data directory even when the database lives elsewhere", () => {
    const root = tempDir();
    const dataDir = join(root, "data");
    const dbPath = join(root, "storage", "app.sqlite");

    const db = new MuboDatabase({ path: dbPath, dataDir });
    try {
      expect(existsSync(dataDir)).toBe(true);
      expect(existsSync(join(root, "storage"))).toBe(true);
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("rejects invalid migration options when called directly", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const schema = defineSchema({
      tables: { notes: { columns: { id: { type: "integer", primaryKey: true } } } },
    });

    await expect(db.migrate(schema, { mode: "sometimes" as never })).rejects.toThrow(
      /Invalid migration mode/,
    );
    await expect(db.migrate(schema, { safeOnly: "yes" as never })).rejects.toThrow(
      /Invalid safeOnly migration setting/,
    );
    await expect(db.migrate(schema, { table: "bad-name" })).rejects.toThrow(/Invalid SQL identifier/);
    expect(() => db.plan(schema, { table: "bad-name" })).toThrow(/Invalid SQL identifier/);
    const offResult = await db.migrate(schema, { mode: "off" });
    expect(offResult.status).toBe("off");
    db.close();
  });

  test("validates schema before creating migration metadata", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    await expect(
      db.migrate(
        defineSchema({
          tables: {
            items: {
              columns: { id: { type: "text" } },
              indexes: [{ name: "bad-name", columns: ["id"] }],
            },
          },
        }),
      ),
    ).rejects.toThrow(/Invalid SQL identifier/);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_mubo_migrations'").get(),
    ).toBeNull();
    db.close();
  });

  test("rejects migration metadata names that collide with existing objects", async () => {
    const viewDb = new MuboDatabase({ path: ":memory:" });
    viewDb.exec("CREATE VIEW _mubo_migrations AS SELECT 1 AS id");
    expect(() => viewDb.migrate(baseSchema)).toThrow(
      /Migration table _mubo_migrations conflicts with an existing view/,
    );
    expect(viewDb.query("SELECT COUNT(*) AS count FROM _mubo_migrations").get()).toEqual({
      count: 1,
    });
    viewDb.close();

    const indexDb = new MuboDatabase({ path: ":memory:" });
    indexDb.exec(
      "CREATE TABLE legacy (id INTEGER); CREATE INDEX _mubo_migrations ON legacy(id)",
    );
    expect(() => indexDb.migrate(baseSchema)).toThrow(
      /Migration table _mubo_migrations conflicts with an existing index on table legacy/,
    );
    expect(
      indexDb.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get(),
    ).toBeNull();
    indexDb.close();
  });

  test("reports migration SQL failures and rolls back the plan", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const invalid = defineSchema({
      tables: {
        broken: {
          columns: {
            id: { type: "text", primaryKey: true, sqlDefault: "(" },
          },
        },
      },
    });

    let caught: unknown;
    try {
      await db.migrate(invalid);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MuboError);
    const failure = caught as MuboError;
    expect(failure.code).toBe("MIGRATION_ERROR");
    expect(failure.message).toContain("Failed to apply migration statement");
    expect(failure.details).toMatchObject({ statement: expect.stringContaining('CREATE TABLE "broken"') });
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'broken'").get(),
    ).toBeNull();
    const history = db
      .query<{ count: number }>("SELECT COUNT(*) AS count FROM _mubo_migrations")
      .get();
    expect(history?.count).toBe(0);
    db.close();
  });

  test("check mode does not create migration metadata", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const checked = await db.migrate(baseSchema, { mode: "check" });
    expect(checked.status).toBe("pending");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_mubo_migrations'").get(),
    ).toBeNull();
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get(),
    ).toBeNull();
    db.close();
  });

  test("check mode reports pending migrations without applying them", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    await db.migrate(baseSchema);
    const next = defineSchema({
      tables: {
        ...baseSchema.tables,
        audit: { columns: { id: { type: "text", primaryKey: true } } },
      },
    });
    const checked = await db.migrate(next, { mode: "check" });
    expect(checked.status).toBe("pending");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit'").get(),
    ).toBeNull();
    expect((await db.migrate(next)).status).toBe("applied");
    db.close();
  });

  test("rejects applying migrations while another transaction is active", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = db.transaction(async () => {
      await gate;
      return "active";
    });

    expect(() => db.migrate(baseSchema)).toThrow(/another transaction is active/);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get(),
    ).toBeNull();
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_mubo_migrations'").get(),
    ).toBeNull();

    release();
    expect(await active).toBe("active");
    db.close();
  });

  test("refuses unsafe NOT NULL additions and rolls back transactions", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    await db.migrate(baseSchema);
    const unsafe = defineSchema({
      tables: {
        ...baseSchema.tables,
        users: {
          columns: {
            ...baseSchema.tables.users.columns,
            required: { type: "text", notNull: true },
          },
        },
      },
    });
    expect(() => db.migrate(unsafe)).toThrow(/NOT NULL/);

    expect(() =>
      db.transaction(() => {
        db.query("INSERT INTO users (email, name, created_at) VALUES (?, ?, ?)").run("tx@example.com", "Tx", 1);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(db.query("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 0 });

    const syncResult = db.transaction(() => {
      db.query("INSERT INTO users (email, name, created_at) VALUES (?, ?, ?)").run("ok@example.com", "Ok", 2);
      return "committed";
    });
    expect(syncResult).toBe("committed");
    expect(db.query("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });

    await db.transaction(async () => {
      db.query("INSERT INTO users (email, name, created_at) VALUES (?, ?, ?)").run("async@example.com", "Async", 3);
    });
    expect(db.query("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 2 });
    db.close();
  });

  test("serializes concurrent async transactions and isolates nested rollbacks", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE events (value INTEGER NOT NULL)");

    const failing = db.transaction(async () => {
      db.query("INSERT INTO events (value) VALUES (?)").run(1);
      await Bun.sleep(20);
      throw new Error("first transaction failed");
    });
    const succeeding = db.transaction(async () => {
      db.query("INSERT INTO events (value) VALUES (?)").run(2);
      await Bun.sleep(5);
      return "committed";
    });

    await expect(failing).rejects.toThrow("first transaction failed");
    expect(await succeeding).toBe("committed");
    expect(db.query("SELECT value FROM events ORDER BY value").all()).toEqual([{ value: 2 }]);

    const result = db.transaction((tx) => {
      tx.query("INSERT INTO events (value) VALUES (?)").run(3);
      expect(() =>
        tx.transaction(() => {
          tx.query("INSERT INTO events (value) VALUES (?)").run(4);
          throw new Error("nested transaction failed");
        }),
      ).toThrow("nested transaction failed");
      tx.query("INSERT INTO events (value) VALUES (?)").run(5);
      return "outer committed";
    });
    expect(result).toBe("outer committed");
    expect(db.query("SELECT value FROM events ORDER BY value").all()).toEqual([{ value: 2 }, { value: 3 }, { value: 5 }]);
    db.close();
  });

  test("rejects queued transactions when the database closes", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE events (value INTEGER NOT NULL)");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = db.transaction(async () => {
      await gate;
      return "active";
    });
    const queued = db.transaction(() => "queued");

    db.close();
    await expect(queued).rejects.toThrow(/Database is closed/);
    release();
    await expect(active).rejects.toThrow();
  });

  test("isolates concurrent sibling nested transactions", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE events (value INTEGER NOT NULL)");

    await db.transaction(async (tx) => {
      const results = await Promise.allSettled([
        tx.transaction(async (inner) => {
          inner.query("INSERT INTO events (value) VALUES (?)").run(1);
          await Bun.sleep(20);
          throw new Error("sibling failed");
        }),
        tx.transaction(async (inner) => {
          inner.query("INSERT INTO events (value) VALUES (?)").run(2);
          await Bun.sleep(5);
          return "committed";
        }),
      ]);

      expect(results[0]?.status).toBe("rejected");
      expect(results[1]?.status).toBe("fulfilled");
    });

    expect(db.query("SELECT value FROM events ORDER BY value").all()).toEqual([{ value: 2 }]);
    db.close();
  });

  test("cancels pending nested work when a parent transaction exits early", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE events (value INTEGER NOT NULL)");
    let firstError: unknown;
    let secondError: unknown;
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;

    await expect(
      db.transaction(async (tx) => {
        first = tx.transaction(async (inner) => {
          await Bun.sleep(20);
          inner.query("INSERT INTO events (value) VALUES (?)").run(1);
          return "first";
        }) as Promise<unknown>;
        second = tx.transaction(async (inner) => {
          inner.query("INSERT INTO events (value) VALUES (?)").run(2);
          return "second";
        }) as Promise<unknown>;
        first.catch((error) => {
          firstError = error;
        });
        second.catch((error) => {
          secondError = error;
        });
        await Bun.sleep(1);
        throw new Error("parent failed");
      }),
    ).rejects.toThrow("parent failed");

    await Promise.allSettled([first, second]);
    expect(firstError).toBeInstanceOf(MuboError);
    expect((firstError as Error).message).toBe("Transaction is no longer active");
    expect(secondError).toBeInstanceOf(MuboError);
    expect((secondError as Error).message).toMatch(/cancelled/);
    expect(db.query("SELECT value FROM events").all()).toEqual([]);
    db.close();
  });

  test("plans unsafe column additions when safeOnly is disabled", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    await db.migrate(
      defineSchema({
        tables: { settings: { columns: { id: { type: "integer", primaryKey: true } } } },
      }),
    );

    const notNullColumn = defineSchema({
      tables: {
        settings: {
          columns: {
            id: { type: "integer", primaryKey: true },
            note: { type: "text", notNull: true },
          },
        },
      },
    });
    expect(() => db.plan(notNullColumn)).toThrow(/without a default value/);
    const notNullPlan = db.plan(notNullColumn, { safeOnly: false });
    expect(notNullPlan.changes).toEqual(["add column settings.note"]);
    expect(notNullPlan.statements[0]).toContain("ADD COLUMN");

    const applied = await db.migrate(notNullColumn, { safeOnly: false });
    expect(applied.status).toBe("applied");
    expect(
      db.query<{ name: string }>("PRAGMA table_info(settings)").all().map((column) => column.name),
    ).toContain("note");

    db.exec("INSERT INTO settings (id, note) VALUES (1, 'first')");
    const secondNotNullColumn = defineSchema({
      tables: {
        settings: {
          columns: {
            id: { type: "integer", primaryKey: true },
            note: { type: "text", notNull: true },
            label: { type: "text", notNull: true },
          },
        },
      },
    });
    expect(db.plan(secondNotNullColumn, { safeOnly: false }).changes).toEqual([
      "add column settings.label",
    ]);
    await expect(db.migrate(secondNotNullColumn, { safeOnly: false })).rejects.toThrow(
      /Failed to apply migration statement/,
    );
    expect(
      db.query<{ name: string }>("PRAGMA table_info(settings)").all().map((column) => column.name),
    ).not.toContain("label");

    const expressionDefault = defineSchema({
      tables: {
        settings: {
          columns: {
            id: { type: "integer", primaryKey: true },
            note: { type: "text", notNull: true },
            created: { type: "text", sqlDefault: "(lower('X'))" },
          },
        },
      },
    });
    expect(() => db.plan(expressionDefault)).toThrow(/non-constant default/);
    const expressionPlan = db.plan(expressionDefault, { safeOnly: false });
    expect(expressionPlan.changes).toEqual(["add column settings.created"]);
    await expect(db.migrate(expressionDefault, { safeOnly: false })).rejects.toThrow(
      /Failed to apply migration statement/,
    );
    expect(db.query("SELECT id FROM settings").all()).toEqual([{ id: 1 }]);
    db.close();
  });

  test("reports failures raised by queued nested transactions", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE events (value INTEGER NOT NULL)");

    await db.transaction(async (tx) => {
      const first = tx.transaction(async (inner) => {
        inner.query("INSERT INTO events (value) VALUES (?)").run(1);
        await Bun.sleep(20);
        return "first";
      }) as Promise<unknown>;
      const queued = tx.transaction(async (inner) => {
        inner.query("INSERT INTO events (value) VALUES (?)").run(2);
        throw new Error("queued nested failed");
      }) as Promise<unknown>;

      await expect(queued).rejects.toThrow("queued nested failed");
      await expect(first).resolves.toBe("first");
    });

    expect(db.query("SELECT value FROM events").all()).toEqual([{ value: 1 }]);
    db.close();
  });

  test("resolves queued nested transactions that finish synchronously", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE events (value INTEGER NOT NULL)");

    await db.transaction(async (tx) => {
      const first = tx.transaction(async (inner) => {
        await Bun.sleep(10);
        return "first";
      }) as Promise<unknown>;
      const queued = tx.transaction((inner) => {
        inner.query("INSERT INTO events (value) VALUES (?)").run(1);
        return "queued";
      }) as Promise<unknown>;

      await expect(queued).resolves.toBe("queued");
      await expect(first).resolves.toBe("first");
    });

    expect(db.query("SELECT value FROM events").all()).toEqual([{ value: 1 }]);
    db.close();
  });

  test("propagates failures from queued top-level transactions", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = db.transaction(async () => {
      await gate;
      return "first";
    });
    const queuedSync = db.transaction(() => {
      throw new Error("queued sync failed");
    });
    const queuedAsync = db.transaction(async () => {
      throw new Error("queued async failed");
    });
    const outcomes = Promise.allSettled([first, queuedSync, queuedAsync]);

    release();
    const results = await outcomes;
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    expect(results[2]?.status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toEqual(
      new Error("queued sync failed"),
    );
    expect((results[2] as PromiseRejectedResult).reason).toEqual(
      new Error("queued async failed"),
    );
    expect(db.transactionBusy).toBe(false);
    db.close();
  });

  test("reports whether the database is still open", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    expect(db.isOpen).toBe(true);
    db.close();
    expect(db.isOpen).toBe(false);
  });

  test("reports a database path that cannot be opened", () => {
    const dir = tempDir();
    expect(() => new MuboDatabase({ path: dir })).toThrow(/Cannot open SQLite database/);
    expect(() => new MuboDatabase({ path: dir })).toThrow(/CONFIG_ERROR|Cannot open SQLite database/);
  });

  test("plan() passes through safeOnly and other migration options", async () => {    const db = new MuboDatabase({ path: ":memory:" });

    await db.migrate(
      defineSchema({
        tables: {
          settings: {
            columns: { id: { type: "integer", primaryKey: true }, note: { type: "text" } },
          },
        },
      }),
    );

    const withNotNull = defineSchema({
      tables: {
        settings: {
          columns: { id: { type: "integer", primaryKey: true }, note: { type: "text", notNull: true } },
        },
      },
    });

    expect(() => db.plan(withNotNull, { safeOnly: true })).toThrow(/safeOnly is enabled/);
    expect(() => db.plan(withNotNull, { safeOnly: false })).toThrow(/automatic destructive migrations/);

    const unchanged = defineSchema({
      tables: {
        settings: {
          columns: { id: { type: "integer", primaryKey: true }, note: { type: "text" } },
        },
      },
    });
    expect(db.plan(unchanged, { safeOnly: false })).toMatchObject({
      id: null,
      statements: [],
      changes: [],
    });

    const offResult = await db.migrate(unchanged, { mode: "off" });
    expect(offResult.status).toBe("off");

    db.close();
  });

  test("reclaims migration file locks left behind by dead processes", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "._mubo_migrations.lock");
    const dead = Bun.spawn(["bun", "-e", "process.exit(0)"]);
    await dead.exited;
    writeFileSync(lockPath, `${dead.pid}\n${Date.now()}`);

    const acquired = await acquireFileLock(join(dir, "app.sqlite"), "_mubo_migrations", {
      attempts: 3,
      delayMs: 5,
    });
    expect(acquired).toBe(lockPath);
    expect(readFileSync(lockPath, "utf8").startsWith(`${process.pid}\n`)).toBe(true);
    releaseFileLock(acquired);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("reclaims migration file locks that expired", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "._mubo_migrations.lock");
    writeFileSync(lockPath, `${process.pid}\n${Date.now() - 60 * 60 * 1000}`);

    const acquired = await acquireFileLock(join(dir, "app.sqlite"), "_mubo_migrations", {
      attempts: 3,
      delayMs: 5,
    });
    expect(acquired).toBe(lockPath);
    releaseFileLock(acquired);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("keeps migration file locks held by live processes", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "._mubo_migrations.lock");
    const owner = `${process.pid}\n${Date.now()}`;
    writeFileSync(lockPath, owner);

    await expect(
      acquireFileLock(join(dir, "app.sqlite"), "_mubo_migrations", { attempts: 2, delayMs: 5 }),
    ).rejects.toThrow(/Could not acquire file lock/);
    expect(readFileSync(lockPath, "utf8")).toBe(owner);
  });

  test("does not release a migration file lock owned by another process", async () => {
    const dir = tempDir();
    const lockPath = join(dir, "._mubo_migrations.lock");
    writeFileSync(lockPath, `${process.pid + 1_000_000}\n${Date.now()}`);

    releaseFileLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("applies migrations with the file lock while a stale lock exists", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "app.sqlite");
    const lockPath = join(dir, "._mubo_migrations.lock");
    const dead = Bun.spawn(["bun", "-e", "process.exit(0)"]);
    await dead.exited;
    writeFileSync(lockPath, `${dead.pid}\n${Date.now()}`);

    const db = new MuboDatabase({ path: dbPath, dataDir: dir });
    const result = await db.migrate(baseSchema, { mode: "apply", lock: "file" });
    expect(result.status).toBe("applied");
    expect(existsSync(lockPath)).toBe(false);
    db.close();
  });

  test("uses database-level migration defaults for plan and migrate", async () => {
    const db = new MuboDatabase({
      path: ":memory:",
      migrations: { table: "custom_history", mode: "apply", safeOnly: true },
    });

    const result = await db.migrate(baseSchema);
    expect(result.status).toBe("applied");

    const tables = db
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).toContain("custom_history");
    expect(tables).not.toContain("_mubo_migrations");
    expect(db.query<{ total: number }>("SELECT COUNT(*) AS total FROM custom_history").get()?.total).toBe(1);

    const second = await db.migrate(baseSchema);
    expect(second.status).toBe("none");
    expect(db.query<{ total: number }>("SELECT COUNT(*) AS total FROM custom_history").get()?.total).toBe(1);
    db.close();
  });

  test("keeps database-level migration defaults overridable per call", async () => {
    const db = new MuboDatabase({
      path: ":memory:",
      migrations: { table: "custom_history", mode: "apply", safeOnly: true },
    });

    const result = await db.migrate(baseSchema, { table: "other_history" });
    expect(result.status).toBe("applied");

    const tables = db
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).toContain("other_history");
    expect(tables).not.toContain("custom_history");
    db.close();
  });

  test("honors a check-only migration mode stored on the database", async () => {
    const db = new MuboDatabase({
      path: ":memory:",
      migrations: { mode: "check", table: "custom_history" },
    });

    const result = await db.migrate(baseSchema);
    expect(result.status).toBe("pending");
    expect(result.changes.length).toBeGreaterThan(0);

    const tables = db
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).not.toContain("custom_history");
    db.close();
  });
});

describe("application database wiring", () => {
  test("app.db.migrate() records history in the configured migrations table", async () => {
    const app = await createMuboApp(
      {
        app: { name: "migration-table-test", env: "test" },
        db: {
          path: ":memory:",
          migrations: { mode: "apply", safeOnly: true, table: "custom_history" },
        },
        log: { level: "error" },
        static: { mode: "off" },
        schema: baseSchema,
      },
      { argv: [] },
    );
    await app.start();

    const tables = app.db
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).toContain("custom_history");
    expect(tables).not.toContain("_mubo_migrations");

    const result = await app.db.migrate({
      tables: { tags: { columns: { id: { type: "integer", primaryKey: true, autoIncrement: true } } } },
    });
    expect(result.status).toBe("applied");

    const after = app.db
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(after).toContain("tags");
    expect(after).not.toContain("_mubo_migrations");
    expect(app.db.query<{ total: number }>("SELECT COUNT(*) AS total FROM custom_history").get()?.total).toBe(2);

    await app.stop();
  });

  test("app.db.migrate() honors the configured check-only migration mode", async () => {
    const app = await createMuboApp(
      {
        app: { name: "migration-mode-test", env: "test" },
        db: { path: ":memory:", migrations: { mode: "check", table: "custom_history" } },
        log: { level: "error" },
        static: { mode: "off" },
        schema: baseSchema,
      },
      { argv: [] },
    );

    await expect(app.start()).rejects.toThrow(/MIGRATION_REQUIRED|Database migrations are pending/);
    const result = await app.db.migrate(baseSchema);
    expect(result.status).toBe("pending");

    await app.stop();
  });
});
