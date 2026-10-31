import { MuboError } from "../core/errors.ts";
import type { MuboRequestContext } from "./context.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type RouteHandler = (
  ctx: MuboRequestContext,
) => Response | Promise<Response> | unknown | Promise<unknown>;

export type RouteMiddleware = (
  ctx: MuboRequestContext,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

interface Segment {
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

function routeKey(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function compilePath(path: string): Segment[] {
  if (!path.startsWith("/")) {
    throw new MuboError("CONFIG_ERROR", `Route path must start with "/": ${path}`);
  }
  if (path.includes("?") || path.includes("#")) {
    throw new MuboError("CONFIG_ERROR", `Route path must not contain a query or fragment: ${path}`);
  }
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const raw = trimmed === "" ? [] : trimmed.split("/");
  const parameters = new Set<string>();
  return raw.map((part, index) => {
    if (part === "*") {
      if (index !== raw.length - 1) {
        throw new MuboError("CONFIG_ERROR", `Wildcard route segment must be last: ${path}`);
      }
      return { kind: "wildcard", value: "*" };
    }
    if (part.startsWith(":")) {
      const name = part.slice(1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new MuboError("CONFIG_ERROR", `Invalid route parameter: ${part}`);
      }
      if (parameters.has(name)) {
        throw new MuboError("CONFIG_ERROR", `Duplicate route parameter: ${name}`);
      }
      parameters.add(name);
      return { kind: "param", value: name };
    }
    if (part === "") {
      throw new MuboError("CONFIG_ERROR", `Route path contains an empty segment: ${path}`);
    }
    return { kind: "literal", value: part };
  });
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new MuboError("BAD_REQUEST", `Malformed percent-encoding in URL: ${value}`);
  }
}

function decodeLiteral(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function literalMatches(part: string, expected: string): boolean {
  const decoded = decode(part);
  return decoded === expected || decodeLiteral(expected) === decoded;
}

function pathSegments(pathname: string): string[] {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? [] : trimmed.split("/");
}

function matchSegments(route: Route, parts: string[]): Record<string, string> | null {
  const params = Object.create(null) as Record<string, string>;
  for (let index = 0; index < route.segments.length; index++) {
    const segment = route.segments[index]!;
    if (segment.kind === "wildcard") {
      params["*"] = parts.slice(index).map(decode).join("/");
      return params;
    }
    const part = parts[index];
    if (part === undefined) return null;
    if (segment.kind === "literal") {
      if (!literalMatches(part, segment.value)) return null;
    } else {
      params[segment.value] = decode(part);
    }
  }
  return parts.length === route.segments.length ? params : null;
}

function segmentSpecificity(segment: Segment | undefined): number {
  if (!segment) return 4;
  if (segment.kind === "literal") return 3;
  if (segment.kind === "param") return 2;
  return 1;
}

function isMoreSpecific(route: Route, than: Route): boolean {
  const length = Math.max(route.segments.length, than.segments.length);
  for (let index = 0; index < length; index++) {
    const difference =
      segmentSpecificity(route.segments[index]) - segmentSpecificity(than.segments[index]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

interface RouteCandidate {
  route: Route;
  params: Record<string, string>;
}

function findBestMatch(routes: readonly Route[], method: string, parts: string[]): RouteCandidate | undefined {
  let best: RouteCandidate | undefined;
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchSegments(route, parts);
    if (params !== null && (!best || isMoreSpecific(route, best.route))) {
      best = { route, params };
    }
  }
  return best;
}

export class Router {
  readonly routes: Route[] = [];

  add(method: HttpMethod, path: string, handler: RouteHandler): this {
    const segments = compilePath(path);
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

    const best = findBestMatch(this.routes, upper, parts) ?? (upper === "HEAD" ? findBestMatch(this.routes, "GET", parts) : undefined);
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
}
