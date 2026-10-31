import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMuboApp, resolveConfig } from "../src/index.ts";

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

  test("rejects invalid ports and migration table names", () => {
    expect(() => resolveConfig({ http: { port: 70000 } }, { env: {}, argv: [] })).toThrow(/Invalid HTTP port/);
    expect(() =>
      resolveConfig({ db: { migrations: { table: "bad-name;" } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid migrations table/);
  });
});
