import type { Server, ServerWebSocket } from "bun";
import { isMuboError, MuboError } from "./errors.ts";
import { createLogger, type Logger } from "./logger.ts";
import {
  loadAndResolveConfig,
  type MuboConfig,
  type ResolveConfigOptions,
  type ResolvedMuboConfig,
} from "./config.ts";
import { MuboDatabase } from "../db/database.ts";
import type { MuboSchema } from "../db/schema.ts";
import { createRequestContext, type MuboRequestContext } from "../http/context.ts";
import { errorPayload, errorResponse, jsonResponse, textResponse } from "../http/response.ts";
import { Router, type HttpMethod, type RouteHandler, type RouteMatch, type RouteMiddleware } from "../http/router.ts";
import { StaticAssets, type StaticAssetsOptions } from "../static/assets.ts";
import {
  WsRoomHub,
  type MuboWsContext,
  type WsHandlers,
  type WsSocketData,
} from "../ws/hub.ts";

export interface CreateMuboAppOptions extends ResolveConfigOptions {}

type WsRoute = { path: string; handlers: WsHandlers };

function normalizeRoutePath(path: string): string {
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}

function validRequestId(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function normalizeResponse(value: unknown): Response {
  if (value instanceof Response) return value;
  if (value === undefined || value === null) return new Response(null, { status: 204 });
  return jsonResponse(value);
}

function originAllowed(request: Request, config: ResolvedMuboConfig): string | undefined {
  const cors = config.http.cors;
  if (!cors) return undefined;
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  if (cors.origin === "*") return cors.credentials ? origin : "*";
  return cors.origin.includes(origin) ? origin : undefined;
}

function applyCors(request: Request, response: Response, config: ResolvedMuboConfig): Response {
  const allowOrigin = originAllowed(request, config);
  if (!allowOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", allowOrigin);
  if (config.http.cors && config.http.cors.credentials) {
    headers.set("access-control-allow-credentials", "true");
  }
  const cors = config.http.cors;
  if (cors && allowOrigin !== "*") {
    headers.append("vary", "Origin");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export class MuboApp {
  readonly config: ResolvedMuboConfig;
  readonly logger: Logger;
  readonly db: MuboDatabase;
  readonly router = new Router();
  readonly wsHub: WsRoomHub;
  readonly staticAssets: StaticAssets;
  private readonly middlewares: RouteMiddleware[] = [];
  private readonly wsRoutes = new Map<string, WsRoute>();
  private server?: Server<WsSocketData>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private startedAt?: number;

  constructor(
    config: ResolvedMuboConfig,
    logger: Logger,
    db: MuboDatabase,
    staticAssets: StaticAssets,
    private readonly cwd = process.cwd(),
  ) {
    this.config = config;
    this.logger = logger;
    this.db = db;
    this.staticAssets = staticAssets;
    this.wsHub = new WsRoomHub(logger);
  }

  get serverInstance(): Server<WsSocketData> | undefined {
    return this.server;
  }

  get port(): number | undefined {
    return this.server?.port;
  }

  get started(): boolean {
    return this.server !== undefined;
  }

  use(middleware: RouteMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  private route(method: HttpMethod, path: string, handler: RouteHandler): this {
    this.router.add(method, path, handler);
    return this;
  }

  get(path: string, handler: RouteHandler): this {
    return this.route("GET", path, handler);
  }

  head(path: string, handler: RouteHandler): this {
    return this.route("HEAD", path, handler);
  }

  post(path: string, handler: RouteHandler): this {
    return this.route("POST", path, handler);
  }

  put(path: string, handler: RouteHandler): this {
    return this.route("PUT", path, handler);
  }

  patch(path: string, handler: RouteHandler): this {
    return this.route("PATCH", path, handler);
  }

  delete(path: string, handler: RouteHandler): this {
    return this.route("DELETE", path, handler);
  }

  options(path: string, handler: RouteHandler): this {
    return this.route("OPTIONS", path, handler);
  }

  ws(path: string, handlers: WsHandlers): this {
    this.wsRoutes.set(normalizeRoutePath(path), { path: normalizeRoutePath(path), handlers });
    return this;
  }

  migrate(schema: MuboSchema | undefined = this.config.schema): ReturnType<MuboDatabase["migrate"]> {
    return this.db.migrate(schema ?? { tables: {} }, this.config.db.migrations);
  }

  static(options: StaticAssetsOptions = {}): this {
    this.staticAssets.configure(options, this.cwd);
    return this;
  }

  private async runMiddlewares(ctx: MuboRequestContext, terminal: () => Promise<Response>): Promise<Response> {
    let lastIndex = -1;
    const dispatch = async (index: number): Promise<Response> => {
      if (index <= lastIndex) throw new MuboError("INTERNAL_ERROR", "next() called multiple times");
      lastIndex = index;
      const middleware = this.middlewares[index];
      if (!middleware) return normalizeResponse(await terminal());
      return normalizeResponse(await middleware(ctx, () => dispatch(index + 1)));
    };
    return dispatch(0);
  }

  private async healthResponse(ctx: MuboRequestContext, pathname: string): Promise<Response | null> {
    if (pathname !== "/healthz" && pathname !== "/readyz") return null;
    if (ctx.method !== "GET" && ctx.method !== "HEAD") return null;
    if (pathname === "/readyz") {
      const ready = this.db.ping();
      return ctx.json(
        { ok: ready, app: this.config.app.name },
        { status: ready ? 200 : 503 },
      );
    }
    return ctx.json({
      ok: true,
      app: this.config.app.name,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    });
  }

  private async handleWebSocketUpgrade(request: Request, url: URL, server: Server<WsSocketData>): Promise<Response | null> {
    const route = this.wsRoutes.get(normalizeRoutePath(url.pathname));
    if (!route) return null;
    const upgrade = (request.headers.get("upgrade") ?? "").toLowerCase();
    if (upgrade !== "websocket") {
      if (this.router.match(request.method, url.pathname).type === "match") return null;
      return textResponse("Expected WebSocket upgrade", {
        status: 426,
        headers: { upgrade: "websocket" },
      });
    }
    if (!this.config.ws.enabled) {
      return errorResponse(crypto.randomUUID(), new MuboError("FORBIDDEN", "WebSocket support is disabled"), true);
    }

    const requestId = validRequestId(request.headers.get("x-request-id"))
      ? request.headers.get("x-request-id")!
      : crypto.randomUUID();
    let user: unknown;
    if (route.handlers.authorize) {
      try {
        user = await route.handlers.authorize(request, { path: route.path });
      } catch (error) {
        this.logger.warn("WebSocket authorization failed", {
          path: route.path,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResponse(requestId, new MuboError("UNAUTHORIZED", "WebSocket authorization failed"), true);
      }
      if (user === null || user === false) {
        return errorResponse(requestId, new MuboError("UNAUTHORIZED", "WebSocket connection rejected"), true);
      }
    }

    const address = server.requestIP(request);
    const data: WsSocketData = {
      routePath: route.path,
      requestId,
      url: url.href,
      ip: address?.address ?? "",
      user,
      state: {},
    };
    const upgraded = server.upgrade(request, { data });
    if (!upgraded) {
      return errorResponse(requestId, new MuboError("BAD_REQUEST", "WebSocket upgrade failed"), true);
    }
    return new Response(null, { status: 101 });
  }

  private handleWsOpen(ws: ServerWebSocket<WsSocketData>): void {
    const route = this.wsRoutes.get(ws.data.routePath);
    if (!route) {
      ws.close(1011, "Unknown WebSocket route");
      return;
    }
    const ctx = this.wsHub.add(ws, this, this.logger.child({ requestId: ws.data.requestId }), ws.data.ip);
    this.logger.debug("WebSocket connected", { id: ctx.id, path: route.path, ip: ctx.ip });
    if (route.handlers.onConnect) {
      this.runWsHandler(ctx, route.handlers, () => route.handlers.onConnect!(ctx));
    }
  }

  private handleWsMessage(ws: ServerWebSocket<WsSocketData>, message: string | Buffer): void {
    const route = this.wsRoutes.get(ws.data.routePath);
    const ctx = this.wsHub.getContext(ws);
    if (!route?.handlers.onMessage || !ctx) return;
    this.runWsHandler(ctx, route.handlers, () => route.handlers.onMessage!(ctx, message));
  }

  private handleWsClose(ws: ServerWebSocket<WsSocketData>, code: number, reason: string): void {
    const route = this.wsRoutes.get(ws.data.routePath);
    const ctx = this.wsHub.remove(ws);
    if (ctx && route?.handlers.onClose) {
      this.runWsHandler(ctx, route.handlers, () => route.handlers.onClose!(ctx, code, reason));
    }
    this.logger.debug("WebSocket disconnected", { code, reason, path: ws.data.routePath });
  }

  private handleWsError(ws: ServerWebSocket<WsSocketData>, error: Error): void {
    const route = this.wsRoutes.get(ws.data.routePath);
    const ctx = this.wsHub.getContext(ws);
    this.logger.error("WebSocket error", {
      path: ws.data.routePath,
      error: error.message,
    });
    if (ctx && route?.handlers.onError) {
      this.runWsHandler(ctx, route.handlers, () => route.handlers.onError!(ctx, error));
    }
  }

  private runWsHandler(
    ctx: MuboWsContext,
    handlers: WsHandlers,
    invoke: () => unknown | Promise<unknown>,
  ): void {
    const report = (error: unknown) => {
      this.logger.error("WebSocket handler failed", {
        id: ctx.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!handlers.onError) return;
      try {
        const handled = handlers.onError(ctx, error);
        if (handled instanceof Promise) {
          handled.catch((nested) =>
            this.logger.error("WebSocket onError failed", { error: String(nested) }),
          );
        }
      } catch (nested) {
        this.logger.error("WebSocket onError failed", { error: String(nested) });
      }
    };
    try {
      const result = invoke();
      if (result instanceof Promise) result.catch(report);
    } catch (error) {
      report(error);
    }
  }

  private async dispatchHttp(
    request: Request,
    url: URL,
    server: Server<WsSocketData>,
    requestId: string,
    match: RouteMatch,
    started: number,
  ): Promise<Response> {
    const log = this.logger.child({ requestId });
    const ctx = createRequestContext({
      req: request,
      url,
      params: {},
      requestId,
      db: this.db,
      log,
      app: this,
      bodyLimit: this.config.http.bodyLimit,
    });
    if (match.type === "match") Object.assign(ctx.params, match.params);

    const response = await this.runMiddlewares(ctx, async () => {
      if (match.type === "match") {
        return normalizeResponse(await match.route.handler(ctx));
      }
      if (match.type === "method-not-allowed") {
        const response = jsonResponse(
          errorPayload(requestId, new MuboError("METHOD_NOT_ALLOWED", `Method ${ctx.method} is not allowed`)),
          { status: 405 },
        );
        response.headers.set("allow", match.allowed.join(", "));
        return response;
      }
      const health = await this.healthResponse(ctx, url.pathname);
      if (health) return health;
      if (request.method === "GET" || request.method === "HEAD") {
        const asset = await this.staticAssets.handle(request, url);
        if (asset) return asset;
      }
      const error = new MuboError("NOT_FOUND", `Route not found: ${url.pathname}`);
      return errorResponse(requestId, error, this.config.app.env === "production");
    });

    if (!response.headers.has("x-request-id")) response.headers.set("x-request-id", requestId);
    const address = server.requestIP(request);
    this.logger.info("http", {
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      ip: address?.address,
    });
    return response;
  }

  async handleRequest(request: Request, server: Server<WsSocketData>): Promise<Response | undefined> {
    const started = performance.now();
    const requestId = validRequestId(request.headers.get("x-request-id"))
      ? request.headers.get("x-request-id")!
      : crypto.randomUUID();

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      const response = errorResponse(requestId, new MuboError("BAD_REQUEST", "Invalid request URL"), true);
      response.headers.set("x-request-id", requestId);
      return response;
    }

    if (this.config.http.cors && request.method.toUpperCase() === "OPTIONS") {
      const allowOrigin = originAllowed(request, this.config);
      if (allowOrigin) {
        const headers = new Headers({
          "access-control-allow-origin": allowOrigin,
          "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
          "access-control-allow-headers":
            request.headers.get("access-control-request-headers") ?? "content-type, authorization, x-request-id",
          "access-control-max-age": String(this.config.http.cors.maxAgeSeconds ?? 600),
          vary: "Origin",
        });
        if (this.config.http.cors.credentials) headers.set("access-control-allow-credentials", "true");
        headers.set("x-request-id", requestId);
        return new Response(null, { status: 204, headers });
      }
    }

    const wsResponse = await this.handleWebSocketUpgrade(request, url, server);
    if (wsResponse) {
      if (wsResponse.status === 101) return undefined;
      return applyCors(request, wsResponse, this.config);
    }

    const match = this.router.match(request.method, url.pathname);
    try {
      const response = await this.dispatchHttp(request, url, server, requestId, match, started);
      return applyCors(request, response, this.config);
    } catch (error) {
      const expected = isMuboError(error) && error.status < 500;
      const fields = {
        requestId,
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
        stack:
          !expected && this.config.app.env !== "production" && error instanceof Error
            ? error.stack
            : undefined,
      };
      if (expected) this.logger.warn("Request rejected", fields);
      else this.logger.error("Unhandled request error", fields);
      const response = errorResponse(requestId, error, this.config.app.env === "production");
      response.headers.set("x-request-id", requestId);
      return applyCors(request, response, this.config);
    }
  }

  async start(): Promise<Server<WsSocketData>> {
    if (this.server) return this.server;
    const migration = await this.migrate();
    if (migration.status === "pending") {
      throw new MuboError(
        "MIGRATION_REQUIRED",
        "Database migrations are pending; run mubo migrate or enable apply mode",
        { details: { changes: migration.changes } },
      );
    }
    if (migration.status === "applied") {
      this.logger.info("Database migrations applied", {
        id: migration.id,
        changes: migration.changes.length,
      });
    }

    const serveOptions = {
      hostname: this.config.http.host,
      port: this.config.http.port,
      development: this.config.app.env !== "production",
      fetch: (request: Request, server: Server<WsSocketData>) => this.handleRequest(request, server),
      error: (error: Error) => {
        this.logger.error("Bun.serve error", { error: error.message });
        return errorResponse(crypto.randomUUID(), error, this.config.app.env === "production");
      },
      websocket: this.config.ws.enabled
        ? {
            data: {} as WsSocketData,
            open: (ws: ServerWebSocket<WsSocketData>) => this.handleWsOpen(ws),
            message: (ws: ServerWebSocket<WsSocketData>, message: string | Buffer) =>
              this.handleWsMessage(ws, message),
            close: (ws: ServerWebSocket<WsSocketData>, code: number, reason: string) =>
              this.handleWsClose(ws, code, reason),
            error: (error: Error, ws: ServerWebSocket<WsSocketData>) => this.handleWsError(ws, error),
            maxPayloadLength: this.config.ws.maxPayloadBytes,
            sendPings: true,
            idleTimeout: Math.max(
              8,
              Math.min(960, Math.ceil(this.config.ws.heartbeat.timeoutMs / 1000)),
            ),
          }
        : undefined,
    };
    this.server = Bun.serve(serveOptions as any) as Server<WsSocketData>;

    this.startedAt = Date.now();
    if (this.config.ws.enabled && this.config.ws.heartbeat.intervalMs > 0) {
      this.heartbeatTimer = setInterval(() => this.wsHub.pingAll(), this.config.ws.heartbeat.intervalMs);
      this.heartbeatTimer.unref?.();
    }
    this.logger.info("Mubo app listening", {
      app: this.config.app.name,
      host: this.config.http.host,
      port: this.server.port,
      env: this.config.app.env,
      dataDir: this.config.dataDir,
      db: this.config.db.path,
    });
    return this.server;
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.wsHub.closeAll();
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      await server.stop(true);
    }
    this.startedAt = undefined;
    this.db.close();
    this.logger.info("Mubo app stopped", { app: this.config.app.name });
  }
}

export async function createMuboApp(
  config: MuboConfig = {},
  options: CreateMuboAppOptions = {},
): Promise<MuboApp> {
  const resolved = await loadAndResolveConfig(config, {
    ...options,
    loadFile: options.loadFile ?? true,
  });
  const logger = createLogger(resolved.log, {
    app: resolved.app.name,
    env: resolved.app.env,
  });
  const db = new MuboDatabase({
    path: resolved.db.path,
    dataDir: resolved.dataDir,
    wal: resolved.db.wal,
    busyTimeoutMs: resolved.db.busyTimeoutMs,
    foreignKeys: resolved.db.foreignKeys,
    slowQueryMs: resolved.db.slowQueryMs,
    logger,
    schema: resolved.schema,
  });
  const cwd = options.cwd ?? process.cwd();
  const staticAssets = new StaticAssets(resolved.static, cwd);
  return new MuboApp(resolved, logger, db, staticAssets, cwd);
}

export type { MuboConfig, ResolvedMuboConfig };
