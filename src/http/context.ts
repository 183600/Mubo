import type { Logger } from "../core/logger.ts";
import { MuboError } from "../core/errors.ts";
import type { MuboDatabase } from "../db/database.ts";
import { jsonResponse, textResponse } from "./response.ts";

export interface MuboRequestContext {
  readonly req: Request;
  readonly url: URL;
  readonly method: string;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly requestId: string;
  readonly state: Record<string, unknown>;
  readonly db: MuboDatabase;
  readonly log: Logger;
  readonly app: unknown;
  set(key: string, value: unknown): void;
  get<T = unknown>(key: string): T | undefined;
  body<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  formData(): Promise<FormData>;
  json(data: unknown, init?: ResponseInit): Response;
  textResponse(text: string, init?: ResponseInit): Response;
  ok(data: unknown, init?: ResponseInit): Response;
  fail(code: string, message: string, status?: number, details?: unknown): Response;
}

export interface ContextDependencies {
  req: Request;
  url: URL;
  params: Record<string, string>;
  requestId: string;
  db: MuboDatabase;
  log: Logger;
  app: unknown;
  bodyLimit: number;
}

export function createRequestContext(deps: ContextDependencies): MuboRequestContext {
  let rawBody: Uint8Array | undefined;
  let parsedBody: unknown;
  let bodyParsed = false;
  const state: Record<string, unknown> = {};

  const readBytes = async (): Promise<Uint8Array> => {
    if (rawBody) return rawBody;
    if (!deps.req.body) {
      rawBody = new Uint8Array();
      return rawBody;
    }
    const declared = Number(deps.req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > deps.bodyLimit) {
      throw new MuboError("PAYLOAD_TOO_LARGE", `Request body exceeds ${deps.bodyLimit} bytes`, {
        status: 413,
      });
    }
    const reader = deps.req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > deps.bodyLimit) {
        await reader.cancel().catch(() => undefined);
        throw new MuboError("PAYLOAD_TOO_LARGE", `Request body exceeds ${deps.bodyLimit} bytes`, {
          status: 413,
        });
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    rawBody = merged;
    return merged;
  };

  const parseBody = async (): Promise<unknown> => {
    if (bodyParsed) return parsedBody;
    bodyParsed = true;
    const bytes = await readBytes();
    if (bytes.byteLength === 0) {
      parsedBody = null;
      return parsedBody;
    }
    const contentType = (deps.req.headers.get("content-type") ?? "").toLowerCase();
    const text = new TextDecoder().decode(bytes);
    if (contentType.includes("application/json") || contentType.includes("+json")) {
      try {
        parsedBody = JSON.parse(text);
      } catch (error) {
        throw new MuboError("VALIDATION_ERROR", "Invalid JSON body", { cause: error });
      }
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      parsedBody = Object.fromEntries(new URLSearchParams(text));
    } else if (contentType.startsWith("text/") || contentType === "") {
      parsedBody = text;
    } else {
      parsedBody = bytes;
    }
    return parsedBody;
  };

  const context: MuboRequestContext = {
    req: deps.req,
    url: deps.url,
    method: deps.req.method.toUpperCase(),
    params: deps.params,
    query: deps.url.searchParams,
    requestId: deps.requestId,
    state,
    db: deps.db,
    log: deps.log,
    app: deps.app,
    set(key, value) {
      state[key] = value;
    },
    get<T>(key: string) {
      return state[key] as T | undefined;
    },
    async body<T>() {
      return (await parseBody()) as T;
    },
    async text() {
      return new TextDecoder().decode(await readBytes());
    },
    async formData() {
      const bytes = await readBytes();
      return (await new Response(bytes, { headers: deps.req.headers }).formData()) as unknown as FormData;
    },
    json(data, init) {
      return jsonResponse(data, init);
    },
    textResponse,
    ok(data, init) {
      return jsonResponse(data, init);
    },
    fail(code, message, status = 400, details) {
      return jsonResponse(
        {
          error: {
            code,
            message,
            ...(details === undefined ? {} : { details }),
          },
          requestId: deps.requestId,
        },
        { status },
      );
    },
  };
  return context;
}
