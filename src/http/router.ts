import { MuboError } from "../core/errors.ts";
import type { MuboRequestContext } from "./context.ts";
import {
  compileRouteSegments,
  findBestMatch,
  matchSegments,
  normalizePath,
  pathSegments,
  routeKey,
  type RouteSegment,
} from "../utils/path.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type RouteHandler = (
  ctx: MuboRequestContext,
) => Response | Promise<Response> | unknown | Promise<unknown>;

export type RouteMiddleware = (
  ctx: MuboRequestContext,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

/** A single compiled segment of a route path. */
export type Segment = RouteSegment;

export interface Route {
  method: HttpMethod;
  path: string;
  segments: RouteSegment[];
  handler: RouteHandler;
}

export type RouteMatch =
  | { type: "match"; route: Route; params: Record<string, string> }
  | { type: "method-not-allowed"; allowed: HttpMethod[] }
  | { type: "not-found" };

/** Validates that a route handler is callable so mistakes fail at registration. */
export function assertRouteHandler(
  handler: unknown,
  method: string,
  path: string,
): asserts handler is RouteHandler {
  if (typeof handler !== "function") {
    throw new MuboError("CONFIG_ERROR", `Route handler for ${method} ${path} must be a function`);
  }
}

export class Router {
  readonly routes: Route[] = [];

  add(method: HttpMethod, path: string, handler: RouteHandler): this {
    assertRouteHandler(handler, method, path);
    const segments = compileRouteSegments(path);
    const key = routeKey(path);
    const existing = this.routes.findIndex((route) => route.method === method && routeKey(route.path) === key);
    const route: Route = { method, path, segments, handler };
    if (existing >= 0) this.routes[existing] = route;
    else this.routes.push(route);
    return this;
  }

  match(method: string, pathname: string): RouteMatch {
    const upper = method.toUpperCase();
    const parts = pathSegments(normalizePath(pathname));

    const best =
      this.findMatch(upper, parts) ??
      // HEAD requests are served by the GET handler when no HEAD route exists.
      (upper === "HEAD" ? this.findMatch("GET", parts) : undefined);
    if (best) return { type: "match", route: best.route, params: best.params };

    const allowed = new Set<HttpMethod>();
    for (const route of this.routes) {
      if (matchSegments(route, parts) !== null) allowed.add(route.method);
    }
    if (allowed.size > 0) {
      if (allowed.has("GET")) allowed.add("HEAD");
      allowed.add("OPTIONS");
      return { type: "method-not-allowed", allowed: [...allowed].sort() };
    }
    return { type: "not-found" };
  }

  /** Finds the most specific route registered for the given method. */
  private findMatch(
    method: string,
    parts: string[],
  ): { route: Route; params: Record<string, string> } | undefined {
    return findBestMatch(this.routes, method, parts);
  }
}
