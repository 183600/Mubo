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
import { boolFlag, stringFlag } from "./args.ts";
import { findEntry } from "./project.ts";

export interface CommandContext {
  cwd: string;
  args: CliArgs;
}

async function projectConfig(context: CommandContext): Promise<ResolvedMuboConfig> {
  return loadAndResolveConfig(
    {},
    {
      cwd: context.cwd,
      loadFile: true,
      configFile: stringFlag(context.args, "config"),
      argv: process.argv.slice(2),
    },
  );
}

export async function devCommand(context: CommandContext): Promise<void> {
  const entry = findEntry(context.cwd, stringFlag(context.args, "entry"));
  const forwarded: string[] = [];
  for (const name of ["port", "host", "data-dir", "db", "static-dir", "log-level", "config"]) {
    const value = stringFlag(context.args, name);
    if (value !== undefined) forwarded.push(`--${name}=${value}`);
  }
  for (const name of ["no-static", "no-ws"]) {
    if (boolFlag(context.args, name)) forwarded.push(`--${name}`);
  }
  console.log(`[mubo] watching ${entry}`);
  const proc = Bun.spawn(["bun", "--watch", entry, ...forwarded], {
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
  config.db.migrations.mode = boolFlag(context.args, "check") ? "check" : "apply";
  const db = new MuboDatabase({
    path: config.db.path,
    dataDir: config.dataDir,
    wal: config.db.wal,
    busyTimeoutMs: config.db.busyTimeoutMs,
    foreignKeys: config.db.foreignKeys,
    slowQueryMs: config.db.slowQueryMs,
    schema: config.schema,
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
  try {
    mkdirSync(path, { recursive: true });
    const probe = join(path, `.mubo-doctor-${process.pid}-${Date.now()}`);
    await Bun.write(probe, "ok");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

type DoctorCheck = { name: string; ok: boolean; detail: string; fatal?: boolean };

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
  checks.push({ name: "bun", ok: true, detail: `${Bun.version} (${Bun.revision.slice(0, 12)})`, fatal: true });
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
      dbOk = Boolean(db.query("SELECT 1 AS ok").get());
      db.close();
    } else {
      const parent = dirname(config.db.path);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      const probe = join(parent, `.mubo-doctor-db-${process.pid}-${Date.now()}`);
      await Bun.write(probe, "");
      rmSync(probe, { force: true });
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

  reportDoctorChecks(checks, json);
}