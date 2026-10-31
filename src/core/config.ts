import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { MuboSchema } from "../db/schema.ts";
import { MuboError } from "./errors.ts";
import { isLogLevel, type LogLevel } from "./logger.ts";

export interface CorsConfig {
  origin: string[] | "*";
  credentials?: boolean;
  maxAgeSeconds?: number;
}

export interface MuboConfig {
  app?: {
    name?: string;
    env?: "development" | "production" | "test";
  };
  dataDir?: string;
  schema?: MuboSchema;
  http?: {
    host?: string;
    port?: number;
    trustProxy?: boolean;
    cors?: false | CorsConfig;
    bodyLimit?: number;
  };
  db?: {
    path?: string;
    wal?: boolean;
    busyTimeoutMs?: number;
    foreignKeys?: boolean;
    slowQueryMs?: number;
    migrations?: {
      mode?: "apply" | "check" | "off";
      safeOnly?: boolean;
      table?: string;
      lock?: "file" | "sqlite";
    };
  };
  static?: {
    mode?: "embedded" | "disk" | "off";
    dir?: string;
    spaFallback?: boolean;
    assets?: EmbeddedAssets;
    cache?: {
      immutableExtensions?: string[];
      defaultMaxAgeSeconds?: number;
    };
  };
  ws?: {
    enabled?: boolean;
    maxPayloadBytes?: number;
    heartbeat?: { intervalMs?: number; timeoutMs?: number };
  };
  log?: {
    level?: LogLevel;
    json?: boolean;
  };
}

export interface EmbeddedAsset {
  data: string | Uint8Array | ArrayBuffer;
  encoding?: "base64" | "utf8";
  type?: string;
  etag?: string;
}

export type EmbeddedAssets = Record<string, EmbeddedAsset | string | Uint8Array | ArrayBuffer>;

export interface ResolvedMuboConfig {
  app: { name: string; env: "development" | "production" | "test" };
  dataDir: string;
  schema?: MuboSchema;
  http: {
    host: string;
    port: number;
    trustProxy: boolean;
    cors: false | CorsConfig;
    bodyLimit: number;
  };
  db: {
    path: string;
    wal: boolean;
    busyTimeoutMs: number;
    foreignKeys: boolean;
    slowQueryMs: number;
    migrations: {
      mode: "apply" | "check" | "off";
      safeOnly: boolean;
      table: string;
      lock: "file" | "sqlite";
    };
  };
  static: {
    mode: "embedded" | "disk" | "off";
    dir: string;
    spaFallback: boolean;
    assets?: EmbeddedAssets;
    cache: {
      immutableExtensions: string[];
      defaultMaxAgeSeconds: number;
    };
  };
  ws: {
    enabled: boolean;
    maxPayloadBytes: number;
    heartbeat: { intervalMs: number; timeoutMs: number };
  };
  log: { level: LogLevel; json: boolean };
}

export interface ResolveConfigOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  argv?: string[];
  /** Load `mubo.config.*` from cwd before applying overrides. */
  loadFile?: boolean;
  configFile?: string;
}

export const DEFAULT_IMMUTABLE_EXTENSIONS = [
  "js",
  "mjs",
  "css",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "mp4",
  "webm",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireSection(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new MuboError("CONFIG_ERROR", `Invalid ${name} configuration`);
  }
  return value;
}

function requireBoolean(name: string, value: unknown): void {
  if (typeof value !== "boolean") {
    throw new MuboError("CONFIG_ERROR", `Invalid ${name} setting`);
  }
}

function requireString(name: string, value: unknown): void {
  if (typeof value !== "string") {
    throw new MuboError("CONFIG_ERROR", `Invalid ${name} setting`);
  }
}

export function mergeConfig<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = Object.hasOwn(result, key) ? result[key] : undefined;
    const merged = isPlainObject(current) && isPlainObject(value) ? mergeConfig(current, value) : value;
    Object.defineProperty(result, key, {
      value: merged,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result as T;
}

function readNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new MuboError("CONFIG_ERROR", `${name} must be a number`);
  return parsed;
}

function readBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new MuboError("CONFIG_ERROR", `Invalid boolean value: ${value}`);
}

const APP_ENVIRONMENTS = ["development", "production", "test"] as const;
const MIGRATION_MODES = ["apply", "check", "off"] as const;
const STATIC_MODES = ["embedded", "disk", "off"] as const;

function readChoice<T extends string>(
  value: string | undefined,
  label: string,
  allowed: readonly T[],
): T | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!(allowed as readonly string[]).includes(trimmed)) {
    throw new MuboError(
      "CONFIG_ERROR",
      `Invalid ${label}: ${trimmed} (expected ${allowed.join(", ")})`,
    );
  }
  return trimmed as T;
}

