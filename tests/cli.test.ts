import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { boolFlag, parseCliArgs, stringFlag } from "../src/cli/args.ts";
import { devForwardedArgs } from "../src/cli/commands.ts";
import { initProject, muboDependencySpecifier } from "../src/cli/init.ts";
import {
  compareVersions,
  ENTRY_CANDIDATES,
  findEntry,
  frameworkPackage,
  MINIMUM_BUN_VERSION,
  satisfiesMinimumBunVersion,
} from "../src/cli/project.ts";
import { loadAndResolveConfig, resolveConfig } from "../src/core/config.ts";

const tempDirs: string[] = [];
const cli = resolve(import.meta.dir, "../src/cli/index.ts");
const framework = resolve(import.meta.dir, "../src/index.ts");
const frameworkRoot = resolve(import.meta.dir, "..");
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

async function runCli(
  cwd: string,
  args: string[],
  cliPath: string = cli,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
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
    for (const value of [" 1 ", " TRUE ", "yes\t", " on "]) {
      expect(boolFlag(parseCliArgs(["build", `--minify=${value}`]), "minify")).toBe(true);
    }
    for (const value of [" 0 ", " FALSE ", "no\t", " off "]) {
      expect(boolFlag(parseCliArgs(["build", `--minify=${value}`]), "minify")).toBe(false);
    }
    expect(() => boolFlag(parseCliArgs(["build", "--minify=maybe"]), "minify")).toThrow(
      /Invalid boolean value/,
    );
    expect(() => boolFlag(parseCliArgs(["build", "--minify="]), "minify")).toThrow(
      /Missing value for --minify/,
    );
    expect(() => boolFlag(parseCliArgs(["build", "--minify=   "]), "minify")).toThrow(
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

  test("documents config and dev flags in help output", async () => {
    const result = await runCli(tempDir(), ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("mubo build");
    expect(result.stdout).toContain("--config <file>");
    expect(result.stdout).toContain("--no-static");
    expect(result.stdout).toContain("--no-ws");
    expect(result.stdout).toContain("--request-timeout <ms>");
    expect(result.stdout).toContain("mubo --version");
  });

  test("reports the installed framework version", async () => {
    const frameworkPackageJson = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../package.json"), "utf8"),
    ) as { name: string; version: string };
    const metadata = await frameworkPackage();
    expect(metadata.name).toBe(frameworkPackageJson.name);
    expect(metadata.version).toBe(frameworkPackageJson.version);

    const result = await runCli(tempDir(), ["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(frameworkPackageJson.version);
  });

  test("forwards runtime flags to the development server", () => {
    const args = parseCliArgs([
      "dev",
      "--port",
      "4000",
      "--host",
      "0.0.0.0",
      "--data-dir",
      "/tmp/mubo-data",
      "--db",
      "/tmp/mubo.sqlite",
      "--static-dir",
      "assets",
      "--log-level",
      "debug",
      "--request-timeout",
      "1500",
      "--config",
      "mubo.config.ts",
      "--no-static",
      "--no-ws",
    ]);
    expect(devForwardedArgs(args)).toEqual([
      "--port=4000",
      "--host=0.0.0.0",
      "--data-dir=/tmp/mubo-data",
      "--db=/tmp/mubo.sqlite",
      "--static-dir=assets",
      "--log-level=debug",
      "--request-timeout=1500",
      "--config=mubo.config.ts",
      "--no-static",
      "--no-ws",
    ]);
    expect(devForwardedArgs(parseCliArgs(["dev"]))).toEqual([]);
  });

  test("dev forwards explicit boolean values for --no-static and --no-ws", () => {
    expect(devForwardedArgs(parseCliArgs(["dev", "--no-static=false", "--no-ws=0"]))).toEqual([
      "--no-static=false",
      "--no-ws=0",
    ]);
    expect(devForwardedArgs(parseCliArgs(["dev", "--no-static=true"]))).toEqual(["--no-static=true"]);
    expect(() => devForwardedArgs(parseCliArgs(["dev", "--no-ws=maybe"]))).toThrow(
      /Invalid boolean value for --no-ws/,
    );
  });

  test("dev rejects entry paths that are not files", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "entry-dir"));
    writeFileSync(join(cwd, "entry-dir", "package.json"), "{}");
    const result = await runCli(cwd, ["dev", "--entry", "entry-dir"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cannot find app entry: entry-dir");
  });

  test("compares Bun versions numerically", () => {
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.2")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("1.2.0", "1.2.1")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.2.3.4", "1.2.3")).toBe(1);
    expect(compareVersions("1.2.0-rc.1", "1.2.0")).toBe(0);
    expect(compareVersions("", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "")).toBe(1);
  });

  test("checks the minimum supported Bun version", () => {
    expect(satisfiesMinimumBunVersion("1.4.0")).toBe(true);
    expect(satisfiesMinimumBunVersion("1.4.1")).toBe(true);
    expect(satisfiesMinimumBunVersion("2.0.0")).toBe(true);
    expect(satisfiesMinimumBunVersion("1.2.0")).toBe(false);
    expect(satisfiesMinimumBunVersion("1.3.9")).toBe(false);
    expect(satisfiesMinimumBunVersion("1.2.0", "1.2.1")).toBe(false);
    expect(satisfiesMinimumBunVersion("1.2.1", "1.2.1")).toBe(true);
    expect(satisfiesMinimumBunVersion("1.3.0", "1.2.1")).toBe(true);
  });

  test("detects the application entry using the documented priority", () => {
    const cwd = tempDir();
    for (const candidate of ENTRY_CANDIDATES) {
      const absolute = resolve(cwd, candidate);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, "export default {};\n");
      expect(findEntry(cwd)).toBe(absolute);
      rmSync(absolute);
    }
    expect(() => findEntry(cwd)).toThrow(/Cannot find app entry/);
    expect(() => findEntry(cwd)).toThrow(/src\/server\/index\.ts/);
  });

  test("honours an explicit entry path", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "custom"), { recursive: true });
    const entry = join(cwd, "custom", "main.ts");
    writeFileSync(entry, "export default {};\n");
    expect(findEntry(cwd, "custom/main.ts")).toBe(entry);
    expect(findEntry(cwd, entry)).toBe(entry);
    expect(() => findEntry(cwd, "custom/missing.ts")).toThrow(
      /Cannot find app entry: custom\/missing\.ts/,
    );
  });

  test("exposes a minimum Bun version matching the package engines", () => {
    expect(MINIMUM_BUN_VERSION).toBe("1.4.0");
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
    const oddDir = await initProject("._odd-app_.", { cwd });
    const oddPkg = JSON.parse(readFileSync(join(oddDir, "package.json"), "utf8")) as { name: string };
    expect(oddPkg.name).toBe("odd-app");
    await expect(initProject("my-app", { cwd })).rejects.toThrow(/not empty/);
    await expect(initProject("my-app", { cwd, force: true })).resolves.toBe(dir);

    writeFileSync(join(cwd, "occupied"), "not a directory");
    await expect(initProject("occupied", { cwd })).rejects.toThrow(/not a directory/);
  });

  test("init generates a project whose sources parse without syntax errors", async () => {
    const cwd = tempDir();
    const dir = await initProject("parseable-app", { cwd });
    const transpiler = new Bun.Transpiler({ loader: "tsx" });
    for (const file of [
      "mubo.config.ts",
      "src/server/index.ts",
      "src/server/schema.ts",
      "src/server/schema.test.ts",
    ]) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(() => transpiler.scan(source)).not.toThrow();
    }
  });

  test("init points source checkouts at the local framework", () => {
    expect(muboDependencySpecifier(join("/tmp", "app"), join("/tmp", "framework"), "0.1.0")).toBe(
      "file:../framework",
    );
    // Without a readable version the published specifier falls back to the
    // framework's minimum supported version.
    expect(
      muboDependencySpecifier(join("/tmp", "app"), join("/tmp", "node_modules", "mubo")),
    ).toBe("^0.1.0");
    expect(
      muboDependencySpecifier(join("/tmp", "app"), join("/tmp", "node_modules", "mubo"), "1.2.3"),
    ).toBe("^1.2.3");
  });

  test("init depends on the published package when the CLI runs from node_modules", async () => {
    const cwd = tempDir();
    const installed = join(cwd, "node_modules", "mubo");
    mkdirSync(installed, { recursive: true });
    cpSync(join(frameworkRoot, "src"), join(installed, "src"), { recursive: true });
    cpSync(join(frameworkRoot, "package.json"), join(installed, "package.json"));
    const installedCli = join(installed, "src", "cli", "index.ts");

    const result = await runCli(cwd, ["init", "installed-app"], installedCli);
    expect(result.code).toBe(0);
    const pkg = JSON.parse(readFileSync(join(cwd, "installed-app", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    // The install directory of the package manager is a cache: generated
    // projects must depend on the published package instead.
    expect(pkg.dependencies.mubo).toBe("^0.1.0");
  });

  test("init generates a project that serves HTTP, WebSocket and static assets", async () => {
    const cwd = tempDir();
    const dir = await initProject("runnable-app", { cwd });
    const frameworkPath = framework.split("\\").join("/");
    for (const file of ["mubo.config.ts", "src/server/index.ts", "src/server/schema.ts"]) {
      const path = join(dir, file);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replaceAll('from "mubo"', `from ${JSON.stringify(frameworkPath)}`),
      );
    }

    const port = await freePort();
    const dataDir = join(cwd, "data");
    const proc = Bun.spawn(["bun", "src/server/index.ts"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MUBO_PORT: String(port),
        MUBO_HOST: "127.0.0.1",
        MUBO_DATA_DIR: dataDir,
        MUBO_LOG_LEVEL: "error",
      },
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      const health = await waitFor(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, app: "runnable-app" });

      const ready = await waitFor(`${base}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ ok: true });

      const hello = await fetch(`${base}/api/hello/world`);
      expect(hello.status).toBe(200);
      expect(await hello.json()).toMatchObject({ message: "Hello, world!" });

      const index = await fetch(`${base}/`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain("runnable-app");

      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const messages: Array<Record<string, unknown>> = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebSocket timeout")), 5000);
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          messages.push(message);
          if (message.type === "pong") {
            clearTimeout(timer);
            resolve();
          } else if (message.type === "welcome") {
            socket.send(JSON.stringify({ type: "ping", data: 1 }));
          }
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("WebSocket connection failed"));
        });
      });
      expect(messages.some((message) => message.type === "welcome")).toBe(true);
      expect(messages.find((message) => message.type === "pong")).toEqual({
        type: "pong",
        data: 1,
      });
      socket.close();

      const dbPath = join(dataDir, "mubo.sqlite");
      expect(existsSync(dbPath)).toBe(true);
      const db = new Database(dbPath);
      expect(
        db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get(),
      ).toBeTruthy();
      db.close();
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
    }
  }, 30_000);

  test("generated config treats empty HTTP environment values as unset", async () => {
    const cwd = tempDir();
    const dir = await initProject("empty-env-app", { cwd });
    const frameworkPath = framework.split("\\").join("/");
    for (const file of ["mubo.config.ts", "src/server/schema.ts"]) {
      const path = join(dir, file);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replaceAll('from "mubo"', `from ${JSON.stringify(frameworkPath)}`),
      );
    }

    const originalHost = process.env.MUBO_HOST;
    const originalPort = process.env.MUBO_PORT;
    process.env.MUBO_HOST = "   ";
    process.env.MUBO_PORT = "";
    try {
      const loaded = (await import(pathToFileURL(join(dir, "mubo.config.ts")).href)) as {
        default: Parameters<typeof resolveConfig>[0];
      };
      const config = resolveConfig(loaded.default, { env: {}, argv: [] });
      expect(config.http.host).toBe("127.0.0.1");
      expect(config.http.port).toBe(3000);
    } finally {
      if (originalHost === undefined) delete process.env.MUBO_HOST;
      else process.env.MUBO_HOST = originalHost;
      if (originalPort === undefined) delete process.env.MUBO_PORT;
      else process.env.MUBO_PORT = originalPort;
    }
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
    const names = checks.map((check) => check.name);
    expect(names).toEqual([
      "bun",
      "platform",
      "config",
      "data-dir",
      "sqlite",
      "port",
      "schema",
      "static",
    ]);
    expect(checks.find((check) => check.name === "bun")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "sqlite")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "data-dir")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "port")?.ok).toBe(true);
    // The temporary project has no public directory, so disk assets are missing.
    expect(checks.find((check) => check.name === "static")?.ok).toBe(false);
  });

  test("doctor reports the configured static asset source", async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "public"), { recursive: true });
    const withDir = await runCli(cwd, ["doctor", "--json", "--data-dir", join(cwd, "data"), "--port", "0"]);
    const dirChecks = JSON.parse(withDir.stdout) as Array<{ name: string; ok: boolean; detail: string }>;
    const staticDir = dirChecks.find((check) => check.name === "static");
    expect(staticDir?.ok).toBe(true);
    expect(staticDir?.detail).toContain(join(cwd, "public"));

    const importPath = framework.split("\\").join("/");
    writeFileSync(
      join(cwd, "mubo.config.ts"),
      `import { defineConfig } from ${JSON.stringify(importPath)};
export default defineConfig({
  app: { name: "cli-static-doctor", env: "test" },
  db: { path: ":memory:" },
  http: { port: 0 },
  static: { mode: "off" },
  log: { level: "error" },
});
`,
    );
    const disabled = await runCli(cwd, ["doctor", "--json", "--data-dir", join(cwd, "data"), "--port", "0"]);
    const disabledChecks = JSON.parse(disabled.stdout) as Array<{ name: string; ok: boolean; detail: string }>;
    const disabledStatic = disabledChecks.find((check) => check.name === "static");
    expect(disabledStatic?.ok).toBe(true);
    expect(disabledStatic?.detail).toBe("disabled");
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

  test("migrate --check on fresh database reports pending migrations", async () => {
    const cwd = tempDir();
    const dbPath = join(cwd, "app.sqlite");
    writeFileSync(join(cwd, "mubo.config.ts"), configSource(dbPath, false));
    const checked = await runCli(cwd, ["migrate", "--check"]);
    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain("pending migration");
    const checkDb = new Database(dbPath);
    expect(
      checkDb.query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get(),
    ).toBeNull();
    checkDb.close();
  });

  test("migrate --check after prior migrations applies reports up to date", async () => {
    const cwd = tempDir();
    const dbPath = join(cwd, "app.sqlite");
    writeFileSync(join(cwd, "mubo.config.ts"), configSource(dbPath, false));
    await runCli(cwd, ["migrate"]);  // apply mode creates users table
    const checked = await runCli(cwd, ["migrate", "--check"]);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("up to date");
    const checkDb = new Database(dbPath);
    checkDb.close();
  });

  test("doctor reports invalid configuration instead of crashing", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "mubo.config.ts"), "export default { http: { port: 99999 } };\n");
    const result = await runCli(cwd, ["doctor", "--json"]);
    expect(result.code).toBe(1);
    const checks = JSON.parse(result.stdout) as Array<{ name: string; ok: boolean; detail: string }>;
    const config = checks.find((check) => check.name === "config");
    expect(config?.ok).toBe(false);
    expect(config?.detail).toContain("Invalid HTTP port");
  });

  test("doctor reports a missing config file instead of crashing", async () => {
    const cwd = tempDir();
    const result = await runCli(cwd, ["doctor", "--json", "--config", "missing.config.ts"]);
    expect(result.code).toBe(1);
    const checks = JSON.parse(result.stdout) as Array<{ name: string; ok: boolean; detail: string }>;
    const config = checks.find((check) => check.name === "config");
    expect(config?.ok).toBe(false);
    expect(config?.detail).toContain("Config file not found");
  });

  test("parses --no-ws with empty string as missing value", async () => {
    const parsed = parseCliArgs(["--no-ws="]);
    expect(() => boolFlag(parsed, "no-ws")).toThrow(/Missing value for --no-ws/);
  });

  test("parses --no-static with empty string as missing value", async () => {
    const parsed = parseCliArgs(["--no-static="]);
    expect(() => boolFlag(parsed, "no-static")).toThrow(/Missing value for --no-static/);
  });

  test("treats flag set to true as enabling that flag", () => {
    const parsed = parseCliArgs(["--no-ws=true"]);
    expect(boolFlag(parsed, "no-ws")).toBe(true);
  });

  test("treats flag set to 1 as enabling that flag", () => {
    const parsed = parseCliArgs(["--no-static=1"]);
    expect(boolFlag(parsed, "no-static")).toBe(true);
  });

  test("treats flag set to on as enabling that flag", () => {
    const parsed = parseCliArgs(["--no-ws=on"]);
    expect(boolFlag(parsed, "no-ws")).toBe(true);
  });

  test("treats flag set to yes as enabling that flag", () => {
    const parsed = parseCliArgs(["--no-static=yes"]);
    expect(boolFlag(parsed, "no-static")).toBe(true);
  });

  test("treats flag set to TRUE as enabling that flag", () => {
    const parsed = parseCliArgs(["--no-ws=TRUE"]);
    expect(boolFlag(parsed, "no-ws")).toBe(true);
  });

  test("treats flag set to YES as enabling that flag", () => {
    const parsed = parseCliArgs(["--no-static=YES"]);
    expect(boolFlag(parsed, "no-static")).toBe(true);
  });

  test("handles whitespace in boolean flag values", () => {
    const parsed = parseCliArgs(["--no-ws= true "]);
    expect(boolFlag(parsed, "no-ws")).toBe(true);
  });

  test("throws for flag with whitespace-only value", () => {
    const parsed = parseCliArgs(["--no-ws=   "]);
    expect(() => boolFlag(parsed, "no-ws")).toThrow(/Missing value for --no-ws/);
  });

  test("treats non-boolean flag values as strings", () => {
    const parsed = parseCliArgs(["--custom-flag=value"]);
    expect(parsed.flags.get("custom-flag")).toBe("value");
  });

  test("handles flags without values when followed by another flag", () => {
    const parsed = parseCliArgs(["--flag1", "--flag2=value"]);
    expect(parsed.flags.get("flag1")).toBe(true);
    expect(parsed.flags.get("flag2")).toBe("value");
  });

  test("handles help flag in various forms", () => {
    const help1 = parseCliArgs(["--help"]);
    expect(help1.flags.get("help")).toBe(true);

    const help2 = parseCliArgs(["--help=1"]);
    expect(help2.flags.get("help")).toBe("1");

    const help3 = parseCliArgs(["--help=true"]);
    expect(help3.flags.get("help")).toBe("true");
  });
});

test("cli help output contains key sections", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "mubo.config.ts"), `export default { app: { name: "test" } };\n`);
  const result = await runCli(cwd, ["--help"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Usage:");
  expect(result.stdout).toContain("mubo init");
  expect(result.stdout).toContain("Environment:");
});

test("cli parseCliArgs with dash-dash separator", () => {
  const parsed = parseCliArgs(["build", "--", "--port", "4000"]);
  expect(parsed.command).toBe("build");
  expect(parsed.positionals).toEqual(["--port", "4000"]);
  expect(parsed.flags.size).toBe(0);
});

test("cli parseCliArgs captures positionals correctly", () => {
  const parsed = parseCliArgs(["init", "my-app", "--force"]);
  expect(parsed.command).toBe("init");
  expect(parsed.positionals).toEqual(["my-app"]);
  expect(parsed.flags.get("force")).toBe(true);
});

test("cli parseCliArgs with boolean flags", () => {
  const parsed = parseCliArgs(["dev", "--json=true", "--host=127.0.0.1"]);
  expect(boolFlag(parsed, "json")).toBe(true);
  expect(stringFlag(parsed, "host")).toBe("127.0.0.1");
});

test("cli resolveConfig with environment variables", () => {
  const config = resolveConfig({}, {
    cwd: tempDir(),
    env: { MUBO_PORT: "4321", MUBO_HOST: "0.0.0.0" },
    argv: [],
  });
  expect(config.http.port).toBe(4321);
  expect(config.http.host).toBe("0.0.0.0");
});

test("cli resolveConfig defaults", () => {
  const config = resolveConfig({}, {
    cwd: tempDir(),
    env: {},
    argv: [],
  });
  expect(config.app.name).toBe("mubo-app");
  expect(config.http.port).toBe(3000);
  expect(config.http.host).toBe("127.0.0.1");
  expect(config.db.path).not.toBeUndefined();
});

test("cli loadAndResolveConfig with file", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "mubo.config.ts"), `export default { app: { name: "from-file" } };\n`);
  const config = await loadAndResolveConfig({}, { cwd, loadFile: true, env: {}, argv: [] });
  expect(config.app.name).toBe("from-file");
});

test("cli loadAndResolveConfig with overrides", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "mubo.config.ts"), `export default { app: { name: "default" } };\n`);
  const config = await loadAndResolveConfig(
    { app: { name: "overridden" } },
    { cwd, loadFile: true, env: {}, argv: [] }
  );
  expect(config.app.name).toBe("overridden");
});
