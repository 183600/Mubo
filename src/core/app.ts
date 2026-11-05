import type { Server, ServerWebSocket } from "bun";
import { errorMessage, isMuboError, MuboError } from "./errors.ts";
import { createLogger, type Logger } from "./logger.ts";
import {
  loadAndResolveConfig,
  type MuboConfig,
  type ResolveConfigOptions,
  type ResolvedMuboConfig,
} from "./config.ts";
import { MuboDatabase } from "../db/database.ts";
import type { MuboSchema } from "../db/schema.ts";
import type { MigrationResult } from "../db/migrations.ts";
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
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  normalizePath,
  normalizeRoutePath,
  decodeLookupPath,
  routeIdentity,
} from "../utils/path.ts";
import { attachClientIp, readClientIp } from "../utils/client-ip.ts";

/** Internal WebSocket route entry. */
type WsRoute = { path: string; handlers: WsHandlers };

/** Signals that trigger graceful shutdown. */
type ShutdownSignal = "SIGINT" | "SIGTERM";

/** Rate limit settings, excluding the "disabled" sentinel. */
type RateLimitConfig = Exclude<ResolvedMuboConfig["http"]["rateLimit"], false>;

const SHUTDOWN_SIGNALS: readonly ShutdownSignal[] = ["SIGINT", "SIGTERM"];

/** Set of running Mubo applications, for process-level shutdown. */
const runningApps = new Set<MuboApp>();

/** Global signal handlers installed for all running apps. */
let shutdownHandlers: Array<[ShutdownSignal, () => void]> | undefined;

export interface CreateMuboAppOptions extends ResolveConfigOptions {}

/** Installs global signal handlers for graceful shutdown of all running apps. */
function installShutdownHandlers(): void {
  if (shutdownHandlers) return;
  const handlers: Array<[ShutdownSignal, () => void]> = [];
  for (const signal of SHUTDOWN_SIGNALS) {
    const handler = () => {
      void shutdownRunningApps(signal);
    };
    process.on(signal, handler);
    handlers.push([signal, handler]);
  }
  shutdownHandlers = handlers;
}

/** Removes global signal handlers when no apps are running. */
function removeShutdownHandlers(): void {
  if (!shutdownHandlers) return;
  for (const [signal, handler] of shutdownHandlers) process.removeListener(signal, handler);
  shutdownHandlers = undefined;
}

