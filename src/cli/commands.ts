import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  loadAndResolveConfig,
  loadConfigFile,
  type ResolvedMuboConfig,
} from "../core/config.ts";
import { MuboError } from "../core/errors.ts";
import { MuboDatabase } from "../db/database.ts";
import type { CliArgs } from "./args.ts";
import { boolFlag, stringFlag } from "./args.ts";

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

function findDevEntry(cwd: string, requested?: string): string {
  const candidates = requested
    ? [requested]
    : ["src/server/index.ts", "src/index.ts", "server.ts", "index.ts"];
  for (const candidate of candidates) {
    const path = resolve(cwd, candidate);
    if (existsSync(path)) return path;
  }
  throw new MuboError("CONFIG_ERROR", "Cannot find app entry (tried src/server/index.ts, src/index.ts)");
}

export async function devCommand(context: CommandContext): Promise<void> {
  const entry = findDevEntry(context.cwd, stringFlag(context.args, "entry"));
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

export async function doctorCommand(context: CommandContext): Promise<void> {
  const config = await projectConfig(context);
  const configInfo = await loadConfigFile(context.cwd, stringFlag(context.args, "config")).catch((error) => {
    throw error;
  });
  const checks: Array<{ name: string; ok: boolean; detail: string; fatal?: boolean }> = [];
  checks.push({ name: "bun", ok: true, detail: `${Bun.version} (${Bun.revision.slice(0, 12)})`, fatal: true });
  checks.push({
    name: "platform",
    ok: true,
    detail: `${process.platform} ${process.arch}`,
    fatal: true,
  });
  const configOk = Boolean(configInfo.path);
  checks.push({
    name: "config",
    ok: configOk,
    detail: configInfo.path ?? "mubo.config.* not found (using defaults)",
  });
  const dataWritable = await checkWritableDirectory(config.dataDir);
  checks.push({ name: "data-dir", ok: dataWritable, detail: config.dataDir, fatal: true });

  let dbOk = false;
  let dbDetail = config.db.path;
  try {
    if (config.db.path !== ":memory:") {
      const parent = dirname(config.db.path);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      const probe = join(parent, `.mubo-doctor-db-${process.pid}-${Date.now()}`);
      await Bun.write(probe, "");
      rmSync(probe, { force: true });
    }
    const db = new MuboDatabase({ path: ":memory:" });
    dbOk = db.ping();
    db.close();
  } catch (error) {
    dbDetail = error instanceof Error ? error.message : String(error);
  }
  checks.push({ name: "sqlite", ok: dbOk, detail: dbOk ? `${dbDetail} (writable)` : dbDetail, fatal: true });

  const portFree = await checkPort(config.http.host, config.http.port);
  checks.push({
    name: "port",
    ok: portFree,
    detail: `${config.http.host}:${config.http.port}${portFree ? " available" : " already in use"}`,
  });
  checks.push({
    name: "schema",
    ok: true,
    detail: `${Object.keys(config.schema?.tables ?? {}).length} table(s)`,
  });

  const json = boolFlag(context.args, "json");
  if (json) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    for (const check of checks) {
      console.log(`[${check.ok ? "ok" : "warn"}] ${check.name}: ${check.detail}`);
    }
  }
  if (checks.some((check) => check.fatal && !check.ok)) process.exitCode = 1;
}
