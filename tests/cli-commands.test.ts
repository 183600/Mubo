import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCliArgs } from "../src/cli/args.ts";
import { Database } from "bun:sqlite";
import { devCommand, doctorCommand, migrateCommand } from "../src/cli/commands.ts";
import { loadAndResolveConfig, resolveConfig } from "../src/core/config.ts";

const tempDirs: string[] = [];
const framework = resolve(import.meta.dir, "../src/index.ts");
const frameworkImport = framework.split("\\").join("/");

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mubo-cmds-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function configSource(dbPath: string, includeAudit: boolean): string {
  return `import { defineConfig, defineSchema } from ${JSON.stringify(frameworkImport)};

const schema = defineSchema({
  tables: {
    users: {
      columns: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        email: { type: "text", notNull: true, unique: true },
      },
    },
    ${includeAudit ? 'audit: { columns: { id: { type: "text", primaryKey: true } } },' : ""}
  },
});

export default defineConfig({
  app: { name: "cmds-fixture", env: "test" },
  db: { path: ${JSON.stringify(dbPath)} },
  http: { port: 0 },
  static: { mode: "off" },
  log: { level: "error" },
  schema,
});
`;
}

function doctorConfigSource(cwd: string, options: { port?: number } = {}): string {
  return `import { defineConfig } from ${JSON.stringify(frameworkImport)};

export default defineConfig({
  app: { name: "doctor-fixture", env: "test" },
  db: { path: ${JSON.stringify(join(cwd, "doctor.sqlite"))} },
  http: {
    port: ${options.port ?? 0},
    requestTimeoutMs: 5000,
    rateLimit: { maxRequests: 10, windowMs: 1000 },
  },
  ws: { maxConnections: 4, maxConnectionsPerIp: 2 },
  static: { mode: "embedded", dir: "public" },
  log: { level: "error" },
});
`;
}

/**
 * Captures console output and the resulting process.exitCode while the
 * callback runs.
 *
 * The exit code is reset to 0 (never `undefined`): Bun keeps the previous
 * value when `undefined` is assigned, which would leak codes between tests.
 */
async function captureCommand(run: () => Promise<unknown>): Promise<{ stdout: string; code: number }> {
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const lines: string[] = [];
  process.exitCode = 0;
  console.log = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
  try {
    await run();
    return { stdout: lines.join("\n"), code: process.exitCode ?? 0 };
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode ?? 0;
  }
}

