import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { boolFlag, parseCliArgs, stringFlag } from "../src/cli/args.ts";
import { initProject } from "../src/cli/init.ts";

const tempDirs: string[] = [];
const cli = resolve(import.meta.dir, "../src/cli/index.ts");
const framework = resolve(import.meta.dir, "../src/index.ts");
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mubo-cli-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function configSource(dbPath: string, includeAudit: boolean): string {
  const importPath = framework.split("\\").join("/");
  return `import { defineConfig, defineSchema } from ${JSON.stringify(importPath)};

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
  app: { name: "cli-fixture", env: "test" },
  db: { path: ${JSON.stringify(dbPath)} },
  http: { port: 0 },
  static: { mode: "off" },
  log: { level: "error" },
  schema,
});
`;
}

async function runCli(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MUBO_LOG_LEVEL: "error" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("CLI", () => {
  test("parses commands and flags", () => {
    const parsed = parseCliArgs(["init", "my-app", "--force", "--port", "4000", "--outfile=x"]);
    expect(parsed.command).toBe("init");
    expect(parsed.positionals).toEqual(["my-app"]);
    expect(parsed.flags.get("force")).toBe(true);
    expect(parsed.flags.get("port")).toBe("4000");
    expect(parsed.flags.get("outfile")).toBe("x");

    const beforePositional = parseCliArgs(["init", "--force", "my-app", "--install"]);
    expect(beforePositional.command).toBe("init");
    expect(beforePositional.positionals).toEqual(["my-app"]);
    expect(beforePositional.flags.get("force")).toBe(true);
    expect(beforePositional.flags.get("install")).toBe(true);

    const booleans = parseCliArgs(["dev", "--json=false", "--host", "127.0.0.1"]);
    expect(boolFlag(booleans, "json")).toBe(false);
    expect(boolFlag(booleans, "force")).toBe(false);
    expect(stringFlag(booleans, "host")).toBe("127.0.0.1");
    expect(stringFlag(booleans, "force")).toBeUndefined();
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(boolFlag(parseCliArgs(["build", `--minify=${value}`]), "minify")).toBe(true);
    }
    for (const value of ["0", "false", "FALSE", "no", "off"]) {
      expect(boolFlag(parseCliArgs(["build", `--minify=${value}`]), "minify")).toBe(false);
    }
    expect(() => boolFlag(parseCliArgs(["build", "--minify=maybe"]), "minify")).toThrow(
      /Invalid boolean value/,
    );
    expect(() => boolFlag(parseCliArgs(["build", "--minify="]), "minify")).toThrow(
      /Missing value for --minify/,
    );

    const separator = parseCliArgs(["migrate", "--", "--check", "file"]);
    expect(separator.command).toBe("migrate");
    expect(separator.positionals).toEqual(["--check", "file"]);
    expect(separator.flags.size).toBe(0);

    const empty = parseCliArgs([]);
    expect(empty.command).toBeUndefined();
    expect(empty.positionals).toEqual([]);

    const missing = parseCliArgs(["build", "--entry"]);
    expect(() => stringFlag(missing, "entry")).toThrow(/Missing value for --entry/);
    expect(() => stringFlag(parseCliArgs(["migrate", "--config"]), "config")).toThrow(
      /Missing value for --config/,
    );
    for (const flag of ["entry", "outfile", "static-dir", "target", "config"]) {
      expect(() => stringFlag(parseCliArgs(["build", `--${flag}=`]), flag)).toThrow(
        new RegExp(`Missing value for --${flag}`),
      );
    }
  });

  test("dev rejects entry paths that are not files", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "entry-dir"));
    writeFileSync(join(cwd, "entry-dir", "package.json"), "{}");
    const result = await runCli(cwd, ["dev", "--entry", "entry-dir"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cannot find app entry: entry-dir");
  });

  test("init creates a complete project and refuses to overwrite non-empty dirs", async () => {
    const cwd = tempDir();
    const dir = await initProject("my-app", { cwd });
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "mubo.config.ts"))).toBe(true);
    expect(existsSync(join(dir, "src/server/index.ts"))).toBe(true);
    expect(existsSync(join(dir, "src/server/schema.ts"))).toBe(true);
    expect(existsSync(join(dir, "src/server/schema.test.ts"))).toBe(true);
    expect(existsSync(join(dir, "public/index.html"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.scripts.dev).toBe("mubo dev");
    expect(pkg.dependencies.mubo).toBeTruthy();
    expect(readFileSync(join(dir, "mubo.config.ts"), "utf8")).toContain("mode: \"embedded\"");
    expect(readFileSync(join(dir, "tsconfig.json"), "utf8")).toContain("allowImportingTsExtensions");
    await expect(initProject("my-app", { cwd })).rejects.toThrow(/not empty/);
    await expect(initProject("my-app", { cwd, force: true })).resolves.toBe(dir);

    writeFileSync(join(cwd, "occupied"), "not a directory");
    await expect(initProject("occupied", { cwd })).rejects.toThrow(/not a directory/);
  });

  test("migrate applies, reports idempotency, and checks pending migrations", async () => {
    const cwd = tempDir();
    const dbPath = join(cwd, "app.sqlite");
    writeFileSync(join(cwd, "mubo.config.ts"), configSource(dbPath, false));
    const first = await runCli(cwd, ["migrate"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("applied migration");
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()).toBeTruthy();
    db.close();

    const second = await runCli(cwd, ["migrate"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("up to date");

    writeFileSync(join(cwd, "mubo.config.ts"), configSource(dbPath, true));
    const checked = await runCli(cwd, ["migrate", "--check"]);
    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain("pending migration");
    const checkDb = new Database(dbPath);
    expect(checkDb.query("SELECT name FROM sqlite_master WHERE type='table' AND name='audit'").get()).toBeNull();
    checkDb.close();

    const applied = await runCli(cwd, ["migrate"]);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain("audit");
  });

  test("doctor reports environment diagnostics", async () => {
    const cwd = tempDir();
    const result = await runCli(cwd, ["doctor", "--json", "--data-dir", join(cwd, "data"), "--port", "0"]);
    expect(result.code).toBe(0);
    const checks = JSON.parse(result.stdout) as Array<{ name: string; ok: boolean }>;
    expect(checks.find((check) => check.name === "bun")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "sqlite")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "data-dir")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "port")?.ok).toBe(true);
  });

  test("doctor flags invalid schema definitions", async () => {
    const cwd = tempDir();
    const importPath = framework.split("\\").join("/");
    writeFileSync(
      join(cwd, "mubo.config.ts"),
      `import { defineConfig } from ${JSON.stringify(importPath)};
export default defineConfig({
  app: { name: "cli-invalid-schema", env: "test" },
  db: { path: ":memory:" },
  http: { port: 0 },
  static: { mode: "off" },
  log: { level: "error" },
  schema: {
    tables: {
      broken: {
        columns: { id: { type: "integer" } },
        indexes: [{ name: "bad-name", columns: ["id"] }],
      },
    },
  },
});
`,
    );
    const result = await runCli(cwd, ["doctor", "--json", "--data-dir", join(cwd, "data"), "--port", "0"]);
    expect(result.code).toBe(1);
    const checks = JSON.parse(result.stdout) as Array<{ name: string; ok: boolean; detail: string }>;
    const schema = checks.find((check) => check.name === "schema");
    expect(schema?.ok).toBe(false);
    expect(schema?.detail).toContain("Invalid SQL identifier");
  });

  test("doctor flags an unusable configured database path", async () => {
    const cwd = tempDir();
    const dbPath = join(cwd, "db-dir");
    mkdirSync(dbPath, { recursive: true });
    const result = await runCli(cwd, [
      "doctor",
      "--json",
      "--data-dir",
      join(cwd, "data"),
      "--db",
      dbPath,
      "--port",
      "0",
    ]);
    expect(result.code).toBe(1);
    const checks = JSON.parse(result.stdout) as Array<{ name: string; ok: boolean }>;
    expect(checks.find((check) => check.name === "sqlite")?.ok).toBe(false);
  });
});