/** Gracefully stops all running apps and re-raises the signal if no other handlers exist. */
async function shutdownRunningApps(signal: ShutdownSignal): Promise<void> {
  const apps = [...runningApps];
  for (const app of apps) {
    try {
      await app.stop();
    } catch (error) {
      app.logger.error("Graceful shutdown failed", { signal, error: errorMessage(error) });
    }
  }
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

/** Validates a request ID header value (alphanumeric + ._:- up to 128 chars). */
function validRequestId(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/** Extracts client IP from request, respecting trustProxy settings. */
function clientIp(request: Request, server: Server<WsSocketData>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim().split(/\s+/)[0];
    if (forwarded && forwarded.length <= 100) return forwarded;
    const real = request.headers.get("x-real-ip")?.trim();
    if (real && real.length <= 100) return real;
  }
  try {
    return server.requestIP(request)?.address ?? "";
  } catch {
    // The server cannot resolve an address for requests it did not create.
    return "";
  }
}

/** Normalizes a handler return value into a Response object. */
function normalizeResponse(value: unknown): Response {
  if (value instanceof Response) return value;
  if (value === undefined || value === null) return new Response(null, { status: 204 });
  return jsonResponse(value);
}

/** Checks whether a request origin is allowed by the CORS configuration. */
function originAllowed(request: Request, config: ResolvedMuboConfig): string | undefined {
  const cors = config.http.cors;
  if (!cors) return undefined;
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  if (cors.origin === "*") return "*";
  return cors.origin.includes(origin) ? origin : undefined;
}

/** Appends a value to the Vary header, preventing duplicate entries. */
function addVaryHeader(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (!current) {
    headers.set("vary", value);
    return;
  }
  const values = current.split(",").map((entry) => entry.trim().toLowerCase());
  if (values.includes("*")) return;
  if (!values.includes(value.toLowerCase())) headers.append("vary", value);
}

/** Applies CORS headers to a response based on config and request origin. */
function applyCors(request: Request, response: Response, config: ResolvedMuboConfig): Response {
  const cors = config.http.cors;
  if (!cors) return response;
  const allowOrigin = originAllowed(request, config);
  const varyOrigin = cors.origin !== "*";
  if (!allowOrigin && !varyOrigin) return response;
  const headers = new Headers(response.headers);
  if (allowOrigin) {
    headers.set("access-control-allow-origin", allowOrigin);
    if (cors.credentials) headers.set("access-control-allow-credentials", "true");
  }
  if (varyOrigin) addVaryHeader(headers, "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Merges preflight response headers onto the final response, skipping reserved keys. */
function mergePreflightHeaders(response: Response, preflight: Headers): void {
  preflight.forEach((value, key) => {
    if (key === "vary" || key === "x-request-id") return;
    if (!response.headers.has(key)) response.headers.set(key, value);
  });
}

export class MuboApp {
  readonly config: ResolvedMuboConfig;
  readonly logger: Logger;
  readonly db: MuboDatabase;
  readonly router = new Router();
  readonly wsHub: WsRoomHub<MuboApp>;
  readonly staticAssets: StaticAssets;
  private readonly middlewares: RouteMiddleware[] = [];
  private readonly wsRoutes = new Map<string, WsRoute>();
  private readonly cleanupTasks: Array<() => void> = [];
  private server?: Server<WsSocketData>;
  private starting?: Promise<Server<WsSocketData>>;
  private stopping?: Promise<void>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private startedAt?: number;
  private hasStopped = false;
  private builtInMiddlewaresInstalled = false;

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
    this.wsHub = new WsRoomHub<MuboApp>(
      logger,
      config.ws.maxConnections,
      config.ws.maxConnectionsPerIp,
    );
  }

  get serverInstance(): Server<WsSocketData> | undefined {
    return this.server;
  }

  get port(): number | undefined {
    return this.server?.port;
  }

  /** Whether the server is currently running. */
  get started(): boolean {
    return this.server !== undefined;
  }

  /** Whether the app has been stopped and cannot be restarted. */
  get stopped(): boolean {
    return this.hasStopped;
  }

  /** Adds a middleware to the HTTP pipeline (onion model). */
  use(middleware: RouteMiddleware): this {
    if (typeof middleware !== "function") {
      throw new MuboError("CONFIG_ERROR", "Middleware must be a function");
    }
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

  /** Registers a WebSocket route with handlers. */
  ws(path: string, handlers: WsHandlers): this {
    const normalized = normalizeRoutePath(path);
    if (handlers === null || typeof handlers !== "object" || Array.isArray(handlers)) {
      throw new MuboError("CONFIG_ERROR", `WebSocket handlers for ${normalized} must be an object`);
    }
    // WebSocket routes are matched by their exact path, so parameter and
    // wildcard segments could never be reached at runtime.
    for (const segment of normalized.split("/")) {
      if (segment === "*" || segment.startsWith(":")) {
        throw new MuboError(
          "CONFIG_ERROR",
          `WebSocket route path must not contain parameters or wildcards: ${normalized}`,
        );
      }
    }
    for (const name of ["authorize", "onConnect", "onMessage", "onClose", "onError"] as const) {
      const handler = handlers[name];
      if (handler !== undefined && typeof handler !== "function") {
        throw new MuboError(
          "CONFIG_ERROR",
          `WebSocket handler ${name} for ${normalized} must be a function`,
        );
      }
    }
    this.wsRoutes.set(routeIdentity(normalized), { path: normalized, handlers });
    return this;
  }

  /** Applies pending migrations for the given schema. */
  async migrate(schema: MuboSchema | undefined = this.config.schema): Promise<MigrationResult> {
    return this.db.migrate(schema ?? { tables: {} }, this.config.db.migrations);
  }

  /** Configures static asset serving. */
  static(options: StaticAssetsOptions = {}): this {
    this.staticAssets.configure(options, this.cwd);
    return this;
  }

  /**
   * Installs the framework provided middleware exactly once.
   *
   * A failed `start()` attempt (for example a busy port) may be retried, and
   * installing the middleware again would apply the request timeout and the
   * rate limiter twice for every request.
   */
  private installBuiltInMiddlewares(): void {
    if (this.builtInMiddlewaresInstalled) return;
    if (this.config.http.requestTimeoutMs > 0) {
      this.middlewares.unshift(this.createRequestTimeoutMiddleware());
    }
    const rateLimit = this.config.http.rateLimit;
    if (rateLimit !== false) {
      this.middlewares.unshift(this.createRateLimitMiddleware(rateLimit));
    }
    this.builtInMiddlewaresInstalled = true;
  }

  /** Executes middleware chain in onion model, throwing if next() is called multiple times. */
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

  /** Creates middleware that enforces request timeout. */
  private createRequestTimeoutMiddleware(): RouteMiddleware {
    const timeoutMs = this.config.http.requestTimeoutMs;
    return async (ctx, next) => {
      let timeoutId: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new MuboError("REQUEST_TIMEOUT", `Request exceeded ${timeoutMs}ms timeout`));
        }, timeoutMs);
      });
      try {
        return await Promise.race([next(), timeoutPromise]);
      } finally {
        clearTimeout(timeoutId!);
      }
    };
  }

  /** Creates middleware that enforces rate limiting per key. */
  private createRateLimitMiddleware(rateLimit: RateLimitConfig): RouteMiddleware {
    const { maxRequests, windowMs, key } = rateLimit;
    const store = new Map<string, { count: number; resetAt: number }>();
    let cleanupTimer: ReturnType<typeof setInterval> | undefined;
    const scheduleCleanup = () => {
      if (cleanupTimer) return;
      cleanupTimer = setInterval(() => {
        const now = Date.now();
        let hasEntries = false;
        for (const [k, v] of store.entries()) {
          if (v.resetAt < now) store.delete(k);
          else hasEntries = true;
        }
        if (!hasEntries && cleanupTimer) {
          clearInterval(cleanupTimer);
          cleanupTimer = undefined;
        }
      }, windowMs);
      cleanupTimer.unref?.();
    };
    // Eagerly schedule cleanup to maintain backward compatibility with tests
    scheduleCleanup();
    this.cleanupTasks.push(() => {
      if (cleanupTimer) clearInterval(cleanupTimer);
    });

    const addRateLimitHeaders = (response: Response, remaining: number, resetAt: number): Response => {
      const headers = new Headers(response.headers);
      headers.set("x-ratelimit-limit", String(maxRequests));
      headers.set("x-ratelimit-remaining", String(remaining));
      headers.set("x-ratelimit-reset", String(Math.ceil(resetAt / 1000)));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    };

    return async (ctx, next) => {
      const identifier = key(ctx.req);
      const now = Date.now();
      const entry = store.get(identifier);
      if (!entry || entry.resetAt < now) {
        store.set(identifier, { count: 1, resetAt: now + windowMs });
      } else {
        entry.count++;
        if (entry.count > maxRequests) {
          const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
          const errorResponse = ctx.fail(
            "RATE_LIMITED",
            "Too many requests",
            429,
            { retryAfterSeconds: retryAfter },
          );
          return addRateLimitHeaders(errorResponse, 0, entry.resetAt);
        }
      }
      const response = await next();
      const remaining = Math.max(0, maxRequests - (store.get(identifier)?.count ?? 0));
      return addRateLimitHeaders(response, remaining, store.get(identifier)?.resetAt ?? now + windowMs);
    };
  }

  /** Builds the unified 405 response with an Allow header for the given methods. */
  private methodNotAllowedResponse(ctx: MuboRequestContext, allowed: string[]): Response {
    const response = jsonResponse(
      errorPayload(
        ctx.requestId,
        new MuboError("METHOD_NOT_ALLOWED", `Method ${ctx.method} is not allowed`),
      ),
      { status: 405 },
    );
    response.headers.set("allow", allowed.join(", "));
    return response;
  }

  /** Answers an OPTIONS request for a resource without an OPTIONS handler. */
  private optionsDiscoveryResponse(allowed: string[]): Response {
    const response = new Response(null, { status: 204 });
    response.headers.set("allow", allowed.join(", "));
    return response;
  }

  /** Handles /healthz and /readyz endpoints, returning health check responses. */
  private async healthResponse(ctx: MuboRequestContext, pathname: string): Promise<Response | null> {
    const normalized = normalizePath(pathname);
    const path = normalized.replace(/^\/+|\/+$/g, "");
    if (path !== "healthz" && path !== "readyz") return null;
    // The health endpoints are served for GET and HEAD only; other methods
    // answer 405 with an Allow header instead of a misleading 404. OPTIONS
    // advertises the supported methods like every other resource.
    if (ctx.method === "OPTIONS") {
      return this.optionsDiscoveryResponse(["GET", "HEAD"]);
    }
    if (ctx.method !== "GET" && ctx.method !== "HEAD") {
      return this.methodNotAllowedResponse(ctx, ["GET", "HEAD"]);
    }
    if (path === "readyz") {
      const dbReady = this.db.ping();
      let migrationsReady = true;
      let migrationDetail: string | undefined;
      if (this.config.db.migrations.mode === "apply" && this.config.schema) {
        try {
          const plan = this.db.plan(this.config.schema, this.config.db.migrations);
          migrationsReady = plan.statements.length === 0;
          if (!migrationsReady) {
            migrationDetail = `pending: ${plan.changes.join(", ")}`;
          }
        } catch {
          migrationsReady = false;
          migrationDetail = "migration check failed";
        }
      }
      const dataDirWritable = await this.checkDataDirWritable();
      const ready = dbReady && migrationsReady && dataDirWritable;
      return ctx.json(
        {
          ok: ready,
          app: this.config.app.name,
          checks: {
            database: dbReady ? "ok" : "failed",
            migrations: migrationsReady ? "ok" : (migrationDetail ?? "pending"),
            dataDirectory: dataDirWritable ? "ok" : "not writable",
          },
        },
        { status: ready ? 200 : 503 },
      );
    }
    return ctx.json({
      ok: true,
      app: this.config.app.name,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    });
  }

  /** Checks if the data directory is writable by writing a probe file. */
  private async checkDataDirWritable(): Promise<boolean> {
    // The probe name has to be unique: concurrent readiness checks must not
    // delete each other's probe file while it is still being written.
    const probePath = join(
      this.config.dataDir,
      `.mubo-readiness-${process.pid}-${crypto.randomUUID()}`,
    );
    let writable = false;
    try {
      await Bun.write(probePath, "ok");
      writable = true;
    } catch {
      writable = false;
    }
    try {
      rmSync(probePath, { force: true });
    } catch {
      // The probe file may already be gone; writability was determined above.
    }
    return writable;
  }

  /** Handles WebSocket upgrade request: validates route, auth, and connection limits. */
  private async handleWebSocketUpgrade(
    request: Request,
    url: URL,
    server: Server<WsSocketData>,
    requestId: string,
  ): Promise<Response | null> {
    if (this.wsRoutes.size === 0) return null;
    let route = this.wsRoutes.get(routeIdentity(url.pathname));
    if (!route) {
      // Try matching the decoded path (handles percent-encoded segments).
      try {
        const decoded = decodeLookupPath(url.pathname);
        if (decoded !== undefined) route = this.wsRoutes.get(routeIdentity(decoded));
      } catch {
        // Malformed percent-encoding - no route match possible.
        route = undefined;
      }
    }
    if (!route) return null;
    const upgrade = (request.headers.get("upgrade") ?? "").toLowerCase();
    if (upgrade !== "websocket") {
      if (this.router.match(request.method, url.pathname).type !== "not-found") return null;
      return textResponse("Expected WebSocket upgrade", {
        status: 426,
        headers: { upgrade: "websocket" },
      });
    }
    if (!this.config.ws.enabled) {
      return errorResponse(requestId, new MuboError("FORBIDDEN", "WebSocket support is disabled"), true);
    }

    let user: unknown;
    if (route.handlers.authorize) {
      try {
        user = await route.handlers.authorize(request, { path: route.path });
      } catch (error) {
        this.logger.child({ requestId }).warn("WebSocket authorization failed", {
          path: route.path,
          error: errorMessage(error),
        });
        return errorResponse(requestId, new MuboError("UNAUTHORIZED", "WebSocket authorization failed"), true);
      }
      if (user === null || user === false) {
        return errorResponse(requestId, new MuboError("UNAUTHORIZED", "WebSocket connection rejected"), true);
      }
    }

    const clientIpAddr = clientIp(request, server, this.config.http.trustProxy);
    if (this.config.ws.maxConnections > 0 && this.wsHub.clientCount >= this.config.ws.maxConnections) {
      return errorResponse(requestId, new MuboError("WS_CONNECTION_LIMIT", "Maximum WebSocket connections reached"), true);
    }

    let releasePerIp: (() => void) | undefined;
    if (this.config.ws.maxConnectionsPerIp > 0) {
      try {
        releasePerIp = this.wsHub.reserveConnection(clientIpAddr, this.config.ws.maxConnectionsPerIp);
      } catch (error) {
        return errorResponse(requestId, new MuboError("WS_CONNECTION_LIMIT_PER_IP", "Too many connections from this IP"), true);
      }
    }

    const data: WsSocketData = {
      routePath: route.path,
      requestId,
      url: url.href,
      ip: clientIpAddr,
      user,
      state: Object.create(null) as Record<string, unknown>,
      releasePerIp,
    };
    const upgraded = server.upgrade(request, { data });
    if (!upgraded) {
      releasePerIp?.();
      return errorResponse(requestId, new MuboError("BAD_REQUEST", "WebSocket upgrade failed"), true);
    }
    return new Response(null, { status: 101 });
  }

  /** Looks up the WebSocket route for the given socket. */
  private wsRoute(ws: ServerWebSocket<WsSocketData>): WsRoute | undefined {
    return this.wsRoutes.get(routeIdentity(ws.data.routePath));
  }

  private getWsContext(ws: ServerWebSocket<WsSocketData>): MuboWsContext | undefined {
    return this.wsHub.getContext(ws);
  }

  private logWsDisconnect(ws: ServerWebSocket<WsSocketData>, code: number, reason: string): void {
    const log = this.wsHub.getContext(ws)?.log ?? this.logger.child({ requestId: ws.data.requestId });
    log.debug("WebSocket disconnected", { code, reason, path: ws.data.routePath });
  }

  /** Closes a WebSocket without letting close failures escape. */
  private closeWs(ws: ServerWebSocket<WsSocketData>, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch (error) {
      this.logger.child({ requestId: ws.data.requestId }).debug("WebSocket close failed", {
        error: errorMessage(error),
      });
    }
  }

  /** Handles new WebSocket connection: creates context, runs onConnect. */
  private handleWsOpen(ws: ServerWebSocket<WsSocketData>): void {
    const route = this.wsRoute(ws);
    if (!route) {
      this.closeWs(ws, 1011, "Unknown WebSocket route");
      return;
    }
    let ctx: MuboWsContext;
    try {
      ctx = this.wsHub.add(ws, this, this.logger.child({ requestId: ws.data.requestId }), ws.data.ip, true);
      // The hub owns the per-IP slot from here on; the release function would
      // otherwise double-release the reservation when the socket closes.
      ws.data.releasePerIp = undefined;
    } catch (error) {
      ws.data.releasePerIp?.();
      ws.data.releasePerIp = undefined;
      this.logger.child({ requestId: ws.data.requestId }).warn("WebSocket connection rejected", {
        path: route.path,
        error: errorMessage(error),
      });
      this.closeWs(ws, 1013, "Connection rejected");
      return;
    }
    ctx.log.debug("WebSocket connected", { id: ctx.id, path: route.path, ip: ctx.ip });
    if (route.handlers.onConnect) {
      this.runWsHandler(ctx, route.handlers, () => route.handlers.onConnect!(ctx));
    }
  }

  /** Handles incoming WebSocket message: runs onMessage handler. */
  private handleWsMessage(ws: ServerWebSocket<WsSocketData>, message: string | Buffer): void {
    const route = this.wsRoute(ws);
    const ctx = this.getWsContext(ws);
    if (!route?.handlers.onMessage || !ctx) return;
    this.runWsHandler(ctx, route.handlers, () => route.handlers.onMessage!(ctx, message));
  }

  /** Handles WebSocket close: cleans up rooms, runs onClose. */
  private handleWsClose(ws: ServerWebSocket<WsSocketData>, code: number, reason: string): void {
    const route = this.wsRoute(ws);
    const ctx = this.wsHub.remove(ws);
    if (!ctx) {
      // The socket closed before its connection context existed (it was
      // never added to the hub). Release any per-IP slot that was still
      // reserved while the upgrade was processed so the count cannot leak.
      ws.data.releasePerIp?.();
      ws.data.releasePerIp = undefined;
    }
    if (ctx && route?.handlers.onClose) {
      this.runWsHandler(ctx, route.handlers, () => route.handlers.onClose!(ctx, code, reason));
    }
    this.logWsDisconnect(ws, code, reason);
  }

  /** Handles WebSocket error: logs and runs onError handler. */
  private handleWsError(ws: ServerWebSocket<WsSocketData>, error: Error): void {
    const route = this.wsRoute(ws);
    const ctx = this.getWsContext(ws);
    const log = ctx?.log ?? this.logger.child({ requestId: ws.data.requestId });
    log.error("WebSocket error", { path: ws.data.routePath, error: error.message });
    if (ctx && route?.handlers.onError) {
      this.runWsHandler(ctx, route.handlers, () => route.handlers.onError!(ctx, error));
    }
  }

  /** Safely runs a WebSocket handler, catching errors and invoking onError. */
  private runWsHandler(
    ctx: MuboWsContext,
    handlers: WsHandlers,
    invoke: () => unknown | Promise<unknown>,
  ): void {
    const report = (error: unknown) => {
      ctx.log.error("WebSocket handler failed", {
        id: ctx.id,
        error: errorMessage(error),
      });
      if (!handlers.onError) return;
      try {
        const handled = handlers.onError(ctx, error);
        if (handled instanceof Promise) {
          handled.catch((nested) =>
            ctx.log.error("WebSocket onError failed", { error: String(nested) }),
          );
        }
      } catch (nested) {
        ctx.log.error("WebSocket onError failed", { error: String(nested) });
      }
    };
    try {
      const result = invoke();
      if (result instanceof Promise) result.catch(report);
    } catch (error) {
      report(error);
    }
  }

  private logHttp(
    request: Request,
    url: URL,
    requestId: string,
    status: number,
    started: number,
    ip: string,
  ): void {
    this.logger.child({ requestId }).info("http", {
      method: request.method,
      path: url.pathname,
      status,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      ip,
    });
  }

  /** Resolves a request that reached the end of the middleware chain. */
  private async handleMatchedRoute(
    request: Request,
    url: URL,
    requestId: string,
    ctx: MuboRequestContext,
    match: RouteMatch,
  ): Promise<Response> {
    if (match.type === "match") {
      return normalizeResponse(await match.route.handler(ctx));
    }
    if (match.type === "method-not-allowed") {
      // An OPTIONS request without a registered handler advertises the
      // supported methods instead of rejecting itself with 405; the Allow
      // header already lists OPTIONS, so answering it keeps the header
      // accurate (RFC 9110 9.3.7).
      if (ctx.method === "OPTIONS") {
        return this.optionsDiscoveryResponse(match.allowed);
      }
      return this.methodNotAllowedResponse(ctx, match.allowed);
    }
    const health = await this.healthResponse(ctx, url.pathname);
    if (health) return health;
    if (request.method === "GET" || request.method === "HEAD") {
      const asset = await this.staticAssets.handle(request, url);
      if (asset) return asset;
    }
    const error = new MuboError("NOT_FOUND", `Route not found: ${url.pathname}`);
    return errorResponse(requestId, error, this.config.app.env === "production");
  }

  private async dispatchHttp(
    request: Request,
    url: URL,
    requestId: string,
    match: RouteMatch,
    started: number,
    ip: string,
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
      ip,
    });
    if (match.type === "match") Object.assign(ctx.params, match.params);

    const response = await this.runMiddlewares(ctx, () =>
      this.handleMatchedRoute(request, url, requestId, ctx, match),
    );

    if (!response.headers.has("x-request-id")) response.headers.set("x-request-id", requestId);
    this.logHttp(request, url, requestId, response.status, started, ip);
    return response;
  }

  /** Builds the CORS preflight headers of an OPTIONS request. */
  private buildPreflightHeaders(request: Request): Headers | undefined {
    const cors = this.config.http.cors;
    if (!cors) return undefined;
    const allowOrigin = originAllowed(request, this.config);
    if (!allowOrigin) return undefined;
    const headers = new Headers({
      "access-control-allow-origin": allowOrigin,
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers":
        request.headers.get("access-control-request-headers") ?? "content-type, authorization, x-request-id",
      "access-control-max-age": String(cors.maxAgeSeconds ?? 600),
      vary: "Origin",
    });
    if (cors.credentials) headers.set("access-control-allow-credentials", "true");
    return headers;
  }

  /** Logs a failed request and converts it into an error response. */
  private handleRequestError(
    error: unknown,
    request: Request,
    url: URL,
    requestId: string,
  ): Response {
    const expected =
      isMuboError(error) &&
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status < 500;
    const fields = {
      requestId,
      method: request.method,
      path: url.pathname,
      error: errorMessage(error),
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

  async handleRequest(request: Request, server: Server<WsSocketData>): Promise<Response | undefined> {
    const started = performance.now();
    const requestIdHeader = request.headers.get("x-request-id");
    const requestId = validRequestId(requestIdHeader) ? requestIdHeader : crypto.randomUUID();
    const ip = clientIp(request, server, this.config.http.trustProxy);
    attachClientIp(request, ip);

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      const response = errorResponse(requestId, new MuboError("BAD_REQUEST", "Invalid request URL"), true);
      response.headers.set("x-request-id", requestId);
      this.logHttp(request, new URL("http://invalid.local/"), requestId, response.status, started, ip);
      return response;
    }

    try {
      const preflightHeaders =
        request.method.toUpperCase() === "OPTIONS" ? this.buildPreflightHeaders(request) : undefined;
      // A registered OPTIONS route takes precedence over the automatic
      // preflight response, but the preflight headers are still applied to
      // it so browsers accept the request.
      if (preflightHeaders && this.router.match("OPTIONS", url.pathname).type !== "match") {
        preflightHeaders.set("x-request-id", requestId);
        this.logHttp(request, url, requestId, 204, started, ip);
        return new Response(null, { status: 204, headers: preflightHeaders });
      }

      const wsResponse = await this.handleWebSocketUpgrade(request, url, server, requestId);
      if (wsResponse) {
        if (wsResponse.status === 101) {
          this.logHttp(request, url, requestId, 101, started, ip);
          return undefined;
        }
        if (!wsResponse.headers.has("x-request-id")) wsResponse.headers.set("x-request-id", requestId);
        this.logHttp(request, url, requestId, wsResponse.status, started, ip);
        return applyCors(request, wsResponse, this.config);
      }

      const match = this.router.match(request.method, url.pathname);
      const response = await this.dispatchHttp(request, url, requestId, match, started, ip);
      const corsResponse = applyCors(request, response, this.config);
      if (preflightHeaders) mergePreflightHeaders(corsResponse, preflightHeaders);
      return corsResponse;
    } catch (error) {
      const response = this.handleRequestError(error, request, url, requestId);
      this.logHttp(request, url, requestId, response.status, started, ip);
      return response;
    }
  }

  async start(): Promise<Server<WsSocketData>> {
    if (this.server) return this.server;
    if (this.starting) return this.starting;
    const starting = this.startOnce();
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async startOnce(): Promise<Server<WsSocketData>> {
    if (this.server) return this.server;
    if (this.hasStopped) {
      throw new MuboError("APP_STOPPED", "Application has been stopped and cannot be restarted");
    }
    const migration = await this.migrate();
    if (this.hasStopped) {
      throw new MuboError("APP_STOPPED", "Application was stopped while starting");
    }
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

    this.installBuiltInMiddlewares();

    const serveOptions = {
      hostname: this.config.http.host,
      port: this.config.http.port,
      development: this.config.app.env !== "production",
      fetch: (request: Request, server: Server<WsSocketData>) => this.handleRequest(request, server),
      error: (error: Error) => {
        const requestId = crypto.randomUUID();
        this.logger.error("Bun.serve error", { requestId, error: error.message });
        const response = errorResponse(requestId, error, this.config.app.env === "production");
        response.headers.set("x-request-id", requestId);
        return response;
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
    runningApps.add(this);
    installShutdownHandlers();
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
    if (this.stopping) return this.stopping;
    const stopping = this.stopOnce();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  private async stopOnce(): Promise<void> {
    this.hasStopped = true;
    const starting = this.starting;
    if (starting) {
      try {
        await starting;
      } catch {
        // The pending start was aborted because the app is shutting down.
      }
    }
    runningApps.delete(this);
    if (runningApps.size === 0) removeShutdownHandlers();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const cleanup of this.cleanupTasks.splice(0)) cleanup();
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
    loadFile: options.loadFile ?? Object.keys(config).length === 0,
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
    migrations: resolved.db.migrations,
  });
  const cwd = options.cwd ?? process.cwd();
  const staticAssets = new StaticAssets(resolved.static, cwd);
  return new MuboApp(resolved, logger, db, staticAssets, cwd);
}

export type { MuboConfig, ResolvedMuboConfig };