function requireChoice(name: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new MuboError("CONFIG_ERROR", `Invalid ${name}: ${String(value)}`);
  }
}

function resolveEnvironment(env: Record<string, string | undefined>): string | undefined {
  const explicit = readChoice(env.MUBO_ENV, "MUBO_ENV", APP_ENVIRONMENTS);
  if (explicit) return explicit;
  const nodeEnv = env.NODE_ENV?.trim();
  if ((APP_ENVIRONMENTS as readonly string[]).includes(nodeEnv ?? "")) return nodeEnv;
  return undefined;
}

function argvOverrides(argv: string[]): MuboConfig {
  const result: MuboConfig = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") break;
    if (token === undefined || !token.startsWith("--")) continue;
    const equal = token.indexOf("=");
    const name = equal === -1 ? token.slice(2) : token.slice(2, equal);
    const inline = equal === -1 ? undefined : token.slice(equal + 1);
    const next = (flagName: string): string => {
      const value = inline !== undefined ? inline : argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new MuboError("CONFIG_ERROR", `Missing value for --${flagName}`);
      }
      if (inline === undefined) i++;
      return value;
    };
    switch (name) {
      case "data-dir":
        result.dataDir = next(name);
        break;
      case "port":
        result.http = { ...result.http, port: readNumber(next(name), "--port") };
        break;
      case "host":
        result.http = { ...result.http, host: next(name) };
        break;
      case "db":
        result.db = { ...result.db, path: next(name) };
        break;
      case "static-dir":
        result.static = { ...result.static, dir: next(name) };
        break;
      case "log-level": {
        const level = next(name);
        if (!isLogLevel(level)) {
          throw new MuboError("CONFIG_ERROR", `Invalid log level: ${level}`);
        }
        result.log = { ...result.log, level };
        break;
      }
      case "no-static": {
        if (inline === undefined) {
          result.static = { ...result.static, mode: "off" };
          break;
        }
        const enabled = readBoolean(inline);
        if (enabled === undefined) {
          throw new MuboError("CONFIG_ERROR", "Missing value for --no-static");
        }
        if (enabled) result.static = { ...result.static, mode: "off" };
        break;
      }
      case "no-ws": {
        if (inline === undefined) {
          result.ws = { ...result.ws, enabled: false };
          break;
        }
        const enabled = readBoolean(inline);
        if (enabled === undefined) {
          throw new MuboError("CONFIG_ERROR", "Missing value for --no-ws");
        }
        if (enabled) result.ws = { ...result.ws, enabled: false };
        break;
      }
      default:
        break;
    }
  }
  return result;
}

function envOverrides(env: Record<string, string | undefined>): MuboConfig {
  const result: MuboConfig = {};
  const set = <K extends keyof MuboConfig>(key: K, value: MuboConfig[K]) => {
    if (value !== undefined) result[key] = value;
  };

  const envName = resolveEnvironment(env);
  const app: NonNullable<MuboConfig["app"]> = {};
  const appName = env.MUBO_APP_NAME?.trim();
  if (appName) app.name = appName;
  if (envName !== undefined) app.env = envName as "development" | "production" | "test";
  if (Object.keys(app).length > 0) set("app", app);
  const dataDir = env.MUBO_DATA_DIR?.trim();
  if (dataDir) result.dataDir = dataDir;

  const port = readNumber(env.MUBO_PORT, "MUBO_PORT");
  const host = env.MUBO_HOST?.trim() || undefined;
  const bodyLimit = readNumber(env.MUBO_BODY_LIMIT, "MUBO_BODY_LIMIT");
  if (port !== undefined || host !== undefined || bodyLimit !== undefined) {
    result.http = { port, host, bodyLimit };
  }

  const dbPath = env.MUBO_DB_PATH?.trim() || undefined;
  const busyTimeoutMs = readNumber(env.MUBO_BUSY_TIMEOUT_MS, "MUBO_BUSY_TIMEOUT_MS");
  const migrationMode = readChoice(env.MUBO_MIGRATIONS_MODE, "MUBO_MIGRATIONS_MODE", MIGRATION_MODES);
  const migrationTable = env.MUBO_MIGRATIONS_TABLE?.trim() || undefined;
  const safeOnly = readBoolean(env.MUBO_MIGRATIONS_SAFE_ONLY);
  if (dbPath || busyTimeoutMs !== undefined || migrationMode || migrationTable || safeOnly !== undefined) {
    result.db = {
      path: dbPath,
      busyTimeoutMs,
      migrations: {
        mode: migrationMode,
        table: migrationTable,
        safeOnly,
      },
    };
  }

  const staticMode = readChoice(env.MUBO_STATIC_MODE, "MUBO_STATIC_MODE", STATIC_MODES);
  const staticDir = env.MUBO_STATIC_DIR?.trim() || undefined;
  const spaFallback = readBoolean(env.MUBO_STATIC_SPA_FALLBACK);
  if (staticMode || staticDir || spaFallback !== undefined) {
    result.static = {
      mode: staticMode,
      dir: staticDir,
      spaFallback,
    };
  }

  const wsEnabled = readBoolean(env.MUBO_WS_ENABLED);
  const wsMaxPayload = readNumber(env.MUBO_WS_MAX_PAYLOAD, "MUBO_WS_MAX_PAYLOAD");
  if (wsEnabled !== undefined || wsMaxPayload !== undefined) {
    result.ws = { enabled: wsEnabled, maxPayloadBytes: wsMaxPayload };
  }

  const logLevel = env.MUBO_LOG_LEVEL?.trim() || undefined;
  const logJson = readBoolean(env.MUBO_LOG_JSON);
  if (logLevel !== undefined && !isLogLevel(logLevel)) {
    throw new MuboError("CONFIG_ERROR", `Invalid MUBO_LOG_LEVEL: ${logLevel}`);
  }
  if (logLevel !== undefined || logJson !== undefined) {
    result.log = {
      level: logLevel !== undefined && isLogLevel(logLevel) ? logLevel : undefined,
      json: logJson,
    };
  }
  return result;
}

