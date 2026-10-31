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

function compilePath(path: string): Segment[] {
  if (!path.startsWith("/")) {
    throw new MuboError("CONFIG_ERROR", `Route path must start with "/": ${path}`);
  }
  const raw = path === "/" ? [] : path.replace(/^\/+|\/+$/g, "").split("/");
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

function pathSegments(pathname: string): string[] {
  if (pathname === "/" || pathname === "") return [];
  return pathname.replace(/^\/+|\/+$/g, "").split("/");
}

function matchSegments(route: Route, parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let index = 0; index < route.segments.length; index++) {
    const segment = route.segments[index]!;
    if (segment.kind === "wildcard") {
      params["*"] = parts.slice(index).map(decode).join("/");
      return params;
    }
    const part = parts[index];
    if (part === undefined) return null;
    if (segment.kind === "literal") {
      if (decode(part) !== segment.value) return null;
    } else {
      params[segment.value] = decode(part);
    }
  }
  return parts.length === route.segments.length ? params : null;
}

export class Router {
  readonly routes: Route[] = [];

  add(method: HttpMethod, path: string, handler: RouteHandler): this {
    const segments = compilePath(path);
    const existing = this.routes.findIndex((route) => route.method === method && route.path === path);
    const route: Route = { method, path, segments, handler };
    if (existing >= 0) this.routes[existing] = route;
    else this.routes.push(route);
    return this;
  }

  match(method: string, pathname: string): RouteMatch {
    const upper = method.toUpperCase();
    const effective = upper === "HEAD" ? "GET" : upper;
    const parts = pathSegments(pathname);
    const allowed = new Set<HttpMethod>();

    for (const route of this.routes) {
      const params = matchSegments(route, parts);
      if (params === null) continue;
      if (route.method === effective || (effective === "GET" && route.method === "GET")) {
        return { type: "match", route, params };
      }
      allowed.add(route.method);
    }

    if (allowed.size > 0) {
      if (allowed.has("GET")) allowed.add("HEAD");
      allowed.add("OPTIONS");
      return { type: "method-not-allowed", allowed: [...allowed].sort() };
    }
    return { type: "not-found" };
  }
}
