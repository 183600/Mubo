import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuboDatabase } from "../src/db/database.ts";
import { defineSchema } from "../src/db/schema.ts";

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
});
