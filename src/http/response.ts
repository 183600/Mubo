import { isMuboError, type MuboError } from "../core/errors.ts";

export type JsonInit = ResponseInit;

/** Ensures response headers are a Headers object, casting if needed. */
function makeHeaders(headers: ResponseInit["headers"]): Headers {
  return new Headers(headers as any);
}

/**
 * Serializes a JSON response payload.
 *
 * An `undefined` payload becomes `null` so the body stays parseable, and
 * bigint values become strings - matching the WebSocket payload and log
 * serializers instead of failing the response with an internal error.
 */
function serializeJsonPayload(data: unknown): string {
  if (data === undefined) return "null";
  return JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

/** Builds a response with a default content type. */
function typedResponse(
  body: ConstructorParameters<typeof Response>[0],
  contentType: string,
  init: ResponseInit,
): Response {
  const headers = makeHeaders(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", contentType);
  return new Response(body, { status: init.status, statusText: init.statusText, headers });
}

export function jsonResponse(data: unknown, init: JsonInit = {}): Response {
  return typedResponse(serializeJsonPayload(data), "application/json; charset=utf-8", init);
}

export function textResponse(text: string, init: ResponseInit = {}): Response {
  return typedResponse(text, "text/plain; charset=utf-8", init);
}

export function htmlResponse(html: string, init: ResponseInit = {}): Response {
  return typedResponse(html, "text/html; charset=utf-8", init);
}

export interface ErrorPayload {
  /** Error code (e.g. "VALIDATION_ERROR", "NOT_FOUND") */
  error: { code: string; message: string; details?: unknown };
  /** Unique request identifier */
  requestId: string;
}

/** Builds an error payload from a MuboError or generic error. */
export function errorPayload(requestId: string, error: unknown, production = false): ErrorPayload {
  const known = isMuboError(error);
  const status = known ? error.status : 500;
  const expose = known ? error.expose : !production;
  const code: string = known ? error.code : "INTERNAL_ERROR";
  const message = expose
    ? error instanceof Error
      ? error.message
      : String(error)
    : "Internal server error";
  const payload: ErrorPayload = { error: { code, message }, requestId };
  const details = known ? (error as MuboError).details : undefined;
  if (details !== undefined && expose) payload.error.details = details;
  return payload;
}

/** Converts an error into an HTTP response, handling MuboError and fallback. */
export function errorResponse(requestId: string, error: unknown, production = false): Response {
  const known = isMuboError(error);
  const status =
    known && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
      ? error.status
      : 500;
  let payload: ErrorPayload;
  try {
    payload = errorPayload(requestId, error, production);
  } catch {
    payload = { error: { code: "INTERNAL_ERROR", message: "Internal server error" }, requestId };
  }
  try {
    return jsonResponse(payload, { status });
  } catch {
    const safe: ErrorPayload = {
      error: { code: payload.error.code, message: payload.error.message },
      requestId,
    };
    try {
      return jsonResponse(safe, { status });
    } catch {
      return jsonResponse(
        { error: { code: "INTERNAL_ERROR", message: "Internal server error" }, requestId },
        { status },
      );
    }
  }
}