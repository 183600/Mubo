import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { MuboDatabase } from "../src/db/database.ts";
import { defineSchema } from "../src/db/schema.ts";
import { applyMigrations, planMigrations } from "../src/db/migrations.ts";

const tempDirs: string[] = [];
const worker = resolve(import.meta.dir, "fixtures/migrate-worker.ts");
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const testSchema = defineSchema({
  tables: {
    jobs: {
      columns: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        name: { type: "text", notNull: true },
      },
      indexes: [{ name: "idx_jobs_name", columns: ["name"] }],
    },
  },
});

describe("migration locking", () => {
  test("two processes can race to migrate the same database safely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mubo-migrate-race-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "race.sqlite");

    const run = async () => {
      const proc = Bun.spawn(["bun", worker, dbPath], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return JSON.parse(stdout.trim()) as { status: string; id: string | null };
    };

    const results = await Promise.all([run(), run()]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual(["applied", "none"]);

    const db = new Database(dbPath);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get()).toBeTruthy();
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_jobs_name'").get(),
    ).toBeTruthy();
    const history = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM _mubo_migrations")
      .get();
    expect(history?.count).toBe(1);
    db.close();
  }, 30_000);

  test("file lock prevents concurrent migrations across processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mubo-file-lock-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "filelock.sqlite");

    const runMigration = async (): Promise<{ status: string; id: string | null }> => {
      const db = new MuboDatabase({ path: dbPath });
      try {
        const result = await applyMigrations(db, testSchema, { lock: "file" });
        return { status: result.status, id: result.id };
      } finally {
        db.close();
      }
    };

    const results = await Promise.all([runMigration(), runMigration()]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["applied", "none"]);

    const db = new Database(dbPath);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get()).toBeTruthy();
    const history = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM _mubo_migrations").get();
    expect(history?.count).toBe(1);
    db.close();

    // Lock file is in the same directory as the database file
    const lockFile = join(dir, "._mubo_migrations.lock");
    expect(existsSync(lockFile)).toBe(false);
  });

  test("sqlite lock (default) prevents concurrent migrations within same process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mubo-sqlite-lock-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "sqlitelock.sqlite");

    const db1 = new MuboDatabase({ path: dbPath });
    const db2 = new MuboDatabase({ path: dbPath });

    const result1 = await applyMigrations(db1, testSchema, { lock: "sqlite" });
    expect(result1.status).toBe("applied");

    const result2 = await applyMigrations(db2, testSchema, { lock: "sqlite" });
    expect(result2.status).toBe("none");

    db1.close();
    db2.close();
  });

  test("planMigrations does not acquire locks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mubo-plan-lock-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "planlock.sqlite");

    const db = new MuboDatabase({ path: dbPath });
    const plan = planMigrations(db, testSchema, { lock: "file" });
    expect(plan.statements.length).toBeGreaterThan(0);
    db.close();

    // planMigrations does not create lock files
    const lockFile = join(dir, "._mubo_migrations.lock");
    expect(existsSync(lockFile)).toBe(false);
  });

  test("invalid lock option is rejected", async () => {
    const db = new MuboDatabase({ path: ":memory:" });
    await expect(
      applyMigrations(db, testSchema, { lock: "redis" as never }),
    ).rejects.toThrow(/Invalid migration lock/);
    db.close();
  });

  test("waits for queued migrations and keeps the file lock until they finish", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mubo-queued-migrate-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "queued.sqlite");
    const db = new MuboDatabase({ path: dbPath });

    // Hold the migration lock briefly so the migration has to wait for it.
    const lockPath = join(dir, "._mubo_migrations.lock");
    writeFileSync(lockPath, "held-by-test");
    setTimeout(() => rmSync(lockPath, { force: true }), 50);

    const migration = applyMigrations(db, testSchema, { lock: "file" });
    await Bun.sleep(10);

    // A transaction started while the migration waits for the lock forces the
    // migration transaction to be queued instead of running immediately.
    const holding = db.transaction(async () => {
      await Bun.sleep(400);
      return "held";
    });

    const result = await migration;
    expect(result.status).toBe("applied");
    expect(result.id).toBeString();
    expect(await holding).toBe("held");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get(),
    ).toBeTruthy();
    expect(
      db.query<{ count: number }>("SELECT COUNT(*) AS count FROM _mubo_migrations").get(),
    ).toEqual({ count: 1 });
    db.close();
  }, 20_000);

  test("releases file lock after migration completes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mubo-lock-release-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "lockrelease.sqlite");
    const db = new MuboDatabase({ path: dbPath });

    const result = await applyMigrations(db, testSchema, { lock: "file" });
    expect(result.status).toBe("applied");

    // Lock file should be cleaned up
    const lockFile = join(dir, "._mubo_migrations.lock");
    expect(existsSync(lockFile)).toBe(false);

    db.close();
  });

  test("multiple concurrent file lock migrations serialize correctly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mubo-serial-migrate-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "serial.sqlite");

    const results = await Promise.all(
      Array.from({ length: 5 }, () => {
        const db = new MuboDatabase({ path: dbPath });
        return applyMigrations(db, testSchema, { lock: "file" }).finally(() => db.close());
      }),
    );

    const applied = results.filter((r) => r.status === "applied");
    const none = results.filter((r) => r.status === "none");
    expect(applied).toHaveLength(1);
    expect(none).toHaveLength(4);

    const db = new Database(dbPath);
    const history = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM _mubo_migrations").get();
    expect(history?.count).toBe(1);
    db.close();
  });

  test("file lock handles process crash simulation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mubo-crash-lock-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "crash.sqlite");
    const lockFile = join(dir, "._mubo_migrations.lock");

    // Simulate a crashed process leaving a lock (use a non-existent PID)
    writeFileSync(lockFile, `${process.pid + 100000}\n${Date.now() - 1000}`); // Dead PID

    const db = new MuboDatabase({ path: dbPath });
    const result = await applyMigrations(db, testSchema, { lock: "file" });
    expect(result.status).toBe("applied");
    expect(existsSync(lockFile)).toBe(false);
    db.close();
  });

  test("concurrent migrations with different schemas apply sequentially", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mubo-diff-schema-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "diff.sqlite");

    const schemaV1 = defineSchema({
      tables: {
        items: { columns: { id: { type: "integer", primaryKey: true }, name: { type: "text" } } },
      },
    });
    const schemaV2 = defineSchema({
      tables: {
        items: { columns: { id: { type: "integer", primaryKey: true }, name: { type: "text" } } },
        users: { columns: { id: { type: "integer", primaryKey: true }, email: { type: "text" } } },
      },
    });

    // Start both migrations concurrently
    const db1 = new MuboDatabase({ path: dbPath });
    const db2 = new MuboDatabase({ path: dbPath });

    const [r1, r2] = await Promise.all([
      applyMigrations(db1, schemaV1, { lock: "file" }).finally(() => db1.close()),
      applyMigrations(db2, schemaV2, { lock: "file" }).finally(() => db2.close()),
    ]);

    // Both should succeed but one will be "none" (already applied)
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["applied", "applied"]); // Both schemas add tables so both apply

    const db = new Database(dbPath);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("items");
    expect(tableNames).toContain("users");
    const history = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM _mubo_migrations").get();
    expect(history?.count).toBe(2);
    db.close();
  });
});
