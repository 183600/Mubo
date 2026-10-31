export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  json?: boolean;
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
  if (value instanceof Error) return JSON.stringify(value.message);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function humanLine(level: LogLevel, message: string, fields: Record<string, unknown>): string {
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), message];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

export function createLogger(options: LoggerOptions = {}, baseFields: Record<string, unknown> = {}): Logger {
  const level = options.level ?? "info";
  const threshold = LEVELS[level];
  const json = options.json ?? false;

  const emit = (entryLevel: LogLevel, message: string, fields: Record<string, unknown>) => {
    if (LEVELS[entryLevel] < threshold) return;
    const merged = { ...baseFields, ...fields };
    const line = json
      ? JSON.stringify({ time: new Date().toISOString(), level: entryLevel, message, ...merged })
      : humanLine(entryLevel, message, merged);
    if (entryLevel === "error") console.error(line);
    else if (entryLevel === "warn") console.warn(line);
    else console.log(line);
  };

  const logger: Logger = {
    level,
    debug: (message, fields = {}) => emit("debug", message, fields),
    info: (message, fields = {}) => emit("info", message, fields),
    warn: (message, fields = {}) => emit("warn", message, fields),
    error: (message, fields = {}) => emit("error", message, fields),
    child: (fields) => createLogger(options, { ...baseFields, ...fields }),
  };
  return logger;
}

export function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}
