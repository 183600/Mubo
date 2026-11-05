import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { MuboSchema } from "../db/schema.ts";
import { readClientIp } from "../utils/client-ip.ts";
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
    requestTimeoutMs?: number;
    rateLimit?: false | {
      maxRequests: number;
      windowMs: number;
      key?: (request: Request) => string;
    };
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
    maxConnections?: number;
    maxConnectionsPerIp?: number;
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
    requestTimeoutMs: number;
    rateLimit: false | {
      maxRequests: number;
      windowMs: number;
      key: (request: Request) => string;
    };
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
    maxConnections: number;
    maxConnectionsPerIp: number;
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

/**
 * Global key that holds the project configuration baked into a compiled
 * single-file application.
 */
export const BUILD_CONFIG_KEY = "__MUBO_BUILD_CONFIG__";

/**
 * Registers the project configuration that `mubo build` bakes into a compiled
 * application.
 *
 * Passing `undefined` removes the registered configuration again.
 */
export function registerBuildConfig(config: MuboConfig | undefined): void {
  const store = globalThis as Record<string, unknown>;
  if (config === undefined) delete store[BUILD_CONFIG_KEY];
  else store[BUILD_CONFIG_KEY] = config;
}

/**
 * Returns the project configuration baked into a compiled application.
 *
 * The value is `undefined` when the application was not compiled by `mubo
 * build`, which keeps regular development runs file based.
 */
export function getBuildConfig(): MuboConfig | undefined {
  const value = (globalThis as Record<string, unknown>)[BUILD_CONFIG_KEY];
  return isPlainObject(value) ? (value as MuboConfig) : undefined;
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

/** Normalizes a file extension for cache lookups: trimmed, without dots, lowercase. */
export function normalizeExtension(extension: string): string {
  return extension.trim().replace(/^\.+/, "").toLowerCase();
}

/** Checks whether a value is a file extension that can be used for cache rules. */
export function isValidExtension(value: unknown): value is string {
  return typeof value === "string" && normalizeExtension(value).length > 0;
}

/** Validates that a configuration section exists and is a plain object. */
function requireSection(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new MuboError("CONFIG_ERROR", `Invalid ${name} configuration`);
  }
  return value;
}

/** Validates a boolean configuration value. */
function requireBoolean(name: string, value: unknown): void {
  if (typeof value !== "boolean") {
    throw new MuboError("CONFIG_ERROR", `Invalid ${name} setting`);
  }
}

/** Validates a string configuration value. */
function requireString(name: string, value: unknown): void {
  if (typeof value !== "string") {
    throw new MuboError("CONFIG_ERROR", `Invalid ${name} setting`);
  }
}

/** Deep-merges two plain objects, treating undefined as "no override". */
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

/** Parses a numeric string, throwing on invalid input. */
function readNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new MuboError("CONFIG_ERROR", `${name} must be a number`);
  return parsed;
}

/** Parses a boolean string (1/true/yes/on or 0/false/no/off), throwing on invalid input. */
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

/** Validates that a string value is one of the allowed choices. */
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

/** Validates that a value is one of the allowed string choices. */
function requireChoice(name: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new MuboError("CONFIG_ERROR", `Invalid ${name}: ${String(value)}`);
  }
}

/** Resolves the app environment from MUBO_ENV (required if set) or NODE_ENV (optional). */
function resolveEnvironment(env: Record<string, string | undefined>): string | undefined {
  const raw = env.MUBO_ENV;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      throw new MuboError("CONFIG_ERROR", "MUBO_ENV is empty");
    }
    const explicit = readChoice(trimmed, "MUBO_ENV", APP_ENVIRONMENTS);
    if (explicit) return explicit;
  }
  const nodeEnv = env.NODE_ENV?.trim();
  if ((APP_ENVIRONMENTS as readonly string[]).includes(nodeEnv ?? "")) return nodeEnv;
  return undefined;
}

/** The value of a command line flag together with the index of the next token. */
interface FlagValue {
  value: string;
  /** Index of the token that follows the consumed flag value. */
  next: number;
}

/**
 * Reads the value of a command line flag.
 *
 * Both `--flag=value` and `--flag value` are supported; a missing value is
 * rejected instead of being silently ignored.
 */