describe("migrateCommand", () => {
  test("applies migrations and reports an up-to-date database", async () => {
    const cwd = tempDir();
    const dbPath = join(cwd, "app.sqlite");
    writeFileSync(join(cwd, "mubo.config.ts"), configSource(dbPath, false));

    const first = await captureCommand(() =>
      migrateCommand({ cwd, args: parseCliArgs(["migrate"]) })
    );
    expect(first.stdout).toContain("applied migration");
    expect(first.stdout).toContain("users");
    expect(existsSync(dbPath)).toBe(true);

    const second = await captureCommand(() =>
      migrateCommand({ cwd, args: parseCliArgs(["migrate"]) })
    );
    expect(second.stdout).toContain("up to date");
  });

  test("reports pending migrations in check mode and sets the exit code", async () => {
    const cwd = tempDir();
    const dbPath = join(cwd, "app.sqlite");
    writeFileSync(join(cwd, "mubo.config.ts"), configSource(dbPath, true));

    const { stdout, code } = await captureCommand(() =>
      migrateCommand({ cwd, args: parseCliArgs(["migrate", "--check"]) })
    );
    expect(code).toBe(1);
    expect(stdout).toContain("pending migration");
    expect(stdout).toContain("audit");
    // Check mode must not create the application tables; the SQLite file
    // itself is created by opening the database.
    const db = new Database(dbPath);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='audit'").get(),
    ).toBeNull();
    db.close();
  });

  test("reports disabled migrations", async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, "mubo.config.ts"),
      `import { defineConfig } from ${JSON.stringify(frameworkImport)};
export default defineConfig({
  app: { name: "cmds-off", env: "test" },
  db: { path: ${JSON.stringify(join(cwd, "off.sqlite"))}, migrations: { mode: "off" } },
  http: { port: 0 },
  static: { mode: "off" },
  log: { level: "error" },
});
`,
    );
    const { stdout } = await captureCommand(() =>
      migrateCommand({ cwd, args: parseCliArgs(["migrate"]) })
    );
    expect(stdout).toContain("migrations are disabled");
  });

  test("applies migrations to the database selected with --db", async () => {
    const cwd = tempDir();
    const configPath = join(cwd, "config.sqlite");
    const flagPath = join(cwd, "flag.sqlite");
    writeFileSync(join(cwd, "mubo.config.ts"), configSource(configPath, false));

    const { stdout } = await captureCommand(() =>
      migrateCommand({ cwd, args: parseCliArgs(["migrate", "--db", flagPath]) })
    );
    expect(stdout).toContain("applied migration");
    expect(existsSync(flagPath)).toBe(true);
    // The configured database must stay untouched: CLI flags win over the file.
    expect(existsSync(configPath)).toBe(false);
  });

  test("stores the database in the data directory selected with --data-dir", async () => {
    const cwd = tempDir();
    const dataDir = join(cwd, "data");
    writeFileSync(
      join(cwd, "mubo.config.ts"),
      `import { defineConfig, defineSchema } from ${JSON.stringify(frameworkImport)};
export default defineConfig({
  app: { name: "cmds-data-dir", env: "test" },
  http: { port: 0 },
  static: { mode: "off" },
  log: { level: "error" },
  schema: defineSchema({
    tables: {
      users: {
        columns: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
        },
      },
    },
  }),
});
`,
    );

    const { stdout } = await captureCommand(() =>
      migrateCommand({ cwd, args: parseCliArgs(["migrate", "--data-dir", dataDir]) })
    );
    expect(stdout).toContain("applied migration");
    expect(existsSync(join(dataDir, "mubo.sqlite"))).toBe(true);
  });
});

