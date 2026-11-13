import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { buildProject, resolveBuildOutfile } from "../src/cli/build.ts";
import { EMBEDDED_ASSETS_KEY } from "../src/static/assets.ts";

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
  test("appends the executable suffix for Windows targets", () => {
    const cwd = tempDir();
    expect(resolveBuildOutfile(cwd, {}, "my-app")).toBe(join(cwd, "dist", "my-app"));
    expect(resolveBuildOutfile(cwd, { outfile: "dist/custom" }, "my-app")).toBe(
      join(cwd, "dist", "custom"),
    );
    expect(resolveBuildOutfile(cwd, { target: "bun-windows-x64" }, "my-app")).toBe(
      join(cwd, "dist", "my-app.exe"),
    );
    expect(resolveBuildOutfile(cwd, { target: "bun-windows-x64", outfile: "dist/custom.exe" })).toBe(
      join(cwd, "dist", "custom.exe"),
    );
    expect(resolveBuildOutfile(cwd, { platform: "win32" }, "my-app")).toBe(
      join(cwd, "dist", "my-app.exe"),
    );
    expect(resolveBuildOutfile(cwd, { target: "bun-linux-x64", platform: "win32" }, "my-app")).toBe(
      join(cwd, "dist", "my-app"),
    );
  });

  test("rejects entry and static paths with the wrong file type", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "entry-dir"));
    writeFileSync(join(cwd, "not-a-dir"), "file");

    await expect(buildProject({ cwd, entry: "entry-dir" })).rejects.toThrow(/Cannot find app entry/);

    writeFileSync(join(cwd, "index.ts"), "");
    await expect(buildProject({ cwd, entry: "index.ts", staticDir: "not-a-dir" })).rejects.toThrow(
      /Static directory not found/,
    );

    mkdirSync(join(cwd, "dist", "app"), { recursive: true });
    await expect(buildProject({ cwd, entry: "index.ts", outfile: "dist/app" })).rejects.toThrow(
      /Output path is a directory/,
    );

    writeFileSync(join(cwd, "occupied"), "file");
    await expect(buildProject({ cwd, entry: "index.ts", outfile: "occupied/app" })).rejects.toThrow(
      /Output directory is not a directory/,
    );
  });

  test("rejects an output path that would overwrite the entry", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "index.ts"), "console.log('entry');\n");

    await expect(buildProject({ cwd, entry: "index.ts", outfile: "index.ts" })).rejects.toThrow(
      /Output path must not overwrite the entry/,
    );
    expect(readFileSync(join(cwd, "index.ts"), "utf8")).toBe("console.log('entry');\n");
  });

  test("rejects a configured static directory that does not exist", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "index.ts"), "");
    writeFileSync(join(cwd, "mubo.config.ts"), `export default { static: { dir: "assets" } };\n`);

    await expect(buildProject({ cwd, entry: "index.ts" })).rejects.toThrow(
      /Static directory not found/,
    );
  });

  test("uses dist/client when an equivalent configured public directory is missing", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "index.ts"), "console.log('fallback');\n");
    writeFileSync(join(cwd, "mubo.config.ts"), `export default { static: { dir: "./public" } };\n`);
    mkdirSync(join(cwd, "dist", "client"), { recursive: true });
    writeFileSync(join(cwd, "dist", "client", "index.html"), "built client");

    const result = await buildProject({ cwd, outfile: "dist/fallback-app" });
    expect(result.staticDir).toBe(join(cwd, "dist", "client"));
    expect(result.assets).toBe(1);
  }, 60_000);

  test("builds without assets when neither public nor dist/client exists", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "index.ts"), "console.log('no assets');\n");
    writeFileSync(join(cwd, "mubo.config.ts"), `export default { static: { dir: "./public" } };\n`);

    const result = await buildProject({ cwd, outfile: "dist/asset-less-app" });
    expect(result.staticDir).toBeUndefined();
    expect(result.assets).toBe(0);
    expect(existsSync(result.outfile)).toBe(true);
  }, 60_000);

  test("fails with a diagnostic when the entry cannot be compiled", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "index.ts"), "this is (( not valid typescript\n");
    await expect(buildProject({ cwd, outfile: "dist/broken-app" })).rejects.toThrow(
      /bun build failed with exit code/,
    );
  }, 60_000);

  test("falls back to the directory name when package.json has no usable name", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "index.ts"), "console.log('pkg fallback');\n");
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: 12345 }));
    mkdirSync(join(cwd, "public"));
    writeFileSync(join(cwd, "public", "index.html"), "ok");

    // Without --outfile the executable name derives from the app name, which
    // must fall back to the sanitized directory name instead of crashing.
    const result = await buildProject({ cwd });
    expect(result.outfile).toBe(join(cwd, "dist", basename(cwd)));
    expect(existsSync(result.outfile)).toBe(true);
  }, 60_000);

  test("treats a blank configured static directory as unset", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "index.ts"), "console.log('blank static');\n");
    writeFileSync(join(cwd, "mubo.config.ts"), `export default { static: { dir: "   " } };\n`);
    mkdirSync(join(cwd, "dist", "client"), { recursive: true });
    writeFileSync(join(cwd, "dist", "client", "index.html"), "built client");

    const result = await buildProject({ cwd, outfile: "dist/blank-static-app" });
    expect(result.staticDir).toBe(join(cwd, "dist", "client"));
    expect(result.assets).toBe(1);
  }, 60_000);

  test("honors environment overrides for app name, static mode and directory", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "index.ts"), "console.log('env config');\n");
    mkdirSync(join(cwd, "public"));
    mkdirSync(join(cwd, "env-assets"));
    writeFileSync(join(cwd, "public", "index.html"), "default");
    writeFileSync(join(cwd, "env-assets", "index.html"), "environment");
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "package-app" }));

    const result = await buildProject({
      cwd,
      env: {
        MUBO_APP_NAME: "Env App",
        MUBO_STATIC_MODE: "embedded",
        MUBO_STATIC_DIR: "env-assets",
      },
    });
    expect(result.outfile).toBe(join(cwd, "dist", "Env-App"));
    expect(result.staticDir).toBe(join(cwd, "env-assets"));
    expect(result.assets).toBe(1);

    const disabled = await buildProject({
      cwd,
      outfile: "dist/no-static",
      env: { MUBO_STATIC_MODE: "off" },
    });
    expect(disabled.staticDir).toBeUndefined();
    expect(disabled.assets).toBe(0);

    const blankName = await buildProject({
      cwd,
      env: { MUBO_APP_NAME: "   ", MUBO_STATIC_MODE: "off" },
    });
    expect(blankName.outfile).toBe(join(cwd, "dist", "package-app"));
  }, 60_000);

  test("finds JavaScript entries when no TypeScript entry exists", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "src", "server"), { recursive: true });
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "js-entry-app", type: "module" }),
    );
    writeFileSync(join(cwd, "src", "server", "index.js"), "console.log('js entry');\n");

    const result = await buildProject({ cwd, outfile: "dist/js-entry-app" });
    expect(result.entry).toBe(join(cwd, "src", "server", "index.js"));
    expect(existsSync(result.outfile)).toBe(true);
    expect(result.assets).toBe(0);
  }, 60_000);

  test("writes the embedded asset manifest with the shared runtime key", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "index.ts"), "console.log('manifest');\n");
    mkdirSync(join(cwd, "public"), { recursive: true });
    writeFileSync(join(cwd, "public", "index.html"), "<h1>manifest</h1>");

    const result = await buildProject({ cwd, outfile: "dist/manifest-app" });
    expect(result.assets).toBe(1);

    const manifest = readFileSync(join(cwd, ".mubo", "embedded-assets.ts"), "utf8");
    expect(manifest).toContain(JSON.stringify(EMBEDDED_ASSETS_KEY));
    expect(manifest).toContain("/index.html");
  }, 60_000);

  test("embeds every asset from a large static directory without losing order or bytes", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "index.ts"), "console.log('many assets');\n");
    const publicDir = join(cwd, "public");
    mkdirSync(join(publicDir, "nested"), { recursive: true });

    const expected: Record<string, string> = {};
    // More files than one concurrency batch, so several read waves are needed.
    for (let i = 0; i < 80; i++) {
      const name = `asset-${String(i).padStart(3, "0")}.txt`;
      const contents = `contents-${i}-${"z".repeat(i * 13)}`;
      writeFileSync(join(publicDir, name), contents);
      expected[`/${name}`] = contents;
    }
    const nestedContents = JSON.stringify({ ok: true, deep: [1, 2, 3] });
    writeFileSync(join(publicDir, "nested", "deep.json"), nestedContents);
    expected["/nested/deep.json"] = nestedContents;

    const result = await buildProject({ cwd, outfile: "dist/many-assets-app" });
    expect(result.assets).toBe(Object.keys(expected).length);

    const manifest = readFileSync(join(cwd, ".mubo", "embedded-assets.ts"), "utf8");
    const assets = JSON.parse(manifest.slice(manifest.indexOf("{")).trim().replace(/;$/, "")) as Record<
      string,
      { data: string; encoding: string; type: string }
    >;
    const sortedKeys = Object.keys(expected).sort();
    expect(Object.keys(assets)).toEqual(sortedKeys);
    for (const key of sortedKeys) {
      const asset = assets[key]!;
      expect(asset.encoding).toBe("base64");
      expect(Buffer.from(asset.data, "base64").toString("utf8")).toBe(expected[key]!);
    }
  }, 60_000);

  test(
    "bakes the project configuration into the compiled binary",
    async () => {
      const cwd = tempDir();
      const runtime = tempDir();
      mkdirSync(join(cwd, "src", "server"), { recursive: true });
      const port = await freePort();
      const dbPath = join(cwd, "baked.sqlite");
      writeFileSync(
        join(cwd, "mubo.config.ts"),
        `export default {
  app: { name: "baked-app", env: "test" },
  http: { host: "127.0.0.1", port: ${port} },
  db: { path: ${JSON.stringify(dbPath)} },
  static: { mode: "off" },
  log: { level: "error" },
};
`,
      );
      writeFileSync(
        join(cwd, "src", "server", "index.ts"),
        `import { createMuboApp } from ${JSON.stringify(framework)};

const app = await createMuboApp();
app.get("/where", () =>
  Response.json({ name: app.config.app.name, port: app.port, db: app.config.db.path }),
);

const shutdown = async () => {
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await app.start();
`,
      );

      const result = await buildProject({ cwd, outfile: "dist/baked-app" });
      expect(existsSync(result.outfile)).toBe(true);

      // A compiled binary must not depend on config files in its working
      // directory: it keeps the configuration it was built with.
      writeFileSync(
        join(runtime, "mubo.config.ts"),
        `throw new Error("compiled apps must not load config from their working directory");\n`,
      );

      const proc = Bun.spawn([result.outfile], {
        cwd: runtime,
        env: { ...process.env, MUBO_LOG_LEVEL: "error" },
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const where = await waitFor(`http://127.0.0.1:${port}/where`);
        expect(where.status).toBe(200);
        expect(await where.json()).toEqual({
          name: "baked-app",
          port,
          db: dbPath,
        });
        expect(existsSync(dbPath)).toBe(true);
      } finally {
        proc.kill("SIGTERM");
        await proc.exited;
      }
    },
    60_000,
  );

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

      writeFileSync(
        join(cwd, "mubo.config.ts"),
        `throw new Error("compiled apps must not load config from their working directory");\n`,
      );

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

      const argDataDir = join(cwd, "arg-data");
      const argPort = await freePort();
      const argProc = Bun.spawn(
        [result.outfile, "--port", String(argPort), "--data-dir", argDataDir, "--host", "127.0.0.1"],
        {
          cwd,
          env: {
            ...process.env,
            MUBO_PORT: "9",
            MUBO_DATA_DIR: join(cwd, "ignored-data"),
            MUBO_LOG_LEVEL: "error",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        const health = await waitFor(`http://127.0.0.1:${argPort}/healthz`);
        expect(health.status).toBe(200);
        expect(existsSync(join(argDataDir, "mubo.sqlite"))).toBe(true);
        expect(existsSync(join(cwd, "ignored-data"))).toBe(false);
      } finally {
        argProc.kill("SIGTERM");
        await argProc.exited;
      }
    },
    60_000,
  );
});
