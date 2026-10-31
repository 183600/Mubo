import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMuboApp, loadAndResolveConfig, resolveConfig } from "../src/index.ts";
import { defaultDataDir, sanitizeAppName } from "../src/core/config.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mubo-config-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("configuration", () => {
  test("loads mubo.config.ts and applies env/argv precedence", async () => {
    const cwd = tempDir();
    const framework = resolve(import.meta.dir, "../src/index.ts").split("\\").join("/");
    writeFileSync(
      join(cwd, "mubo.config.ts"),
      `import { defineConfig } from ${JSON.stringify(framework)};
export default defineConfig({
  app: { name: "from-file", env: "test" },
  dataDir: ${JSON.stringify(join(cwd, "data"))},
  db: { path: ":memory:" },
  http: { port: 4100, host: "127.0.0.1" },
  static: { mode: "off" },
  log: { level: "error" },
});
`,
    );

    const app = await createMuboApp(
      {},
      { cwd, argv: [], env: { MUBO_APP_NAME: "from-env", MUBO_PORT: "4200" } },
    );
    expect(app.config.app.name).toBe("from-env");
    expect(app.config.http.port).toBe(4200);
    expect(app.config.http.host).toBe("127.0.0.1");
    await app.stop();

    const cliOverride = resolveConfig(
      {},
      { cwd, fileConfig: { http: { port: 4100 } }, argv: ["--port", "4300"], env: { MUBO_PORT: "4200" } },
    );
    expect(cliOverride.http.port).toBe(4300);
  });

  test("does not load a config file when explicit config is provided", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "mubo.config.ts"), `throw new Error("should not load");\n`);
    const app = await createMuboApp(
      {
        app: { name: "explicit" },
        dataDir: join(cwd, "data"),
        db: { path: ":memory:" },
        static: { mode: "off" },
        log: { level: "error" },
      },
      { cwd, argv: [], env: {} },
    );
    expect(app.config.app.name).toBe("explicit");
    await app.stop();
  });

  test("honors --config when creating an app", async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "mubo.config.ts"),
      `export default { app: { name: "default-file" } };\n`,
    );
    writeFileSync(
      join(cwd, "custom.config.ts"),
      `export default { app: { name: "custom-file" }, dataDir: ${JSON.stringify(join(cwd, "custom-data"))}, db: { path: ":memory:" }, static: { mode: "off" } };\n`,
    );
    const app = await createMuboApp(
      {},
      { cwd, argv: ["--config", "custom.config.ts"], env: { MUBO_LOG_LEVEL: "error" } },
    );
    expect(app.config.app.name).toBe("custom-file");
    await app.stop();
  });

  test("ignores --config after the CLI separator", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "mubo.config.ts"), `export default { app: { name: "default-file" } };\n`);
    writeFileSync(join(cwd, "custom.config.ts"), `export default { app: { name: "custom-file" } };\n`);

    for (const argv of [["--", "--config", "custom.config.ts"], ["--", "--config=custom.config.ts"]]) {
      const config = await loadAndResolveConfig({}, { cwd, loadFile: true, argv, env: {} });
      expect(config.app.name).toBe("default-file");
    }
  });

  test("defaults to JSON logs for production apps from any config source", () => {
    expect(resolveConfig({ app: { env: "production" } }, { env: {}, argv: [] }).log.json).toBe(true);
    expect(
      resolveConfig({}, { env: {}, argv: [], fileConfig: { app: { env: "production" } } }).log.json,
    ).toBe(true);
    expect(
      resolveConfig(
        { app: { env: "production" }, log: { json: false } },
        { env: {}, argv: [] },
      ).log.json,
    ).toBe(false);
    expect(
      resolveConfig({ app: { env: "development" } }, { env: {}, argv: [] }).log.json,
    ).toBe(false);
    expect(resolveConfig({}, { env: { MUBO_LOG_JSON: "0", MUBO_ENV: "production" }, argv: [] }).log.json).toBe(
      false,
    );
  });

  test("rejects invalid ports and migration table names", () => {
    expect(() => resolveConfig({ http: { port: 70000 } }, { env: {}, argv: [] })).toThrow(/Invalid HTTP port/);
    expect(() =>
      resolveConfig({ db: { migrations: { table: "bad-name;" } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid migrations table/);
  });

  test("sanitizes app names that could escape the default data directory", () => {
    expect(sanitizeAppName("..")).toBe("mubo-app");
    expect(sanitizeAppName("...")).toBe("mubo-app");
    expect(sanitizeAppName("../escape")).toBe("escape");
    expect(sanitizeAppName("---")).toBe("mubo-app");
    expect(sanitizeAppName("  My App  ")).toBe("My-App");

    const config = resolveConfig({ app: { name: ".." } }, { cwd: "/tmp", env: {}, argv: [] });
    expect(config.app.name).toBe("mubo-app");
    expect(config.dataDir).toBe(defaultDataDir("mubo-app", {}));
  });

  test("rejects missing flag values and invalid log levels", async () => {
    expect(() => resolveConfig({}, { env: {}, argv: ["--port"] })).toThrow(/Missing value for --port/);
    expect(() => resolveConfig({}, { env: {}, argv: ["--data-dir", "--port", "4000"] })).toThrow(
      /Missing value for --data-dir/,
    );
    expect(() => resolveConfig({}, { env: {}, argv: ["--log-level", "verbose"] })).toThrow(
      /Invalid log level/,
    );
    expect(() => resolveConfig({}, { env: { MUBO_LOG_LEVEL: "verbose" }, argv: [] })).toThrow(
      /Invalid MUBO_LOG_LEVEL/,
    );
    await expect(createMuboApp({}, { cwd: tempDir(), argv: ["--config"], env: {} })).rejects.toThrow(
      /Missing value for --config/,
    );
  });

  test("stops parsing CLI options after the separator", () => {
    const config = resolveConfig({}, { env: {}, argv: ["--", "--port", "4321"] });
    expect(config.http.port).toBe(3000);
  });

  test("applies all supported CLI overrides", () => {
    const cwd = tempDir();
    const config = resolveConfig(
      {},
      {
        cwd,
        env: {},
        argv: [
          "--data-dir",
          "data-root",
          "--port",
          "0",
          "--host",
          "0.0.0.0",
          "--db",
          ":memory:",
          "--static-dir",
          "assets",
          "--log-level",
          "debug",
          "--no-static",
          "--no-ws",
        ],
      },
    );
    expect(config.dataDir).toBe(resolve(cwd, "data-root"));
    expect(config.http).toMatchObject({ port: 0, host: "0.0.0.0" });
    expect(config.db.path).toBe(":memory:");
    expect(config.static.mode).toBe("off");
    expect(config.static.dir).toBe(resolve(cwd, "assets"));
    expect(config.log.level).toBe("debug");
    expect(config.ws.enabled).toBe(false);
  });

  test("honors explicit false values for boolean CLI switches", () => {
    const config = resolveConfig(
      {},
      { env: {}, argv: ["--no-static=false", "--no-ws=0"] },
    );
    expect(config.static.mode).toBe("disk");
    expect(config.ws.enabled).toBe(true);

    const disabled = resolveConfig({}, { env: {}, argv: ["--no-static=yes", "--no-ws=true"] });
    expect(disabled.static.mode).toBe("off");
    expect(disabled.ws.enabled).toBe(false);

    expect(() => resolveConfig({}, { env: {}, argv: ["--no-static="] })).toThrow(
      /Missing value for --no-static/,
    );
    expect(() => resolveConfig({}, { env: {}, argv: ["--no-ws=maybe"] })).toThrow(
      /Invalid boolean value/,
    );
  });

  test("treats an empty MUBO_HOST as unset", () => {
    const config = resolveConfig({}, { env: { MUBO_HOST: "" }, argv: [] });
    expect(config.http.host).toBe("127.0.0.1");
  });

  test("rejects empty HTTP hosts", () => {
    expect(() => resolveConfig({ http: { host: "" } }, { env: {}, argv: [] })).toThrow(
      /Invalid HTTP host/,
    );
    expect(() => resolveConfig({ http: { host: "   " } }, { env: {}, argv: [] })).toThrow(
      /Invalid HTTP host/,
    );
    expect(resolveConfig({ http: { host: " 0.0.0.0 " } }, { env: {}, argv: [] }).http.host).toBe(
      "0.0.0.0",
    );
  });

  test("rejects empty CLI values", async () => {
    expect(() => resolveConfig({}, { env: {}, argv: ["--port="] })).toThrow(
      /Missing value for --port/,
    );
    expect(() => resolveConfig({}, { env: {}, argv: ["--data-dir="] })).toThrow(
      /Missing value for --data-dir/,
    );
    await expect(
      loadAndResolveConfig({}, { cwd: tempDir(), loadFile: true, argv: ["--config="], env: {} }),
    ).rejects.toThrow(/Missing value for --config/);
  });

  test("reports config file loading failures and invalid environment values", async () => {
    const cwd = tempDir();
    await expect(
      loadAndResolveConfig({}, { cwd, loadFile: true, configFile: "missing.config.ts", env: {} }),
    ).rejects.toThrow(/Config file not found/);

    writeFileSync(join(cwd, "mubo.config.ts"), "export default 42;\n");
    await expect(loadAndResolveConfig({}, { cwd, loadFile: true, env: {} })).rejects.toThrow(
      /Failed to load config file/,
    );

    writeFileSync(join(cwd, "mubo.config.ts"), "export default [];\n");
    await expect(loadAndResolveConfig({}, { cwd, loadFile: true, env: {} })).rejects.toThrow(
      /Failed to load config file/,
    );

    expect(() => resolveConfig({}, { env: { MUBO_LOG_JSON: "maybe" }, argv: [] })).toThrow(
      /Invalid boolean value/,
    );
    expect(() => resolveConfig({}, { env: { MUBO_PORT: "abc" }, argv: [] })).toThrow(
      /MUBO_PORT must be a number/,
    );
  });

  test("does not share mutable cache defaults between resolutions", () => {
    const first = resolveConfig({}, { env: {}, argv: [] });
    first.static.cache.immutableExtensions.push("custom");
    const second = resolveConfig({}, { env: {}, argv: [] });
    expect(second.static.cache.immutableExtensions).not.toContain("custom");
  });

  test("treats an empty MUBO_ENV as unset and falls back to NODE_ENV", () => {
    const config = resolveConfig({}, { env: { MUBO_ENV: "", NODE_ENV: "production" }, argv: [] });
    expect(config.app.env).toBe("production");
    expect(config.log.json).toBe(true);
  });

  test("rejects invalid modes and log levels from explicit config", () => {
    expect(() => resolveConfig({ app: { env: "staging" as never } }, { env: {}, argv: [] })).toThrow(
      /Invalid app environment/,
    );
    expect(() => resolveConfig({ log: { level: "verbose" as never } }, { env: {}, argv: [] })).toThrow(
      /Invalid log level/,
    );
    expect(() =>
      resolveConfig({ db: { migrations: { mode: "sometimes" as never } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid migrations mode/);
    expect(() =>
      resolveConfig({ db: { migrations: { lock: "redis" as never } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid migrations lock/);
    expect(() => resolveConfig({ static: { mode: "cdn" as never } }, { env: {}, argv: [] })).toThrow(
      /Invalid static mode/,
    );
  });

  test("rejects malformed config sections with configuration errors", () => {
    const invalid: Array<[unknown, RegExp]> = [
      [{ app: null }, /Invalid app configuration/],
      [{ http: "invalid" }, /Invalid HTTP configuration/],
      [{ db: null }, /Invalid database configuration/],
      [{ db: { migrations: null } }, /Invalid migrations configuration/],
      [{ static: [] }, /Invalid static configuration/],
      [{ static: { cache: "invalid" } }, /Invalid static cache configuration/],
      [{ ws: { heartbeat: null } }, /Invalid WebSocket heartbeat configuration/],
      [{ log: "invalid" }, /Invalid log configuration/],
    ];
    for (const [config, pattern] of invalid) {
      expect(() => resolveConfig(config as never, { env: {}, argv: [] })).toThrow(pattern);
    }
  });

  test("rejects invalid environment modes", () => {
    expect(() => resolveConfig({}, { env: { MUBO_MIGRATIONS_MODE: "sometimes" }, argv: [] })).toThrow(
      /Invalid MUBO_MIGRATIONS_MODE/,
    );
    expect(() => resolveConfig({}, { env: { MUBO_STATIC_MODE: "cdn" }, argv: [] })).toThrow(
      /Invalid MUBO_STATIC_MODE/,
    );
    expect(
      resolveConfig({}, { env: { MUBO_MIGRATIONS_MODE: "check", MUBO_STATIC_MODE: "off" }, argv: [] }),
    ).toMatchObject({
      db: { migrations: { mode: "check" } },
      static: { mode: "off" },
    });
  });

  test("rejects malformed CORS configuration", () => {
    expect(() => resolveConfig({ http: { cors: true as never } }, { env: {}, argv: [] })).toThrow(
      /Invalid CORS configuration/,
    );
    expect(() => resolveConfig({ http: { cors: {} as never } }, { env: {}, argv: [] })).toThrow(
      /Invalid CORS origin/,
    );
    expect(() =>
      resolveConfig({ http: { cors: { origin: "https://example.test" as never } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid CORS origin/);
    expect(() =>
      resolveConfig({ http: { cors: { origin: [""] } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid CORS origin/);
    expect(() =>
      resolveConfig({ http: { cors: { origin: "*", credentials: "yes" as never } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid CORS credentials/);
  });

  test("rejects out-of-range numeric settings", () => {
    expect(() => resolveConfig({ http: { bodyLimit: 0 } }, { env: {}, argv: [] })).toThrow(
      /Invalid body limit/,
    );
    expect(() => resolveConfig({ http: { cors: { origin: "*", maxAgeSeconds: -1 } } }, { env: {}, argv: [] })).toThrow(
      /Invalid CORS max age/,
    );
    expect(() => resolveConfig({ db: { busyTimeoutMs: -1 } }, { env: {}, argv: [] })).toThrow(
      /Invalid busy timeout/,
    );
    expect(() => resolveConfig({ db: { slowQueryMs: -1 } }, { env: {}, argv: [] })).toThrow(
      /Invalid slow query threshold/,
    );
    expect(() => resolveConfig({ static: { cache: { defaultMaxAgeSeconds: -1 } } }, { env: {}, argv: [] })).toThrow(
      /Invalid static max age/,
    );
    expect(() => resolveConfig({ ws: { maxPayloadBytes: 0 } }, { env: {}, argv: [] })).toThrow(
      /Invalid WebSocket max payload/,
    );
    expect(() =>
      resolveConfig({ ws: { heartbeat: { intervalMs: -1 } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid WebSocket heartbeat interval/);
    expect(() => resolveConfig({ ws: { heartbeat: { timeoutMs: 0 } } }, { env: {}, argv: [] })).toThrow(
      /Invalid WebSocket heartbeat timeout/,
    );
    expect(() => resolveConfig({ db: { busyTimeoutMs: 1.5 } }, { env: {}, argv: [] })).toThrow(
      /Invalid busy timeout/,
    );
  });
});
