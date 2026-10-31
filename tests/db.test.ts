import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuboDatabase } from "../src/db/database.ts";
import { defineSchema } from "../src/db/schema.ts";
import { MuboError } from "../src/core/errors.ts";
import { createLogger } from "../src/core/logger.ts";

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

    const second = db.migrate(baseSchema);
    expect(second.status).toBe("none");
    expect(db.ping()).toBe(true);
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
    expect(() => db.migrate(unsafeUnique)).toThrow(/UNIQUE column/);
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

    expect(() =>
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
    ).toThrow(/UNIQUE constraint change/);

    expect(() =>
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
    ).toThrow(/different definition/);

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

  test("accepts common parameterized column types", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const result = db.migrate(
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
    db.close();
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

  test("rejects invalid database options before opening SQLite", () => {
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
    expect(() => new MuboDatabase({ path: ":memory:", slowQueryMs: -1 })).toThrow(
      /Invalid slow query threshold/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", slowQueryMs: Number.POSITIVE_INFINITY })).toThrow(
      /Invalid slow query threshold/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", slowQueryMs: 1.5 })).toThrow(
      /Invalid slow query threshold/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", wal: "yes" as never })).toThrow(
      /Invalid database WAL setting/,
    );
    expect(() => new MuboDatabase({ path: ":memory:", foreignKeys: 1 as never })).toThrow(
      /Invalid database foreign keys setting/,
    );
  });

  test("rejects invalid migration options when called directly", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const schema = defineSchema({
      tables: { notes: { columns: { id: { type: "integer", primaryKey: true } } } },
    });

    expect(() => db.migrate(schema, { mode: "sometimes" as never })).toThrow(
      /Invalid migration mode/,
    );
    expect(() => db.migrate(schema, { safeOnly: "yes" as never })).toThrow(
      /Invalid safeOnly migration setting/,
    );
    expect(() => db.migrate(schema, { table: "bad-name" })).toThrow(/Invalid SQL identifier/);
    expect(() => db.plan(schema, { table: "bad-name" })).toThrow(/Invalid SQL identifier/);
    expect((db.migrate(schema, { mode: "off" })).status).toBe("off");
    db.close();
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
      db.migrate(invalid);
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
});