describe("doctorCommand", () => {
  test("emits machine-readable checks including runtime extras", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "mubo.config.ts"), doctorConfigSource(cwd));
    const { stdout, code } = await captureCommand(() =>
      doctorCommand({ cwd, args: parseCliArgs(["doctor", "--json"]) })
    );
    expect(code).toBe(0);
    const checks = JSON.parse(stdout) as Array<{ name: string; ok: boolean; detail: string }>;
    const byName = new Map(checks.map((check) => [check.name, check]));
    expect(byName.get("bun")?.ok).toBe(true);
    expect(byName.get("platform")?.ok).toBe(true);
    expect(byName.get("config")?.ok).toBe(true);
    expect(byName.get("data-dir")?.ok).toBe(true);
    expect(byName.get("sqlite")?.ok).toBe(true);
    expect(byName.get("schema")?.ok).toBe(true);
    // static mode embedded is described even without collected assets.
    expect(byName.get("static")?.detail).toContain("embedded");
    expect(byName.get("http.requestTimeoutMs")?.detail).toBe("5000ms");
    expect(byName.get("http.rateLimit")?.detail).toContain("maxRequests=10");
    expect(byName.get("ws.maxConnections")?.detail).toBe("4");
    expect(byName.get("ws.maxConnectionsPerIp")?.detail).toBe("2");
  });

  test("prints human-readable lines without --json", async () => {
    const cwd = tempDir();
    // Disk mode without a public directory produces a warn line.
    writeFileSync(
      join(cwd, "mubo.config.ts"),
      `import { defineConfig } from ${JSON.stringify(frameworkImport)};
export default defineConfig({
  app: { name: "doctor-human", env: "test" },
  db: { path: ${JSON.stringify(join(cwd, "doctor.sqlite"))} },
  http: { port: 0 },
  static: { mode: "disk", dir: "public" },
  log: { level: "error" },
});
`,
    );
    const { stdout, code } = await captureCommand(() =>
      doctorCommand({ cwd, args: parseCliArgs(["doctor"]) })
    );
    expect(code).toBe(0);
    expect(stdout).toContain("[ok] bun:");
    expect(stdout).toContain("[ok] sqlite:");
    expect(stdout).toContain("[warn] static:");
  });

  test("flags an occupied port without failing the doctor run", async () => {
    const cwd = tempDir();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    try {
      // The occupied port comes from the config file here; the equivalent
      // check for a CLI flag lives in the test below.
      writeFileSync(join(cwd, "mubo.config.ts"), doctorConfigSource(cwd, { port: server.port }));
      const { stdout, code } = await captureCommand(() =>
        doctorCommand({ cwd, args: parseCliArgs(["doctor", "--json"]) })
      );
      expect(code).toBe(0);
      const checks = JSON.parse(stdout) as Array<{ name: string; ok: boolean; detail: string }>;
      const port = checks.find((check) => check.name === "port");
      expect(port?.ok).toBe(false);
      expect(port?.detail).toContain("already in use");
    } finally {
      await server.stop(true);
    }
  });

  test("checks the port selected with --port instead of the configured one", async () => {
    const cwd = tempDir();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    try {
      writeFileSync(join(cwd, "mubo.config.ts"), doctorConfigSource(cwd));
      const { stdout, code } = await captureCommand(() =>
        doctorCommand({
          cwd,
          args: parseCliArgs(["doctor", "--json", "--port", String(server.port)]),
        })
      );
      expect(code).toBe(0);
      const checks = JSON.parse(stdout) as Array<{ name: string; ok: boolean; detail: string }>;
      const port = checks.find((check) => check.name === "port");
      expect(port?.ok).toBe(false);
      expect(port?.detail).toContain(String(server.port));
      expect(port?.detail).toContain("already in use");
    } finally {
      await server.stop(true);
    }
  });

  test("flags a corrupt database file as a fatal problem", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "mubo.config.ts"), doctorConfigSource(cwd));
    // A file that is not a SQLite database.
    writeFileSync(join(cwd, "doctor.sqlite"), "this is definitely not sqlite");
    const { stdout, code } = await captureCommand(() =>
      doctorCommand({ cwd, args: parseCliArgs(["doctor", "--json"]) })
    );
    expect(code).toBe(1);
    const checks = JSON.parse(stdout) as Array<{ name: string; ok: boolean; detail: string }>;
    expect(checks.find((check) => check.name === "sqlite")?.ok).toBe(false);
  });

  test("runs the SQLite quick check on an existing healthy database", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "mubo.config.ts"), configSource(join(cwd, "doctor.sqlite"), false));
    // Create the database file first so doctor exercises the integrity path.
    await captureCommand(() => migrateCommand({ cwd, args: parseCliArgs(["migrate"]) }));
    const { stdout, code } = await captureCommand(() =>
      doctorCommand({ cwd, args: parseCliArgs(["doctor", "--json"]) })
    );
    expect(code).toBe(0);
    const checks = JSON.parse(stdout) as Array<{ name: string; ok: boolean; detail: string }>;
    const sqlite = checks.find((check) => check.name === "sqlite");
    expect(sqlite?.ok).toBe(true);
    expect(sqlite?.detail).toContain("writable");
  });

  test("checks in-memory databases without touching the filesystem", async () => {
    const cwd = tempDir();
    const dataDir = join(cwd, "data");
    writeFileSync(
      join(cwd, "mubo.config.ts"),
      `import { defineConfig } from ${JSON.stringify(frameworkImport)};
export default defineConfig({
  app: { name: "doctor-memory", env: "test" },
  db: { path: ":memory:" },
  dataDir: ${JSON.stringify(dataDir)},
  http: { port: 0 },
  static: { mode: "off" },
  log: { level: "error" },
});
`,
    );
    const { stdout, code } = await captureCommand(() =>
      doctorCommand({ cwd, args: parseCliArgs(["doctor", "--json"]) })
    );
    expect(code).toBe(0);
    const checks = JSON.parse(stdout) as Array<{ name: string; ok: boolean; detail: string }>;
    const sqlite = checks.find((check) => check.name === "sqlite");
    expect(sqlite?.ok).toBe(true);
    expect(sqlite?.detail).toContain(":memory:");
  });

  // A chmod-based write check cannot make a directory unwritable for root,
  // so the assertion below is only meaningful for unprivileged users.
  const skipWhenRoot = typeof process.getuid === "function" && process.getuid() === 0;
  test.skipIf(skipWhenRoot)("flags a read-only data directory as a fatal problem", async () => {
    const cwd = tempDir();
    const dataDir = join(cwd, "locked");
    mkdirSync(dataDir, { recursive: true });
    const originalMode = statSync(dataDir).mode;
    chmodSync(dataDir, 0o555);
    try {
      writeFileSync(
        join(cwd, "mubo.config.ts"),
        `import { defineConfig } from ${JSON.stringify(frameworkImport)};
export default defineConfig({
  app: { name: "doctor-readonly", env: "test" },
  dataDir: ${JSON.stringify(dataDir)},
  db: { path: ${JSON.stringify(join(cwd, "elsewhere.sqlite"))} },
  http: { port: 0 },
  static: { mode: "off" },
  log: { level: "error" },
});
`,
      );
      const { stdout, code } = await captureCommand(() =>
        doctorCommand({ cwd, args: parseCliArgs(["doctor", "--json"]) })
      );
      expect(code).toBe(1);
      const checks = JSON.parse(stdout) as Array<{ name: string; ok: boolean; detail: string }>;
      const dataDirCheck = checks.find((check) => check.name === "data-dir");
      expect(dataDirCheck?.ok).toBe(false);
      expect(dataDirCheck?.detail).toBe(dataDir);
    } finally {
      chmodSync(dataDir, originalMode);
    }
  });
});