export function sanitizeAppName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64)
    .replace(/[.-]+$/g, "");
  return cleaned || "mubo-app";
}

function requireInteger(
  name: string,
  value: number,
  constraints: { min?: number; exclusiveMin?: number; max?: number } = {},
): void {
  if (!Number.isInteger(value)) {
    throw new MuboError("CONFIG_ERROR", `Invalid ${name}: ${value}`);
  }
  if (constraints.min !== undefined && value < constraints.min) {
    throw new MuboError("CONFIG_ERROR", `Invalid ${name}: ${value} (must be >= ${constraints.min})`);
  }
  if (constraints.exclusiveMin !== undefined && value <= constraints.exclusiveMin) {
    throw new MuboError(
      "CONFIG_ERROR",
      `Invalid ${name}: ${value} (must be > ${constraints.exclusiveMin})`,
    );
  }
  if (constraints.max !== undefined && value > constraints.max) {
    throw new MuboError("CONFIG_ERROR", `Invalid ${name}: ${value} (must be <= ${constraints.max})`);
  }
}

export function defaultDataDir(appName: string, env: Record<string, string | undefined> = process.env): string {
  const name = sanitizeAppName(appName);
  const home = env.HOME || env.USERPROFILE || homedir();
  if (process.platform === "win32") {
    const base = env.APPDATA || join(home, "AppData", "Roaming");
    return join(base, "Mubo", name);
  }
  return join(home, ".mubo", name);
}

const configRequire = createRequire(import.meta.url);

export async function loadConfigFile(
  cwd: string,
  explicitFile?: string,
): Promise<{ config: MuboConfig; path?: string }> {
  const base = resolve(cwd);
  const candidates = explicitFile
    ? [isAbsolute(explicitFile) ? explicitFile : resolve(base, explicitFile)]
    : ["mubo.config.ts", "mubo.config.js", "mubo.config.mjs"].map((file) => join(base, file));

  for (const candidate of candidates) {
    if (!(await Bun.file(candidate).exists())) continue;
    try {
      const resolved = configRequire.resolve(candidate);
      delete configRequire.cache[resolved];
      const module = configRequire(resolved) as { default?: MuboConfig };
      if (!isPlainObject(module.default)) {
        throw new Error("config file must have a default export object");
      }
      return { config: module.default, path: candidate };
    } catch (error) {
      throw new MuboError("CONFIG_ERROR", `Failed to load config file ${candidate}`, { cause: error });
    }
  }
  if (explicitFile) {
    throw new MuboError("CONFIG_ERROR", `Config file not found: ${explicitFile}`);
  }
  return { config: {} };
}