function readFlagValue(
  argv: string[],
  index: number,
  name: string,
  inline: string | undefined,
): FlagValue {
  const value = inline !== undefined ? inline : argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new MuboError("CONFIG_ERROR", `Missing value for --${name}`);
  }
  return { value, next: inline === undefined ? index + 1 : index };
}

/** Parses CLI argv into a partial MuboConfig, throwing on missing or invalid values. */
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
      const { value, next: nextIndex } = readFlagValue(argv, i, flagName, inline);
      i = nextIndex;
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
      case "request-timeout": {
        result.http = { ...result.http, requestTimeoutMs: readNumber(next(name), "--request-timeout") };
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
        result.static = { ...result.static, mode: enabled ? "off" : "disk" };
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
        result.ws = { ...result.ws, enabled: !enabled };
        break;
      }
      default:
        break;
    }
  }
  return result;
}

/** Parses environment variables into a partial MuboConfig. */
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
  const requestTimeoutMs = readNumber(env.MUBO_REQUEST_TIMEOUT_MS, "MUBO_REQUEST_TIMEOUT_MS");
  const trustProxy = readBoolean(env.MUBO_TRUST_PROXY);
  if (
    port !== undefined || host !== undefined || bodyLimit !== undefined ||
    requestTimeoutMs !== undefined || trustProxy !== undefined
  ) {
    result.http = { port, host, bodyLimit, requestTimeoutMs, trustProxy };
  }

  const dbPath = env.MUBO_DB_PATH?.trim() || undefined;
  const busyTimeoutMs = readNumber(env.MUBO_BUSY_TIMEOUT_MS, "MUBO_BUSY_TIMEOUT_MS");
  const migrationMode = readChoice(env.MUBO_MIGRATIONS_MODE, "MUBO_MIGRATIONS_MODE", MIGRATION_MODES);
  const migrationTable = env.MUBO_MIGRATIONS_TABLE?.trim() || undefined;
  const migrationLock = readChoice(env.MUBO_MIGRATIONS_LOCK, "MUBO_MIGRATIONS_LOCK", ["file", "sqlite"]) as "file" | "sqlite" | undefined;
  const safeOnly = readBoolean(env.MUBO_MIGRATIONS_SAFE_ONLY);
  const foreignKeys = readBoolean(env.MUBO_FOREIGN_KEYS);
  const wal = readBoolean(env.MUBO_WAL);
  const slowQueryMs = readNumber(env.MUBO_SLOW_QUERY_MS, "MUBO_SLOW_QUERY_MS");
  if (
    dbPath || busyTimeoutMs !== undefined || migrationMode || migrationTable ||
    migrationLock !== undefined || safeOnly !== undefined || foreignKeys !== undefined ||
    wal !== undefined || slowQueryMs !== undefined
  ) {
    result.db = {
      path: dbPath,
      busyTimeoutMs,
      foreignKeys,
      wal,
      slowQueryMs,
      migrations: {
        mode: migrationMode,
        table: migrationTable,
        safeOnly,
        lock: migrationLock,
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
  const wsMaxConnections = readNumber(env.MUBO_WS_MAX_CONNECTIONS, "MUBO_WS_MAX_CONNECTIONS");
  const wsMaxConnectionsPerIp = readNumber(env.MUBO_WS_MAX_CONNECTIONS_PER_IP, "MUBO_WS_MAX_CONNECTIONS_PER_IP");
  const wsHeartbeatIntervalMs = readNumber(env.MUBO_WS_HEARTBEAT_INTERVAL_MS, "MUBO_WS_HEARTBEAT_INTERVAL_MS");
  const wsHeartbeatTimeoutMs = readNumber(env.MUBO_WS_HEARTBEAT_TIMEOUT_MS, "MUBO_WS_HEARTBEAT_TIMEOUT_MS");
  if (
    wsEnabled !== undefined || wsMaxPayload !== undefined || wsMaxConnections !== undefined ||
    wsMaxConnectionsPerIp !== undefined || wsHeartbeatIntervalMs !== undefined ||
    wsHeartbeatTimeoutMs !== undefined
  ) {
    result.ws = {
      enabled: wsEnabled,
      maxPayloadBytes: wsMaxPayload,
      maxConnections: wsMaxConnections,
      maxConnectionsPerIp: wsMaxConnectionsPerIp,
      heartbeat: { intervalMs: wsHeartbeatIntervalMs, timeoutMs: wsHeartbeatTimeoutMs },
    };
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
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64)
    .replace(/[.-]+$/g, "");
  return cleaned || "mubo-app";
}

/** Validates that a value is an integer within optional bounds. */
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

/** Default rate-limit bucket key: the client IP resolved for the request. */
function defaultRateLimitKey(request: Request): string {
  return readClientIp(request) ?? "unknown";
}

/** Returns the platform-specific default data directory for the given app name. */
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

/** Loads a config file from the given candidates, clearing the require cache for hot reload. */
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

/** Builds the default configuration of an application. */
function defaultConfig(
  cwd: string,
  appEnv: ResolvedMuboConfig["app"]["env"],
): ResolvedMuboConfig {
  return {
    app: { name: "mubo-app", env: appEnv },
    dataDir: "",
    http: {
      host: "127.0.0.1",
      port: 3000,
      trustProxy: false,
      cors: false,
      bodyLimit: 1024 * 1024,
      requestTimeoutMs: 0,
      rateLimit: false,
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
      maxConnections: 0,
      maxConnectionsPerIp: 0,
    },
    log: { level: "info", json: appEnv === "production" },
  };
}

/** Validates that every configuration section exists and is a plain object. */
function validateSections(config: ResolvedMuboConfig): void {
  requireSection(config.app, "app");
  requireSection(config.http, "HTTP");
  requireSection(config.db, "database");
  requireSection(config.db.migrations, "migrations");
  requireSection(config.static, "static");
  requireSection(config.static.cache, "static cache");
  requireSection(config.ws, "WebSocket");
  requireSection(config.ws.heartbeat, "WebSocket heartbeat");
  requireSection(config.log, "log");
}

/** Validates the boolean settings of the configuration. */
function validateBooleans(config: ResolvedMuboConfig): void {
  requireBoolean("trust proxy", config.http.trustProxy);
  requireBoolean("database WAL", config.db.wal);
  requireBoolean("database foreign keys", config.db.foreignKeys);
  requireBoolean("safeOnly migrations", config.db.migrations.safeOnly);
  requireBoolean("static SPA fallback", config.static.spaFallback);
  requireBoolean("WebSocket enabled", config.ws.enabled);
  requireBoolean("JSON logging", config.log.json);
}

/** Validates the string settings of the configuration. */
function validateStrings(config: ResolvedMuboConfig): void {
  requireString("app name", config.app.name);
  requireString("data directory", config.dataDir);
  requireString("database path", config.db.path);
  requireString("migrations table", config.db.migrations.table);
  requireString("static directory", config.static.dir);
}

/** Trims the configured paths. */
function trimPaths(config: ResolvedMuboConfig): void {
  config.dataDir = config.dataDir.trim();
  config.db.path = config.db.path.trim();
  config.db.migrations.table = config.db.migrations.table.trim();
  config.static.dir = config.static.dir.trim();
}

/** Validates and normalizes the extensions that receive an immutable cache header. */
function normalizeImmutableExtensions(config: ResolvedMuboConfig): void {
  const immutableExtensions = config.static.cache.immutableExtensions;
  if (!Array.isArray(immutableExtensions) || immutableExtensions.some((extension) => !isValidExtension(extension))) {
    throw new MuboError("CONFIG_ERROR", "Invalid immutable extensions setting");
  }
  config.static.cache.immutableExtensions = immutableExtensions.map(normalizeExtension);
}

/** Validates the enum settings of the configuration. */
function validateChoices(config: ResolvedMuboConfig): void {
  requireChoice("app environment", config.app.env, APP_ENVIRONMENTS);
  requireChoice("log level", config.log.level, ["debug", "info", "warn", "error"]);
  requireChoice("migrations mode", config.db.migrations.mode, MIGRATION_MODES);
  requireChoice("migrations lock", config.db.migrations.lock, ["file", "sqlite"]);
  requireChoice("static mode", config.static.mode, STATIC_MODES);
}

/** Validates the CORS settings and normalizes the configured origins. */
function normalizeCors(config: ResolvedMuboConfig): void {
  if (config.http.cors === false) return;
  const cors = config.http.cors as unknown;
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
  const credentials = (cors as { credentials?: unknown }).credentials;
  if (credentials !== undefined && typeof credentials !== "boolean") {
    throw new MuboError("CONFIG_ERROR", "Invalid CORS credentials setting");
  }
  if (origin === "*" && credentials === true) {
    throw new MuboError(
      "CONFIG_ERROR",
      'Invalid CORS configuration: credentials cannot be combined with the "*" origin',
    );
  }
  if (Array.isArray(origin)) {
    config.http.cors = {
      ...(config.http.cors as CorsConfig),
      origin: origin.map((value) => (value as string).trim()),
    };
  }
}

/** Sanitizes the application name and resolves the configured paths. */
function resolvePaths(
  config: ResolvedMuboConfig,
  cwd: string,
  env: Record<string, string | undefined>,
): void {
  config.app.name = sanitizeAppName(config.app.name);
  config.dataDir = resolve(cwd, config.dataDir || defaultDataDir(config.app.name, env));
  if (!config.db.path) config.db.path = join(config.dataDir, "mubo.sqlite");
  else if (config.db.path !== ":memory:" && !isAbsolute(config.db.path)) {
    config.db.path = resolve(cwd, config.db.path);
  }
  if (!config.static.dir) config.static.dir = join(cwd, "public");
  else if (!isAbsolute(config.static.dir)) config.static.dir = resolve(cwd, config.static.dir);
}

/** Validates the HTTP settings of the configuration. */
function validateHttp(config: ResolvedMuboConfig): void {
  if (typeof config.http.host !== "string" || config.http.host.trim().length === 0) {
    throw new MuboError("CONFIG_ERROR", `Invalid HTTP host: ${String(config.http.host)}`);
  }
  config.http.host = config.http.host.trim();
  if (!Number.isInteger(config.http.port) || config.http.port < 0 || config.http.port > 65535) {
    throw new MuboError("CONFIG_ERROR", `Invalid HTTP port: ${config.http.port}`);
  }
  if (!Number.isInteger(config.http.bodyLimit) || config.http.bodyLimit <= 0) {
    throw new MuboError("CONFIG_ERROR", `Invalid body limit: ${config.http.bodyLimit}`);
  }
  if (!Number.isInteger(config.http.requestTimeoutMs) || config.http.requestTimeoutMs < 0) {
    throw new MuboError("CONFIG_ERROR", `Invalid request timeout: ${config.http.requestTimeoutMs}`);
  }
  if (config.http.rateLimit !== false) {
    if (!config.http.rateLimit || typeof config.http.rateLimit !== "object") {
      throw new MuboError("CONFIG_ERROR", "Invalid rate limit configuration");
    }
    if (!Number.isInteger(config.http.rateLimit.maxRequests) || config.http.rateLimit.maxRequests <= 0) {
      throw new MuboError("CONFIG_ERROR", "Invalid rate limit maxRequests");
    }
    if (!Number.isInteger(config.http.rateLimit.windowMs) || config.http.rateLimit.windowMs <= 0) {
      throw new MuboError("CONFIG_ERROR", "Invalid rate limit windowMs");
    }
    if (config.http.rateLimit.key === undefined) {
      config.http.rateLimit.key = defaultRateLimitKey;
    } else if (typeof config.http.rateLimit.key !== "function") {
      throw new MuboError("CONFIG_ERROR", "Invalid rate limit key function");
    }
  }
  if (config.http.cors && config.http.cors.maxAgeSeconds !== undefined) {
    requireInteger("CORS max age", config.http.cors.maxAgeSeconds, { min: 0 });
  }
}

/** Validates the database settings of the configuration. */
function validateDatabase(config: ResolvedMuboConfig): void {
  requireInteger("busy timeout", config.db.busyTimeoutMs, { min: 0 });
  requireInteger("slow query threshold", config.db.slowQueryMs, { min: 0 });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.db.migrations.table)) {
    throw new MuboError("CONFIG_ERROR", `Invalid migrations table name: ${config.db.migrations.table}`);
  }
}

