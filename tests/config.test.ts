import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createMuboApp, loadAndResolveConfig, resolveConfig } from "../src/index.ts";
import { defaultDataDir, mergeConfig, sanitizeAppName } from "../src/core/config.ts";

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

  test("lets --config override inline config for entries that import their own config", async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "custom.config.ts"),
      `export default { app: { name: "from-explicit-file" }, dataDir: ${JSON.stringify(join(cwd, "custom-data"))}, db: { path: ":memory:" }, http: { port: 4555 }, static: { mode: "off" }, log: { level: "error" } };\n`,
    );
    const app = await createMuboApp(
      {
        app: { name: "from-inline" },
        dataDir: join(cwd, "inline-data"),
        db: { path: ":memory:" },
        http: { port: 4000 },
        static: { mode: "off" },
        log: { level: "error" },
      },
      { cwd, argv: ["--config", "custom.config.ts"], env: {} },
    );
    expect(app.config.app.name).toBe("from-explicit-file");
    expect(app.config.http.port).toBe(4555);
    expect(app.config.dataDir).toBe(join(cwd, "custom-data"));
    await app.stop();
  });

  test("uses the last --config value from argv", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "first.config.ts"), `export default { app: { name: "first-file" } };\n`);
    writeFileSync(join(cwd, "last.config.ts"), `export default { app: { name: "last-file" } };\n`);

    const config = await loadAndResolveConfig(
      {},
      {
        cwd,
        loadFile: true,
        argv: ["--config", "first.config.ts", "--config=last.config.ts"],
        env: {},
      },
    );
    expect(config.app.name).toBe("last-file");
  });

  test("reloads a config file after it changes", async () => {
    const cwd = tempDir();
    const file = join(cwd, "mubo.config.ts");
    writeFileSync(file, `export default { app: { name: "first-file" } };\n`);
    expect((await loadAndResolveConfig({}, { cwd, loadFile: true, env: {}, argv: [] })).app.name).toBe(
      "first-file",
    );

    writeFileSync(file, `export default { app: { name: "second-file" } };\n`);
    expect((await loadAndResolveConfig({}, { cwd, loadFile: true, env: {}, argv: [] })).app.name).toBe(
      "second-file",
    );
  });

  test("loads config files and resolves defaults from a relative cwd", async () => {
    const cwd = tempDir();
    const relativeCwd = relative(process.cwd(), cwd);
    writeFileSync(
      join(cwd, "mubo.config.ts"),
      `export default { app: { name: "relative-file" }, db: { path: ":memory:" } };\n`,
    );
    writeFileSync(
      join(cwd, "custom.config.ts"),
      `export default { app: { name: "relative-custom" }, db: { path: ":memory:" } };\n`,
    );

    const loaded = await loadAndResolveConfig(
      {},
      { cwd: relativeCwd, loadFile: true, env: { HOME: cwd }, argv: [] },
    );
    expect(loaded.app.name).toBe("relative-file");
    expect(loaded.dataDir).toBe(defaultDataDir("relative-file", { HOME: cwd }));
    expect(loaded.static.dir).toBe(join(cwd, "public"));

    const custom = await loadAndResolveConfig(
      {},
      {
        cwd: relativeCwd,
        loadFile: true,
        configFile: "custom.config.ts",
        env: { HOME: cwd },
        argv: [],
      },
    );
    expect(custom.app.name).toBe("relative-custom");
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
    expect(resolveConfig({}, { env: { MUBO_LOG_JSON: "   ", MUBO_ENV: "production" }, argv: [] }).log.json).toBe(
      true,
    );
  });

  test("rejects invalid ports and migration table names", () => {
    expect(() => resolveConfig({ http: { port: 70000 } }, { env: {}, argv: [] })).toThrow(/Invalid HTTP port/);
    expect(() =>
      resolveConfig({ db: { migrations: { table: "bad-name;" } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid migrations table/);
  });

  test("uses the provided home directory for the default data directory", () => {
    const home = join(tmpdir(), "mubo-fake-home");
    const expected =
      process.platform === "win32"
        ? join(home, "AppData", "Roaming", "Mubo", "home-app")
        : join(home, ".mubo", "home-app");
    expect(defaultDataDir("home-app", { HOME: home })).toBe(expected);
    expect(
      resolveConfig({ app: { name: "home-app" } }, { cwd: tempDir(), env: { HOME: home }, argv: [] })
        .dataDir,
    ).toBe(expected);
  });

  test("sanitizes app names that could escape the default data directory", () => {
    expect(sanitizeAppName("..")).toBe("mubo-app");
    expect(sanitizeAppName("...")).toBe("mubo-app");
    expect(sanitizeAppName("../escape")).toBe("escape");
    expect(sanitizeAppName("---")).toBe("mubo-app");
    expect(sanitizeAppName("  My App  ")).toBe("My-App");
    expect(sanitizeAppName("a---b")).toBe("a-b");
    expect(sanitizeAppName("a   b")).toBe("a-b");

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

  test("handles --no-static and --no-ws without explicit values", () => {
    const config1 = resolveConfig({}, { env: {}, argv: ["--no-static", "--no-ws"] });
    expect(config1.static.mode).toBe("off");
    expect(config1.ws.enabled).toBe(false);

    const config2 = resolveConfig({}, { env: {}, argv: [] });
    expect(config2.static.mode).toBe("disk");
    expect(config2.ws.enabled).toBe(true);
  });

  test("handles --no-static=false enabling static again", () => {
    const config = resolveConfig({}, { env: {}, argv: ["--no-static=false"] });
    expect(config.static.mode).toBe("disk");
  });

  test("resolves relative db and static paths", () => {
    const cwd = tempDir();
    const config = resolveConfig(
      {
        db: { path: "data/app.sqlite" },
        static: { dir: "public" },
      },
      { cwd, env: {}, argv: [] },
    );
    expect(config.db.path).toBe(join(cwd, "data/app.sqlite"));
    expect(config.static.dir).toBe(join(cwd, "public"));
  });

  test("preserves absolute db and static paths unchanged", () => {
    const cwd = tempDir();
    const absDb = "/tmp/mubo-data/app.sqlite";
    const absStatic = "/tmp/mubo-assets";
    const config = resolveConfig(
      {
        db: { path: absDb },
        static: { dir: absStatic },
      },
      { cwd, env: {}, argv: [] },
    );
    expect(config.db.path).toBe(absDb);
    expect(config.static.dir).toBe(absStatic);
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
    await expect(
      loadAndResolveConfig({}, { cwd: tempDir(), loadFile: true, argv: ["--config", ""], env: {} }),
    ).rejects.toThrow(/Missing value for --config/);
    await expect(
      loadAndResolveConfig({}, { cwd: tempDir(), loadFile: true, configFile: "", env: {} }),
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

    writeFileSync(join(cwd, "mubo.config.ts"), "export default new Date();\n");
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

  test("merges prototype-like keys as own properties", () => {
    const override = JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"mode":"own"}}') as {
      __proto__: { polluted: string };
      constructor: { mode: string };
    };
    const merged = mergeConfig({ app: { name: "base" } }, override);

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, "__proto__")).toBe(true);
    expect((merged as unknown as { __proto__: unknown }).__proto__).toEqual({ polluted: "yes" });
    expect((merged as unknown as { constructor: unknown }).constructor).toEqual({ mode: "own" });
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
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

    const spaced = resolveConfig(
      {},
      { env: { MUBO_ENV: "  test  ", NODE_ENV: "production" }, argv: [] },
    );
    expect(spaced.app.env).toBe("test");
  });

  test("rejects invalid MUBO_ENV values but ignores unknown NODE_ENV values", () => {
    expect(() => resolveConfig({}, { env: { MUBO_ENV: "staging" }, argv: [] })).toThrow(
      /Invalid MUBO_ENV/,
    );
    expect(() => resolveConfig({}, { env: { MUBO_ENV: " production-ish " }, argv: [] })).toThrow(
      /Invalid MUBO_ENV/,
    );
    expect(resolveConfig({}, { env: { NODE_ENV: "staging" }, argv: [] }).app.env).toBe("development");
  });

  test("trims whitespace around environment values", () => {
    const config = resolveConfig(
      {},
      {
        env: {
          MUBO_PORT: " 4321 ",
          MUBO_BODY_LIMIT: " 2048 ",
          MUBO_LOG_JSON: " yes ",
          MUBO_LOG_LEVEL: " debug ",
          MUBO_MIGRATIONS_MODE: " check ",
          MUBO_STATIC_MODE: " off ",
          MUBO_WS_ENABLED: " false ",
        },
        argv: [],
      },
    );
    expect(config.http).toMatchObject({ port: 4321, bodyLimit: 2048 });
    expect(config.log).toEqual({ level: "debug", json: true });
    expect(config.db.migrations.mode).toBe("check");
    expect(config.static.mode).toBe("off");
    expect(config.ws.enabled).toBe(false);
  });

  test("trims whitespace around environment paths, names and the migrations table", () => {
    const config = resolveConfig(
      {},
      {
        cwd: "/tmp/mubo-config",
        env: {
          MUBO_APP_NAME: "  spaced app  ",
          MUBO_DATA_DIR: "  /tmp/mubo-data  ",
          MUBO_DB_PATH: "  /tmp/mubo-data/app.sqlite  ",
          MUBO_HOST: " 0.0.0.0 ",
          MUBO_MIGRATIONS_TABLE: "  custom_migrations  ",
          MUBO_STATIC_DIR: "  assets  ",
        },
        argv: [],
      },
    );
    expect(config.app.name).toBe("spaced-app");
    expect(config.dataDir).toBe("/tmp/mubo-data");
    expect(config.db.path).toBe("/tmp/mubo-data/app.sqlite");
    expect(config.http.host).toBe("0.0.0.0");
    expect(config.db.migrations.table).toBe("custom_migrations");
    expect(config.static.dir).toBe("/tmp/mubo-config/assets");

    const blank = resolveConfig(
      {
        app: { name: "fallback" },
        dataDir: "/tmp/fallback",
        db: { path: ":memory:" },
        http: { host: "127.0.0.1" },
        static: { mode: "off" },
      },
      {
        cwd: "/tmp/mubo-config",
        env: {
          MUBO_APP_NAME: "   ",
          MUBO_DATA_DIR: "   ",
          MUBO_DB_PATH: "   ",
          MUBO_HOST: "   ",
          MUBO_MIGRATIONS_TABLE: "   ",
          MUBO_STATIC_DIR: "   ",
        },
        argv: [],
      },
    );
    expect(blank.app.name).toBe("fallback");
    expect(blank.dataDir).toBe("/tmp/fallback");
    expect(blank.db.path).toBe(":memory:");
    expect(blank.http.host).toBe("127.0.0.1");
    expect(blank.db.migrations.table).toBe("_mubo_migrations");
    expect(blank.static.dir).toBe("/tmp/mubo-config/public");
  });

  test("bounds sanitized app names to a filesystem-safe length", () => {
    const name = sanitizeAppName(`${"a".repeat(80)}...`);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith(".")).toBe(false);
    expect(sanitizeAppName(`${"b".repeat(63)}-`)).toHaveLength(63);
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
      [{ http: new Date() }, /Invalid HTTP configuration/],
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

  test("normalizes CORS origins and keeps credentials", () => {
    const input = {
      http: {
        cors: {
          origin: ["  https://one.test ", "https://two.test  "],
          credentials: true,
        },
      },
    };
    const config = resolveConfig(input, { env: {}, argv: [] });
    expect(config.http.cors).toEqual({
      origin: ["https://one.test", "https://two.test"],
      credentials: true,
    });
    expect(input.http.cors.origin).toEqual(["  https://one.test ", "https://two.test  "]);
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
      resolveConfig({ http: { cors: { origin: [] } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid CORS origin/);
    expect(() =>
      resolveConfig({ http: { cors: { origin: ["   "] } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid CORS origin/);
    expect(() =>
      resolveConfig({ http: { cors: { origin: "*", credentials: "yes" as never } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid CORS credentials/);
  });

  test("rejects non-boolean config switches and invalid cache extensions", () => {
    const invalid: Array<[unknown, RegExp]> = [
      [{ http: { trustProxy: "false" } }, /Invalid trust proxy setting/],
      [{ db: { wal: "false" } }, /Invalid database WAL setting/],
      [{ db: { foreignKeys: 0 } }, /Invalid database foreign keys setting/],
      [{ db: { migrations: { safeOnly: "true" } } }, /Invalid safeOnly migrations setting/],
      [{ static: { spaFallback: "false" } }, /Invalid static SPA fallback setting/],
      [{ ws: { enabled: "false" } }, /Invalid WebSocket enabled setting/],
      [{ log: { json: "false" } }, /Invalid JSON logging setting/],
      [{ static: { cache: { immutableExtensions: "js" } } }, /Invalid immutable extensions setting/],
      [{ static: { cache: { immutableExtensions: [""] } } }, /Invalid immutable extensions setting/],
      [{ static: { cache: { immutableExtensions: ["."] } } }, /Invalid immutable extensions setting/],
      [{ static: { cache: { immutableExtensions: ["   "] } } }, /Invalid immutable extensions setting/],
    ];
    for (const [config, pattern] of invalid) {
      expect(() => resolveConfig(config as never, { env: {}, argv: [] })).toThrow(pattern);
    }
  });

  test("trims whitespace around explicit path and table settings", () => {
    const cwd = tempDir();
    const config = resolveConfig(
      {
        dataDir: "  data-root  ",
        db: { path: "  :memory:  ", migrations: { table: "  custom_migrations  " } },
        static: { dir: "  assets  " },
      },
      { cwd, env: {}, argv: [] },
    );
    expect(config.dataDir).toBe(resolve(cwd, "data-root"));
    expect(config.db.path).toBe(":memory:");
    expect(config.db.migrations.table).toBe("custom_migrations");
    expect(config.static.dir).toBe(resolve(cwd, "assets"));

    const blank = resolveConfig(
      { dataDir: "   ", db: { path: "   " }, static: { dir: "   " } },
      { cwd, env: { HOME: cwd }, argv: [] },
    );
    expect(blank.dataDir).toBe(defaultDataDir("mubo-app", { HOME: cwd }));
    expect(blank.db.path).toBe(join(blank.dataDir, "mubo.sqlite"));
    expect(blank.static.dir).toBe(join(cwd, "public"));

    expect(() =>
      resolveConfig({ db: { migrations: { table: "   " } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid migrations table/);
  });

  test("normalizes immutable cache extensions", () => {
    const config = resolveConfig(
      { static: { cache: { immutableExtensions: [".JS", " Css ", "woff2"] } } },
      { env: {}, argv: [] },
    );
    expect(config.static.cache.immutableExtensions).toEqual(["js", "css", "woff2"]);
  });

  test("rejects non-string path and name settings", () => {
    const invalid: Array<[unknown, RegExp]> = [
      [{ app: { name: 123 } }, /Invalid app name setting/],
      [{ dataDir: 123 }, /Invalid data directory setting/],
      [{ db: { path: 123 } }, /Invalid database path setting/],
      [{ db: { migrations: { table: 123 } } }, /Invalid migrations table setting/],
      [{ static: { dir: 123 } }, /Invalid static directory setting/],
    ];
    for (const [config, pattern] of invalid) {
      expect(() => resolveConfig(config as never, { env: {}, argv: [] })).toThrow(pattern);
    }
  });

  test("treats an empty static directory as the default", () => {
    const cwd = tempDir();
    const config = resolveConfig({ static: { dir: "" } }, { cwd, env: {}, argv: [] });
    expect(config.static.dir).toBe(resolve(cwd, "public"));
  });

  test("rejects out-of-range numeric settings", () => {
    expect(() => resolveConfig({ http: { bodyLimit: 0 } }, { env: {}, argv: [] })).toThrow(
      /Invalid body limit/,
    );
    expect(() => resolveConfig({ http: { bodyLimit: -1 } }, { env: {}, argv: [] })).toThrow(
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
    expect(() => resolveConfig({ ws: { heartbeat: { intervalMs: 60000, timeoutMs: 30000 } } }, { env: {}, argv: [] })).toThrow(
      /WebSocket heartbeat timeout.*must be greater than interval/,
    );
    expect(() => resolveConfig({ db: { busyTimeoutMs: 1.5 } }, { env: {}, argv: [] })).toThrow(
      /Invalid busy timeout/,
    );
    expect(() => resolveConfig({ http: { port: -1 } }, { env: {}, argv: [] })).toThrow(
      /Invalid HTTP port/,
    );
    expect(() => resolveConfig({ http: { port: 65536 } }, { env: {}, argv: [] })).toThrow(
      /Invalid HTTP port/,
    );
    expect(() => resolveConfig({ http: { port: 3.14 } }, { env: {}, argv: [] })).toThrow(
      /Invalid HTTP port/,
    );
  });

  test("rejects non-numeric and non-integer ports passed via CLI argv", () => {
    expect(() => resolveConfig({}, { env: {}, argv: ["--port", "abc"] })).toThrow(
      /--port must be a number/,
    );
    expect(() => resolveConfig({}, { env: {}, argv: ["--port", "3.14"] })).toThrow(
      /Invalid HTTP port/,
    );
    expect(() => resolveConfig({}, { env: {}, argv: ["--port=3.14"] })).toThrow(/Invalid HTTP port/);
    expect(() => resolveConfig({}, { env: {}, argv: ["--port", "70000"] })).toThrow(
      /Invalid HTTP port/,
    );
  });

  test("parses MUBO_BODY_LIMIT and MUBO_WS_MAX_PAYLOAD from environment", () => {
    const config = resolveConfig(
      {},
      {
        env: { MUBO_BODY_LIMIT: "2048", MUBO_WS_MAX_PAYLOAD: "2097152" },
        argv: [],
      },
    );
    expect(config.http.bodyLimit).toBe(2048);
    expect(config.ws.maxPayloadBytes).toBe(2097152);
  });

  test("rejects zero body limit and zero WebSocket max payload from environment", () => {
    expect(() =>
      resolveConfig({}, { env: { MUBO_BODY_LIMIT: "0" }, argv: [] }),
    ).toThrow(/Invalid body limit/);
    expect(() =>
      resolveConfig({}, { env: { MUBO_WS_MAX_PAYLOAD: "0" }, argv: [] }),
    ).toThrow(/Invalid WebSocket max payload/);
  });

  test("parses MUBO_SLOW_QUERY_MS from environment", () => {
    const config = resolveConfig({}, { env: { MUBO_SLOW_QUERY_MS: "500" }, argv: [] });
    expect(config.db.slowQueryMs).toBe(500);
  });

  test("parses MUBO_WAL and MUBO_FOREIGN_KEYS from environment", () => {
    const config = resolveConfig(
      {},
      { env: { MUBO_WAL: "0", MUBO_FOREIGN_KEYS: "false" }, argv: [] },
    );
    expect(config.db.wal).toBe(false);
    expect(config.db.foreignKeys).toBe(false);
  });

  test("parses MUBO_MIGRATIONS_LOCK from environment", () => {
    const config = resolveConfig({}, { env: { MUBO_MIGRATIONS_LOCK: "file" }, argv: [] });
    expect(config.db.migrations.lock).toBe("file");
    const sqliteConfig = resolveConfig({}, { env: { MUBO_MIGRATIONS_LOCK: "sqlite" }, argv: [] });
    expect(sqliteConfig.db.migrations.lock).toBe("sqlite");
  });

  test("rejects invalid MUBO_SLOW_QUERY_MS from environment", () => {
    expect(() =>
      resolveConfig({}, { env: { MUBO_SLOW_QUERY_MS: "-1" }, argv: [] }),
    ).toThrow(/Invalid slow query threshold/);
    expect(() =>
      resolveConfig({}, { env: { MUBO_SLOW_QUERY_MS: "1.5" }, argv: [] }),
    ).toThrow(/Invalid slow query threshold/);
  });

  test("rejects invalid MUBO_MIGRATIONS_LOCK from environment", () => {
    expect(() =>
      resolveConfig({}, { env: { MUBO_MIGRATIONS_LOCK: "redis" }, argv: [] }),
    ).toThrow(/Invalid MUBO_MIGRATIONS_LOCK/);
  });

  test("accepts valid boolean values for MUBO_WAL and MUBO_FOREIGN_KEYS from environment", () => {
    const trueConfig = resolveConfig(
      {},
      { env: { MUBO_WAL: "true", MUBO_FOREIGN_KEYS: "yes" }, argv: [] },
    );
    expect(trueConfig.db.wal).toBe(true);
    expect(trueConfig.db.foreignKeys).toBe(true);
  });

  test("rejects invalid boolean values for MUBO_WAL from environment", () => {
    expect(() =>
      resolveConfig({}, { env: { MUBO_WAL: "maybe" }, argv: [] }),
    ).toThrow(/Invalid boolean value/);
  });

  test("rejects invalid MUBO_BUSY_TIMEOUT_MS from environment", () => {
    expect(() =>
      resolveConfig({}, { env: { MUBO_BUSY_TIMEOUT_MS: "-1" }, argv: [] }),
    ).toThrow(/Invalid busy timeout/);
    expect(() =>
      resolveConfig({}, { env: { MUBO_BUSY_TIMEOUT_MS: "1.5" }, argv: [] }),
    ).toThrow(/Invalid busy timeout/);
  });

  test("accepts zero and positive MUBO_BUSY_TIMEOUT_MS from environment", () => {
    const config = resolveConfig({}, { env: { MUBO_BUSY_TIMEOUT_MS: "0" }, argv: [] });
    expect(config.db.busyTimeoutMs).toBe(0);
    const config100 = resolveConfig({}, { env: { MUBO_BUSY_TIMEOUT_MS: "100" }, argv: [] });
    expect(config100.db.busyTimeoutMs).toBe(100);
  });

  test("rejects non-numeric MUBO_BUSY_TIMEOUT_MS from environment", () => {
    expect(() =>
      resolveConfig({}, { env: { MUBO_BUSY_TIMEOUT_MS: "abc" }, argv: [] }),
    ).toThrow(/must be a number/);
  });

  test("rejects invalid MUBO_SLOW_QUERY_MS from environment", () => {
    expect(() =>
      resolveConfig({}, { env: { MUBO_SLOW_QUERY_MS: "-1" }, argv: [] }),
    ).toThrow(/Invalid slow query threshold/);
    expect(() =>
      resolveConfig({}, { env: { MUBO_SLOW_QUERY_MS: "Infinity" }, argv: [] }),
    ).toThrow(/must be a number/);
    expect(() =>
      resolveConfig({}, { env: { MUBO_SLOW_QUERY_MS: "1.5" }, argv: [] }),
    ).toThrow(/Invalid slow query threshold/);
  });

  test("accepts zero and positive MUBO_SLOW_QUERY_MS from environment", () => {
    const config = resolveConfig({}, { env: { MUBO_SLOW_QUERY_MS: "0" }, argv: [] });
    expect(config.db.slowQueryMs).toBe(0);
    const config500 = resolveConfig({}, { env: { MUBO_SLOW_QUERY_MS: "500" }, argv: [] });
    expect(config500.db.slowQueryMs).toBe(500);
  });

  test("rejects invalid table name via MUBO_MIGRATIONS_TABLE", () => {
    expect(() =>
      resolveConfig({}, { env: { MUBO_MIGRATIONS_TABLE: "123_invalid" }, argv: [] }),
    ).toThrow(/Invalid migrations table name/);
    expect(() =>
      resolveConfig({}, { env: { MUBO_MIGRATIONS_TABLE: "invalid-table!" }, argv: [] }),
    ).toThrow(/Invalid migrations table name/);
  });

  test("rejects invalid MUBO_PORT from environment", () => {
    expect(() =>
      resolveConfig({}, { env: { MUBO_PORT: "-1" }, argv: [] }),
    ).toThrow(/Invalid HTTP port/);
    expect(() =>
      resolveConfig({}, { env: { MUBO_PORT: "3.14" }, argv: [] }),
    ).toThrow(/Invalid HTTP port/);
    expect(() =>
      resolveConfig({}, { env: { MUBO_PORT: "70000" }, argv: [] }),
    ).toThrow(/Invalid HTTP port/);
  });

  test("accepts valid MUBO_PORT from environment", () => {
    const config = resolveConfig({}, { env: { MUBO_PORT: "0" }, argv: [] });
    expect(config.http.port).toBe(0);
    const config8080 = resolveConfig({}, { env: { MUBO_PORT: "8080" }, argv: [] });
    expect(config8080.http.port).toBe(8080);
  });

  test("parses MUBO_HOST from environment", () => {
    const config = resolveConfig({}, { env: { MUBO_HOST: "0.0.0.0" }, argv: [] });
    expect(config.http.host).toBe("0.0.0.0");
  });
});
