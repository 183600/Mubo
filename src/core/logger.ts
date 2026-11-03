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
  if (typeof value === "string") {
    return oneLine(/^[A-Za-z0-9._:/@+-]+$/.test(value) ? value : JSON.stringify(value));
  }
  if (value instanceof Error) return oneLine(JSON.stringify(value.message));
  try {
    const json = JSON.stringify(value);
    return oneLine(json === undefined ? String(value) : json);
  } catch {
    return oneLine(String(value));
  }
}

function oneLine(value: string): string {
  return value
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function humanLine(level: LogLevel, message: string, fields: Record<string, unknown>): string {
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), oneLine(message)];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${oneLine(key)}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

function jsonLine(level: LogLevel, message: string, fields: Record<string, unknown>): string {
  const time = new Date().toISOString();
  const ancestors: object[] = [];
  try {
    return JSON.stringify({ time, level, message, ...fields }, function (_key, value: unknown) {
      if (typeof value === "bigint") return value.toString();
      if (typeof value !== "object" || value === null) return value;
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(value)) return "[Circular]";
      ancestors.push(value);
      return value;
    });
  } catch {
    return JSON.stringify({
      time,
      level,
      message,
      loggingError: "Log fields could not be serialized",
    });
  }
}

export function createLogger(options: LoggerOptions = {}, baseFields: Record<string, unknown> = {}): Logger {
  const level = options.level ?? "info";
  const threshold = LEVELS[level];
  const json = options.json ?? false;

  const emit = (entryLevel: LogLevel, message: string, fields: Record<string, unknown>) => {
    if (LEVELS[entryLevel] < threshold) return;
    const merged = { ...baseFields, ...fields };
    const line = json ? jsonLine(entryLevel, message, merged) : humanLine(entryLevel, message, merged);
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