/** Validates the static asset settings of the configuration. */
function validateStatic(config: ResolvedMuboConfig): void {
  requireInteger("static max age", config.static.cache.defaultMaxAgeSeconds, { min: 0, max: 31536000 });
}

/** Validates the WebSocket settings of the configuration. */
function validateWebSocket(config: ResolvedMuboConfig): void {
  requireInteger("WebSocket max payload", config.ws.maxPayloadBytes, { exclusiveMin: 0 });
  requireInteger("WebSocket heartbeat interval", config.ws.heartbeat.intervalMs, { min: 0 });
  requireInteger("WebSocket heartbeat timeout", config.ws.heartbeat.timeoutMs, { exclusiveMin: 0 });
  if (config.ws.heartbeat.timeoutMs <= config.ws.heartbeat.intervalMs) {
    throw new MuboError(
      "CONFIG_ERROR",
      `WebSocket heartbeat timeout (${config.ws.heartbeat.timeoutMs}ms) must be greater than interval (${config.ws.heartbeat.intervalMs}ms)`,
    );
  }
  requireInteger("WebSocket max connections", config.ws.maxConnections, { min: 0 });
  requireInteger("WebSocket max connections per IP", config.ws.maxConnectionsPerIp, { min: 0 });
}

/** Merges defaults, file config, env vars, and CLI args into a fully validated ResolvedMuboConfig. */
export function resolveConfig(
  overrides: MuboConfig = {},
  options: ResolveConfigOptions & { fileConfig?: MuboConfig } = {},
): ResolvedMuboConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const envName = resolveEnvironment(env);
  const appEnv: "development" | "production" | "test" =
    envName === "production" || envName === "test" ? envName : "development";

  const rawLogJson = env.MUBO_LOG_JSON?.trim();
  const logJsonConfigured =
    options.fileConfig?.log?.json !== undefined ||
    overrides.log?.json !== undefined ||
    (rawLogJson !== undefined && rawLogJson !== "");
  const merged = mergeConfig(
    mergeConfig(
      mergeConfig(defaultConfig(cwd, appEnv) as unknown, options.fileConfig ?? {}),
      overrides as unknown,
    ),
    mergeConfig(envOverrides(env) as unknown, argvOverrides(options.argv ?? process.argv.slice(2)) as unknown),
  ) as ResolvedMuboConfig;

  validateSections(merged);
  validateBooleans(merged);
  validateStrings(merged);
  trimPaths(merged);
  normalizeImmutableExtensions(merged);
  if (!logJsonConfigured) merged.log.json = merged.app.env === "production";
  validateChoices(merged);
  normalizeCors(merged);
  resolvePaths(merged, cwd, env);
  validateHttp(merged);
  validateDatabase(merged);
  validateStatic(merged);
  validateWebSocket(merged);
  return merged;
}

