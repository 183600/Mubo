import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { buildProject } from "../src/cli/build.ts";

const tempDirs: string[] = [];
const framework = resolve(import.meta.dir, "../src/index.ts").split(sep).join("/");
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mubo-build-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

async function waitFor(url: string, timeoutMs = 10_000): Promise<Response> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await Bun.sleep(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Server did not start");
}

describe("single-file build", () => {
  test(
    "compiles an app with embedded assets and runs it with a data directory",
    async () => {
      const cwd = tempDir();
      mkdirSync(join(cwd, "src", "server"), { recursive: true });
      mkdirSync(join(cwd, "public"), { recursive: true });
      writeFileSync(join(cwd, "public", "index.html"), "<h1>single file</h1>");
      writeFileSync(
        join(cwd, "src", "server", "index.ts"),
        `import { createMuboApp, defineSchema } from ${JSON.stringify(framework)};

const app = await createMuboApp({
  app: { name: "single-file-test", env: "test" },
  http: { port: 0 },
  db: {},
  static: { mode: "embedded", dir: "public", spaFallback: true },
  log: { level: "error" },
  schema: defineSchema({
    tables: {
      items: {
        columns: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          name: { type: "text", notNull: true },
        },
      },
    },
  }),
});

app.get("/api/ping", (ctx) => ctx.json({ ok: true, file: "single" }));

const shutdown = async () => {
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await app.start();
`,
      );

      const result = await buildProject({ cwd, staticDir: "public", outfile: "dist/single-test" });
      expect(existsSync(result.outfile)).toBe(true);
      expect(result.assets).toBe(1);

      const dataDir = join(cwd, "data");
      const port = await freePort();
      const proc = Bun.spawn([result.outfile], {
        cwd,
        env: {
          ...process.env,
          MUBO_PORT: String(port),
          MUBO_HOST: "127.0.0.1",
          MUBO_DATA_DIR: dataDir,
          MUBO_LOG_LEVEL: "error",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const base = `http://127.0.0.1:${port}`;
        const health = await waitFor(`${base}/healthz`);
        expect(health.status).toBe(200);
        expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

        const api = await fetch(`${base}/api/ping`);
        expect(await api.json()).toEqual({ ok: true, file: "single" });

        const index = await fetch(`${base}/`);
        expect(await index.text()).toContain("single file");
        const spa = await fetch(`${base}/some/client/route`);
        expect(await spa.text()).toContain("single file");

        const dbPath = join(dataDir, "mubo.sqlite");
        expect(existsSync(dbPath)).toBe(true);
        const db = new Database(dbPath);
        expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='items'").get()).toBeTruthy();
        db.close();
      } finally {
        proc.kill("SIGTERM");
        await proc.exited;
      }
    },
    60_000,
  );
});
