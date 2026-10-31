import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMuboApp, resolveConfig } from "../src/index.ts";
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