function configFileFromArgv(argv: string[]): string | undefined {
  let result: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") break;
    if (token === "--config") {
      const { value, next } = readFlagValue(argv, index, "config", undefined);
      result = value;
      index = next;
    } else if (token.startsWith("--config=")) {
      result = readFlagValue(argv, index, "config", token.slice("--config=".length)).value;
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
  // A compiled single-file application carries its project configuration in the
  // binary. It must not depend on config files in the working directory, which
  // a compiled binary cannot even load when they are written in TypeScript.
  const buildConfig = getBuildConfig();
  if (buildConfig !== undefined && explicitFile === undefined) {
    return resolveConfig(overrides, { ...options, cwd, argv, fileConfig: buildConfig });
  }
  const { config: fileConfig } = await loadConfigFile(cwd, explicitFile);
  if (explicitFile !== undefined) {
    return resolveConfig(fileConfig, { ...options, cwd, argv, fileConfig: overrides });
  }
  return resolveConfig(overrides, { ...options, cwd, argv, fileConfig });
}

export function ensureDataDir(dbPath: string, dataDir: string): void {
  const dirs: string[] = [];
  if (dataDir) dirs.push(dataDir);
  if (dbPath !== ":memory:") {
    const parent = dirname(dbPath);
    if (parent && !dirs.includes(parent)) dirs.push(parent);
  }
  for (const dir of dirs) {
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