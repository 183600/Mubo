import { MuboError } from "../core/errors.ts";
import type { MuboRequestContext } from "./context.ts";
import {
  routeKey,
  compileRouteSegments,
  decode,
  literalMatches,
  pathSegments,
  matchSegments,
  segmentSpecificity,
  isMoreSpecific,
  findBestMatch,
} from "../utils/path.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type RouteHandler = (
  ctx: MuboRequestContext,
) => Response | Promise<Response> | unknown | Promise<unknown>;

export type RouteMiddleware = (
  ctx: MuboRequestContext,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

export interface Segment {
  kind: "literal" | "param" | "wildcard";
  value: string;
}

export interface Route {
  method: HttpMethod;
  path: string;
  segments: Segment[];
  handler: RouteHandler;
}

export type RouteMatch =
  | { type: "match"; route: Route; params: Record<string, string> }
  | { type: "method-not-allowed"; allowed: HttpMethod[] }
  | { type: "not-found" };

export class Router {
  readonly routes: Route[] = [];

  add(method: HttpMethod, path: string, handler: RouteHandler): this {
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
    const parts = pathSegments(pathname);

    const best = findBestMatch(this.routes as readonly { method: string; path: string; segments: { kind: "literal" | "param" | "wildcard"; value: string }[]; handler: unknown }[], upper, parts) ?? (upper === "HEAD" ? findBestMatch(this.routes as readonly { method: string; path: string; segments: { kind: "literal" | "param" | "wildcard"; value: string }[]; handler: unknown }[], "GET", parts) : undefined);
    if (best) return { type: "match", route: best.route as Route, params: best.params };

    const allowed = new Set<HttpMethod>();
    for (const route of this.routes) {
      if (matchSegments(route as { segments: { kind: "literal" | "param" | "wildcard"; value: string }[] }, parts) !== null) allowed.add(route.method);
    }
    if (allowed.size > 0) {
      if (allowed.has("GET")) allowed.add("HEAD");
      allowed.add("OPTIONS");
      return { type: "method-not-allowed", allowed: [...allowed].sort() };
    }
    return { type: "not-found" };
  }
}