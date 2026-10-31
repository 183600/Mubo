import { isMuboError, type MuboError } from "../core/errors.ts";

export interface JsonInit extends ResponseInit {}

function makeHeaders(headers: ResponseInit["headers"]): Headers {
  const result = new Headers(headers as any);
  return result;
}

export function jsonResponse(data: unknown, init: JsonInit = {}): Response {
  const headers = makeHeaders(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status: init.status, statusText: init.statusText, headers });
}

export function textResponse(text: string, init: ResponseInit = {}): Response {
  const headers = makeHeaders(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(text, { status: init.status, statusText: init.statusText, headers });
}

export function htmlResponse(html: string, init: ResponseInit = {}): Response {
  const headers = makeHeaders(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  return new Response(html, { status: init.status, statusText: init.statusText, headers });
}

export interface ErrorPayload {
  error: { code: string; message: string; details?: unknown };
  requestId: string;
}

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

export function errorResponse(requestId: string, error: unknown, production = false): Response {
  const known = isMuboError(error);
  const status = known ? error.status : 500;
  return jsonResponse(errorPayload(requestId, error, production), { status });
}
