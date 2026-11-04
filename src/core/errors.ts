export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "PAYLOAD_TOO_LARGE"
  | "CONFIG_ERROR"
  | "MIGRATION_ERROR"
  | "MIGRATION_REQUIRED"
  | "APP_STOPPED"
  | "INTERNAL_ERROR";

const DEFAULT_STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  CONFIG_ERROR: 500,
  MIGRATION_ERROR: 500,
  MIGRATION_REQUIRED: 503,
  APP_STOPPED: 503,
  INTERNAL_ERROR: 500,
};

export class MuboError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    code: ErrorCode | string,
    message: string,
    options: { status?: number; details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MuboError";
    this.code = code;
    this.status = options.status ?? (Object.hasOwn(DEFAULT_STATUS, code) ? DEFAULT_STATUS[code]! : 500);
    this.details = options.details;
    this.expose =
      options.expose ?? (Number.isInteger(this.status) && this.status >= 400 && this.status < 500);
  }
}

export function isMuboError(value: unknown): value is MuboError {
  return value instanceof MuboError;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}