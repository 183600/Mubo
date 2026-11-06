import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuboDatabase } from "../src/db/database.ts";
import { acquireFileLock, releaseFileLock } from "../src/db/migrations.ts";
import { defineSchema } from "../src/db/schema.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mubo-schema-"));
  tempDirs.push(dir);
  return dir;
}

describe("schema validation edge cases", () => {
  test("rejects non-finite numeric defaults", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const schema = defineSchema({
      tables: { items: { columns: { id: { type: "text", default: Number.POSITIVE_INFINITY } } } },
    });
    expect(() => db.plan(schema)).toThrow(/Invalid numeric default/);
    db.close();
  });

  test("rejects malformed references", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const cases = [
      {
        columns: { parent_id: { type: "text", references: 42 as never } },
        message: /Invalid references for items\.parent_id/,
      },
      {
        columns: { parent_id: { type: "text", references: { table: 42 } as never } },
        message: /Invalid references for items\.parent_id/,
      },
      {
        columns: {
          parent_id: { type: "text", references: { table: "p", column: 42 } as never },
        },
        message: /Invalid references for items\.parent_id/,
      },
      {
        columns: {
          parent_id: { type: "text", references: { table: "p", onUpdate: "BOGUS" } as never },
        },
        message: /Invalid ON UPDATE action for items\.parent_id/,
      },
    ];
    for (const item of cases) {
      const schema = defineSchema({ tables: { items: { columns: item.columns } } });
      expect(() => db.plan(schema)).toThrow(item.message);
    }
    db.close();
  });

  test("rejects index collections that are not arrays", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const schema = defineSchema({
      tables: {
        items: {
          columns: { id: { type: "text" } },
          indexes: "nope" as never,
        },
      },
    });
    expect(() => db.plan(schema)).toThrow(/Indexes for items must be an array/);
    db.close();
  });

  test("rejects malformed index definitions", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const cases = [
      {
        indexes: [42 as never],
        message: /Invalid index definition on items/,
      },
      {
        indexes: [{ name: 42, columns: ["id"] } as never],
        message: /Invalid SQL identifier: 42/,
      },
      {
        indexes: [{ name: "idx_items", columns: ["id"], unique: "yes" } as never],
        message: /Invalid unique setting for index idx_items/,
      },
      {
        indexes: [{ name: "idx_items", columns: [42] } as never],
        message: /Invalid SQL identifier: 42/,
      },
    ];
    for (const item of cases) {
      const schema = defineSchema({
        tables: { items: { columns: { id: { type: "text" } }, indexes: item.indexes } },
      });
      expect(() => db.plan(schema)).toThrow(item.message);
    }
    db.close();
  });

  test("rejects the same index name used twice on one table", () => {
    const db = new MuboDatabase({ path: ":memory:" });
    const schema = defineSchema({
      tables: {
        items: {
          columns: { id: { type: "text" } },
          indexes: [
            { name: "dup_idx", columns: ["id"] },
            { name: "dup_idx", columns: ["id"] },
          ],
        },
      },
    });
    expect(() => db.plan(schema)).toThrow(
      /Index name dup_idx is defined more than once on table items/,
    );
    db.close();
  });

  test("detects auto-increment while ignoring keywords in comments, strings and brackets", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec(`CREATE TABLE tricky (
      -- AUTOINCREMENT inside a comment
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "note" TEXT DEFAULT 'AUTOINCREMENT not real',
      [bracket_col] TEXT /* AUTOINCREMENT here too */
    )`);
    // The declared auto-increment primary key matches; the keywords hidden in
    // the comment, the string literal and the bracket identifier must not
    // confuse the detection either way.
    const schema = defineSchema({
      tables: {
        tricky: {
          columns: {
            id: { type: "integer", primaryKey: true, autoIncrement: true },
            note: { type: "text", default: "AUTOINCREMENT not real" },
            bracket_col: { type: "text" },
          },
        },
      },
    });
    const plan = db.plan(schema);
    expect(plan.statements).toEqual([]);
    db.close();
  });

  test("allows constant hex and blob defaults on added columns", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
    db.query("INSERT INTO items (id) VALUES (1)").run(1);
    const schema = defineSchema({
      tables: {
        items: {
          columns: {
            id: { type: "integer", primaryKey: true },
            blob_default: { type: "blob", sqlDefault: "x'7F'" },
            hex_default: { type: "integer", sqlDefault: "0x1F" },
          },
        },
      },
    });
    const result = await db.migrate(schema, { safeOnly: true });
    expect(result.status).toBe("applied");
    const row = db
      .query<{ blob_default: Uint8Array | null; hex_default: number | null }>(
        "SELECT blob_default, hex_default FROM items WHERE id = 1",
      )
      .get();
    expect(row?.hex_default).toBe(31);
    expect(new Uint8Array(row?.blob_default ?? new Uint8Array())[0]).toBe(0x7f);
    db.close();
  });

  test("rejects removing a foreign key from an existing column", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    db.exec(
      "CREATE TABLE parents (id INTEGER PRIMARY KEY); " +
        "CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id))",
    );
    const schema = defineSchema({
      tables: {
        parents: { columns: { id: { type: "integer", primaryKey: true } } },
        children: {
          columns: {
            id: { type: "integer", primaryKey: true },
            parent_id: { type: "integer" },
          },
        },
      },
    });
    expect(() => db.plan(schema)).toThrow(
      /Foreign-key change for children\.parent_id requires a manual migration/,
    );
    db.close();
  });

  test("treats malformed lock files as locked until the stale threshold", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "app.sqlite");
    const lockPath = join(dir, "._mubo_migrations.lock");
    // No readable pid: the mtime decides whether the lock is stale, and a
    // freshly written malformed lock is therefore still held.
    writeFileSync(lockPath, "not a pid at all");
    await expect(
      acquireFileLock(dbPath, "_mubo_migrations", { attempts: 1, delayMs: 0 }),
    ).rejects.toThrow(/Could not acquire file lock/);
    // A release attempt from this process removes the malformed lock since no
    // live foreign owner can be identified.
    releaseFileLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("reclaims a file lock whose timestamp is older than the stale threshold", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "app.sqlite");
    const lockPath = join(dir, "._mubo_migrations.lock");
    // A lock left by another pid but older than the stale threshold is
    // reclaimed so a new migration can proceed.
    const staleAt = Date.now() - 20 * 60 * 1000; // 20 minutes ago
    writeFileSync(lockPath, `${999999}\n${staleAt}`);
    const acquired = await acquireFileLock(dbPath, "_mubo_migrations", {
      attempts: 3,
      delayMs: 0,
    });
    expect(existsSync(acquired)).toBe(true);
    // The reclaimed lock now belongs to this process and is released cleanly.
    releaseFileLock(acquired);
    expect(existsSync(lockPath)).toBe(false);
  });
});

tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
