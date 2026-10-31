import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const tempDirs: string[] = [];
const worker = resolve(import.meta.dir, "fixtures/migrate-worker.ts");
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
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
});