describe("devCommand", () => {
  test("spawns the watcher with forwarded flags and propagates the exit code", async () => {
    const cwd = tempDir();
    const entry = join(cwd, "entry.ts");
    writeFileSync(entry, "console.log('dev entry');\n");

    const spawned: Array<{ command: string[]; options: unknown }> = [];
    const fakeSpawn = ((command: string[], options: unknown) => {
      spawned.push({ command, options });
      return { exited: Promise.resolve(3) } as unknown as Bun.Subprocess;
    }) as unknown as typeof Bun.spawn;

    const { code } = await captureCommand(() =>
      devCommand({
        cwd,
        args: parseCliArgs(["dev", "--entry", entry, "--port", "4123", "--no-ws"]),
        spawn: fakeSpawn,
      })
    );
    expect(code).toBe(3);
    expect(spawned.length).toBe(1);
    expect(spawned[0]!.command).toEqual(["bun", "--watch", entry, "--port=4123", "--no-ws"]);
    expect((spawned[0]!.options as { cwd: string }).cwd).toBe(cwd);
    expect(readFileSync(entry, "utf8")).toContain("dev entry");
  });

  test("rejects a missing entry file", async () => {
    const cwd = tempDir();
    await expect(
      devCommand({ cwd, args: parseCliArgs(["dev", "--entry", "missing.ts"]) })
    ).rejects.toThrow(/Cannot find app entry/);
  });
});

describe("command config loading", () => {
  test("projectConfig honours explicit config files via --config", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "custom.config.ts"), `export default { app: { name: "custom-cmds" } };\n`);
    const args = parseCliArgs(["doctor", "--config", "custom.config.ts"]);
    const config = await loadAndResolveConfig(
      {},
      {
        cwd,
        loadFile: true,
        configFile: "custom.config.ts",
        argv: [],
      },
    );
    expect(config.app.name).toBe("custom-cmds");
    expect(args.command).toBe("doctor");
  });

  test("resolved command config keeps the documented defaults", () => {
    const config = resolveConfig({}, { cwd: tempDir(), env: {}, argv: [] });
    expect(config.app.name).toBe("mubo-app");
    expect(config.db.migrations.mode).toBe("apply");
  });
});
