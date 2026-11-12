import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  loadAndResolveConfig,
  loadConfigFile,
  type ResolvedMuboConfig,
} from "../core/config.ts";
import { errorMessage, MuboError } from "../core/errors.ts";
import { MuboDatabase } from "../db/database.ts";
import { validateSchema } from "../db/migrations.ts";
import type { CliArgs } from "./args.ts";
import { boolFlag, cliArgsToArgv, stringFlag } from "./args.ts";
import { findEntry, MINIMUM_BUN_VERSION, satisfiesMinimumBunVersion } from "./project.ts";

export interface CommandContext {
  cwd: string;
  args: CliArgs;
  /** Overrides the process spawner; used by tests to observe the dev command. */
  spawn?: typeof Bun.spawn;
}

async function projectConfig(context: CommandContext): Promise<ResolvedMuboConfig> {
  return loadAndResolveConfig(
    {},
    {
      cwd: context.cwd,
      loadFile: true,
      configFile: stringFlag(context.args, "config"),
      argv: cliArgsToArgv(context.args),
    },
  );
}

/**
 * Builds the runtime flags forwarded to the development server process.
 *
 * The spawned application parses the same flags again, so every flag that
 * changes the runtime behaviour has to be part of this list.
 */
export function devForwardedArgs(args: CliArgs): string[] {
  const forwarded: string[] = [];
  for (const name of [
    "port",
    "host",
    "data-dir",
    "db",
    "static-dir",
    "log-level",
    "request-timeout",
    "config",
  ]) {
    const value = stringFlag(args, name);
    if (value !== undefined) forwarded.push(`--${name}=${value}`);
  }
  for (const name of ["no-static", "no-ws"]) {
    const value = args.flags.get(name);
    if (value === undefined) continue;
    // Validate the value and keep the explicit form, so `--no-static=false`
    // still re-enables static assets in the spawned process.
    boolFlag(args, name);
    forwarded.push(value === true ? `--${name}` : `--${name}=${value}`);
  }
  return forwarded;
}