export function resolveConfig(
  overrides: MuboConfig = {},
  options: ResolveConfigOptions & { fileConfig?: MuboConfig } = {},
): ResolvedMuboConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const envName = resolveEnvironment(env);
  const appEnv: "development" | "production" | "test" =
    envName === "production" || envName === "test" ? envName : "development";

  const defaults: ResolvedMuboConfig = {
    app: { name: "mubo-app", env: appEnv },
    dataDir: "",
    http: {
      host: "127.0.0.1",
      port: 3000,
      trustProxy: false,
      cors: false,
      bodyLimit: 1024 * 1024,
    },
    db: {
      path: "",
      wal: true,
      busyTimeoutMs: 5000,
      foreignKeys: true,
      slowQueryMs: 200,
      migrations: { mode: "apply", safeOnly: true, table: "_mubo_migrations", lock: "sqlite" },
    },
    static: {
      mode: "disk",
      dir: join(cwd, "public"),
      spaFallback: true,
      cache: { immutableExtensions: [...DEFAULT_IMMUTABLE_EXTENSIONS], defaultMaxAgeSeconds: 3600 },
    },
    ws: {
      enabled: true,
      maxPayloadBytes: 1024 * 1024,
      heartbeat: { intervalMs: 30_000, timeoutMs: 60_000 },
    },
    log: { level: "info", json: appEnv === "production" },
  };

  const rawLogJson = env.MUBO_LOG_JSON?.trim();
  const logJsonConfigured =
    options.fileConfig?.log?.json !== undefined ||
    overrides.log?.json !== undefined ||
    (rawLogJson !== undefined && rawLogJson !== "");
  const merged = mergeConfig(
    mergeConfig(mergeConfig(defaults as unknown, options.fileConfig ?? {}), overrides as unknown),
    mergeConfig(envOverrides(env) as unknown, argvOverrides(options.argv ?? process.argv.slice(2)) as unknown),
  ) as ResolvedMuboConfig;

  requireSection(merged.app, "app");
  requireSection(merged.http, "HTTP");
  requireSection(merged.db, "database");
  requireSection(merged.db.migrations, "migrations");
  requireSection(merged.static, "static");
  requireSection(merged.static.cache, "static cache");
  requireSection(merged.ws, "WebSocket");
  requireSection(merged.ws.heartbeat, "WebSocket heartbeat");
  requireSection(merged.log, "log");

  requireBoolean("trust proxy", merged.http.trustProxy);
  requireBoolean("database WAL", merged.db.wal);
  requireBoolean("database foreign keys", merged.db.foreignKeys);
  requireBoolean("safeOnly migrations", merged.db.migrations.safeOnly);
  requireBoolean("static SPA fallback", merged.static.spaFallback);
  requireBoolean("WebSocket enabled", merged.ws.enabled);
  requireBoolean("JSON logging", merged.log.json);

  requireString("app name", merged.app.name);
  requireString("data directory", merged.dataDir);
  requireString("database path", merged.db.path);
  requireString("migrations table", merged.db.migrations.table);
  requireString("static directory", merged.static.dir);

  merged.dataDir = merged.dataDir.trim();
  merged.db.path = merged.db.path.trim();
  merged.db.migrations.table = merged.db.migrations.table.trim();
  merged.static.dir = merged.static.dir.trim();

  const immutableExtensions = merged.static.cache.immutableExtensions;
  if (
    !Array.isArray(immutableExtensions) ||
    immutableExtensions.some(
      (extension) =>
        typeof extension !== "string" ||
        extension.trim().replace(/^\.+/, "").length === 0,
    )
  ) {
    throw new MuboError("CONFIG_ERROR", "Invalid immutable extensions setting");
  }
  merged.static.cache.immutableExtensions = immutableExtensions.map((extension) =>
    extension.trim().replace(/^\.+/, "").toLowerCase(),
  );

  if (!logJsonConfigured) merged.log.json = merged.app.env === "production";
  requireChoice("app environment", merged.app.env, APP_ENVIRONMENTS);
  requireChoice("log level", merged.log.level, ["debug", "info", "warn", "error"]);
  requireChoice("migrations mode", merged.db.migrations.mode, MIGRATION_MODES);
  requireChoice("migrations lock", merged.db.migrations.lock, ["file", "sqlite"]);
  requireChoice("static mode", merged.static.mode, STATIC_MODES);
  if (merged.http.cors !== false) {
    const cors = merged.http.cors as unknown;
    if (typeof cors !== "object" || cors === null || Array.isArray(cors)) {
      throw new MuboError("CONFIG_ERROR", "Invalid CORS configuration");
    }
    const origin = (cors as { origin?: unknown }).origin;
    if (
      origin !== "*" &&
      (!Array.isArray(origin) ||
        origin.length === 0 ||
        origin.some((value) => typeof value !== "string" || value.trim().length === 0))
    ) {
      throw new MuboError(
        "CONFIG_ERROR",
        'Invalid CORS origin: expected "*" or a non-empty array of strings',
      );
    }
    if (
      (cors as { credentials?: unknown }).credentials !== undefined &&
      typeof (cors as { credentials?: unknown }).credentials !== "boolean"
    ) {
      throw new MuboError("CONFIG_ERROR", "Invalid CORS credentials setting");
    }
    if (Array.isArray(origin)) {
      merged.http.cors = {
        ...(merged.http.cors as CorsConfig),
        origin: origin.map((value) => (value as string).trim()),
      };
    }
  }
  merged.app.name = sanitizeAppName(merged.app.name);
  merged.dataDir = resolve(cwd, merged.dataDir || defaultDataDir(merged.app.name, env));
  if (!merged.db.path) merged.db.path = join(merged.dataDir, "mubo.sqlite");
  else if (merged.db.path !== ":memory:" && !isAbsolute(merged.db.path)) {
    merged.db.path = resolve(cwd, merged.db.path);
  }
  if (!merged.static.dir) merged.static.dir = join(cwd, "public");
  else if (!isAbsolute(merged.static.dir)) merged.static.dir = resolve(cwd, merged.static.dir);
  if (typeof merged.http.host !== "string" || merged.http.host.trim().length === 0) {
    throw new MuboError("CONFIG_ERROR", `Invalid HTTP host: ${String(merged.http.host)}`);
  }
  merged.http.host = merged.http.host.trim();
  if (!Number.isInteger(merged.http.port) || merged.http.port < 0 || merged.http.port > 65535) {
    throw new MuboError("CONFIG_ERROR", `Invalid HTTP port: ${merged.http.port}`);
  }
  if (!Number.isInteger(merged.http.bodyLimit) || merged.http.bodyLimit <= 0) {
    throw new MuboError("CONFIG_ERROR", `Invalid body limit: ${merged.http.bodyLimit}`);
  }
  if (merged.http.cors && merged.http.cors.maxAgeSeconds !== undefined) {
    requireInteger("CORS max age", merged.http.cors.maxAgeSeconds, { min: 0 });
  }
  requireInteger("busy timeout", merged.db.busyTimeoutMs, { min: 0 });
  requireInteger("slow query threshold", merged.db.slowQueryMs, { min: 0 });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(merged.db.migrations.table)) {
    throw new MuboError("CONFIG_ERROR", `Invalid migrations table name: ${merged.db.migrations.table}`);
  }
  requireInteger("static max age", merged.static.cache.defaultMaxAgeSeconds, { min: 0 });
  requireInteger("WebSocket max payload", merged.ws.maxPayloadBytes, { exclusiveMin: 0 });
  requireInteger("WebSocket heartbeat interval", merged.ws.heartbeat.intervalMs, { min: 0 });
  requireInteger("WebSocket heartbeat timeout", merged.ws.heartbeat.timeoutMs, { exclusiveMin: 0 });
  return merged;
}