export async function devCommand(context: CommandContext): Promise<void> {
  const entry = findEntry(context.cwd, stringFlag(context.args, "entry"));
  const forwarded = devForwardedArgs(context.args);
  console.log(`[mubo] watching ${entry}`);
  const spawn = context.spawn ?? Bun.spawn;
  const proc = spawn(["bun", "--watch", entry, ...forwarded], {
    cwd: context.cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) process.exitCode = code;
}

export async function migrateCommand(context: CommandContext): Promise<void> {
  const config = await projectConfig(context);
  // An explicit `mubo migrate` run applies pending migrations unless the
  // project disabled migrations altogether; `--check` only inspects. Forcing
  // "apply" for mode "off" would silently ignore MUBO_MIGRATIONS_MODE=off.
  if (boolFlag(context.args, "check")) config.db.migrations.mode = "check";
  else if (config.db.migrations.mode !== "off") config.db.migrations.mode = "apply";
  const db = new MuboDatabase({
    path: config.db.path,
    dataDir: config.dataDir,
    wal: config.db.wal,
    busyTimeoutMs: config.db.busyTimeoutMs,
    foreignKeys: config.db.foreignKeys,
    slowQueryMs: config.db.slowQueryMs,
    schema: config.schema,
    migrations: config.db.migrations,
  });
  try {
    const result = await db.migrate(config.schema ?? { tables: {} }, config.db.migrations);
    if (result.status === "applied") {
      console.log(`[mubo] applied migration ${result.id}`);
      for (const change of result.changes) console.log(`  - ${change}`);
    } else if (result.status === "pending") {
      console.log(`[mubo] pending migration ${result.id}`);
      for (const change of result.changes) console.log(`  - ${change}`);
      process.exitCode = 1;
    } else if (result.status === "off") {
      console.log("[mubo] migrations are disabled (mode=off)");
    } else {
      console.log("[mubo] database is up to date");
    }
  } finally {
    db.close();
  }
}

async function checkPort(host: string, port: number): Promise<boolean> {
  if (port === 0) return true;
  try {
    const listener = Bun.listen({
      hostname: host,
      port,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    });
    listener.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function checkWritableDirectory(path: string): Promise<boolean> {
  // Use a unique name: concurrent diagnostics in the same process must not
  // delete each other's probe file (the same reason readiness checks in
  // MuboApp use a UUID rather than a timestamp).
  const probe = join(path, `.mubo-doctor-${process.pid}-${crypto.randomUUID()}`);
  try {
    mkdirSync(path, { recursive: true });
    await Bun.write(probe, "ok");
    return true;
  } catch {
    return false;
  } finally {
    // Clean up the probe even when the write itself failed; otherwise a
    // partial write leaves a `.mubo-doctor-*` file behind.
    try {
      rmSync(probe, { force: true });
    } catch {
      // The probe may already be gone; the writability result stands.
    }
  }
}

type DoctorCheck = { name: string; ok: boolean; detail: string; fatal?: boolean };

/** Summarizes the configured static asset source for the doctor report. */
function describeStaticAssets(staticConfig: ResolvedMuboConfig["static"]): {
  ok: boolean;
  detail: string;
} {
  if (staticConfig.mode === "off") return { ok: true, detail: "disabled" };
  if (staticConfig.mode === "embedded") {
    const embedded = Object.keys(staticConfig.assets ?? {}).length;
    return {
      ok: true,
      detail: embedded > 0 ? `embedded (${embedded} asset(s) configured)` : "embedded (bundled at build time)",
    };
  }
  const exists = existsSync(staticConfig.dir);
  return {
    ok: exists,
    detail: exists ? staticConfig.dir : `${staticConfig.dir} (directory not found)`,
  };
}

function reportDoctorChecks(checks: DoctorCheck[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    for (const check of checks) {
      console.log(`[${check.ok ? "ok" : "warn"}] ${check.name}: ${check.detail}`);
    }
  }
  if (checks.some((check) => check.fatal && !check.ok)) process.exitCode = 1;
}

export async function doctorCommand(context: CommandContext): Promise<void> {
  const checks: DoctorCheck[] = [];
  const bunSupported = satisfiesMinimumBunVersion(Bun.version);
  checks.push({
    name: "bun",
    ok: bunSupported,
    detail: bunSupported
      ? `${Bun.version} (${Bun.revision.slice(0, 12)})`
      : `${Bun.version} is older than the required Bun ${MINIMUM_BUN_VERSION}`,
    fatal: true,
  });
  checks.push({
    name: "platform",
    ok: true,
    detail: `${process.platform} ${process.arch}`,
    fatal: true,
  });
  const json = boolFlag(context.args, "json");
  let config: ResolvedMuboConfig;
  let configPath: string | undefined;
  try {
    config = await projectConfig(context);
    configPath = (await loadConfigFile(context.cwd, stringFlag(context.args, "config"))).path;
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: errorMessage(error), fatal: true });
    reportDoctorChecks(checks, json);
    return;
  }
  const configOk = Boolean(configPath);
  checks.push({
    name: "config",
    ok: configOk,
    detail: configPath ?? "mubo.config.* not found (using defaults)",
  });
  const dataWritable = await checkWritableDirectory(config.dataDir);
  checks.push({ name: "data-dir", ok: dataWritable, detail: config.dataDir, fatal: true });

  let dbOk = false;
  let dbDetail = config.db.path;
  try {
    if (config.db.path === ":memory:") {
      const db = new Database(":memory:", { strict: true });
      try {
        dbOk = Boolean(db.query("SELECT 1 AS ok").get());
      } finally {
        db.close();
      }
    } else {
      const parent = dirname(config.db.path);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      const probe = join(parent, `.mubo-doctor-db-${process.pid}-${crypto.randomUUID()}`);
      try {
        await Bun.write(probe, "");
      } finally {
        // A failed or partial write must not leave a probe file behind, just
        // like the data directory probe in checkWritableDirectory().
        try {
          rmSync(probe, { force: true });
        } catch {
          // The probe may already be gone; the sqlite check below still runs.
        }
      }
      if (existsSync(config.db.path)) {
        const db = new Database(config.db.path, { create: false, strict: true });
        try {
          const result = db.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
          dbOk = result !== null && Object.values(result)[0] === "ok";
          if (!dbOk) dbDetail = `${config.db.path} (integrity check failed)`;
        } finally {
          db.close();
        }
      } else {
        dbOk = true;
      }
    }
  } catch (error) {
    dbDetail = errorMessage(error);
  }
  checks.push({ name: "sqlite", ok: dbOk, detail: dbOk ? `${dbDetail} (writable)` : dbDetail, fatal: true });

  const portFree = await checkPort(config.http.host, config.http.port);
  checks.push({
    name: "port",
    ok: portFree,
    detail: `${config.http.host}:${config.http.port}${portFree ? " available" : " already in use"}`,
  });
  let schemaOk = true;
  let schemaDetail = "no schema configured";
  if (config.schema) {
    try {
      validateSchema(config.schema);
      schemaDetail = `${Object.keys(config.schema.tables).length} table(s) valid`;
    } catch (error) {
      schemaOk = false;
      schemaDetail = errorMessage(error);
    }
  }
  checks.push({ name: "schema", ok: schemaOk, detail: schemaDetail, fatal: true });

  const staticDetail = describeStaticAssets(config.static);
  checks.push({ name: "static", ok: staticDetail.ok, detail: staticDetail.detail });

  if (config.http.requestTimeoutMs > 0) {
    checks.push({
      name: "http.requestTimeoutMs",
      ok: true,
      detail: `${config.http.requestTimeoutMs}ms`,
    });
  }
  if (config.http.rateLimit !== false) {
    checks.push({
      name: "http.rateLimit",
      ok: true,
      detail: `maxRequests=${config.http.rateLimit.maxRequests}, windowMs=${config.http.rateLimit.windowMs}`,
    });
  }
  if (config.ws.maxConnections > 0) {
    checks.push({
      name: "ws.maxConnections",
      ok: true,
      detail: `${config.ws.maxConnections}`,
    });
  }
  if (config.ws.maxConnectionsPerIp > 0) {
    checks.push({
      name: "ws.maxConnectionsPerIp",
      ok: true,
      detail: `${config.ws.maxConnectionsPerIp}`,
    });
  }

  reportDoctorChecks(checks, json);
}