function configFileFromArgv(argv: string[]): string | undefined {
  let result: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") break;
    if (token === "--config") {
      const value = argv[index + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new MuboError("CONFIG_ERROR", "Missing value for --config");
      }
      result = value;
      index++;
    } else if (token.startsWith("--config=")) {
      const value = token.slice("--config=".length);
      if (!value) throw new MuboError("CONFIG_ERROR", "Missing value for --config");
      result = value;
    }
  }
  return result;
}

export async function loadAndResolveConfig(
  overrides: MuboConfig = {},
  options: ResolveConfigOptions = {},
): Promise<ResolvedMuboConfig> {
  const cwd = options.cwd ?? process.cwd();
  const argv = options.argv ?? process.argv.slice(2);
  const explicitFile = options.configFile ?? configFileFromArgv(argv);
  if (explicitFile === "") {
    throw new MuboError("CONFIG_ERROR", "Missing value for --config");
  }
  if (!options.loadFile && explicitFile === undefined) {
    return resolveConfig(overrides, { ...options, cwd, argv });
  }
  const { config: fileConfig } = await loadConfigFile(cwd, explicitFile);
  if (explicitFile !== undefined) {
    return resolveConfig(fileConfig, { ...options, cwd, argv, fileConfig: overrides });
  }
  return resolveConfig(overrides, { ...options, cwd, argv, fileConfig });
}

export function ensureDataDir(dbPath: string, dataDir: string): void {
  const dir = dbPath === ":memory:" ? dataDir : dirname(dbPath);
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw new MuboError("CONFIG_ERROR", `Cannot create data directory ${dir}`, { cause: error });
    }
  }
}

export function defineConfig<const T extends MuboConfig>(config: T): T {
  return config;
}
