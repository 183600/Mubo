import { MuboError } from "../core/errors.ts";

/** The three kinds of segments a compiled route path can contain. */
export type RouteSegmentKind = "literal" | "param" | "wildcard";

/** A single compiled segment of a route path. */
export interface RouteSegment {
  kind: RouteSegmentKind;
  value: string;
}

/** A route that can be matched against the segments of a request path. */
export interface MatchableRoute {
  method: string;
  path: string;
  segments: RouteSegment[];
  handler: unknown;
}

/** Rejects route paths that are not usable as a route. */
function assertRoutePathValue(path: string): void {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new MuboError("CONFIG_ERROR", `Route path must be a non-empty string: ${String(path)}`);
  }
}

/** Rejects route paths that carry a query string or a fragment. */
function assertRoutePathHasNoQuery(path: string): void {
  if (path.includes("?") || path.includes("#")) {
    throw new MuboError("CONFIG_ERROR", `must not contain a query or fragment: ${path}`);
  }
}

/** Rejects route paths that contain control characters. */
function assertRoutePathHasNoControlCharacters(path: string): void {
  if (path.includes("\0") || /[\x01-\x1F\x7F]/.test(path)) {
    throw new MuboError("CONFIG_ERROR", `Route path contains invalid control characters: ${path}`);
  }
}

/** Applies the shared route path syntax rules. */
function assertRoutePathSyntax(path: string): void {
  assertRoutePathHasNoQuery(path);
  assertRoutePathHasNoControlCharacters(path);
}

/** Splits a path into segments, dropping leading and trailing slashes. */
function splitSegments(path: string): string[] {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? [] : trimmed.split("/");
}

/** Decodes a percent-encoded value, returning the raw value when it is malformed. */
function decodeLiteral(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Collapses repeated slashes and trims leading/trailing slashes. Returns "/" for empty or slash-only paths. */
export function normalizePath(path: string): string {
  const collapsed = path.replace(/\/+/g, "/");
  const trimmed = collapsed.replace(/^\/+|\/+$/g, "");
  return trimmed.length ? `/${trimmed}` : "/";
}

/** Validates and normalizes a route path, rejecting queries, fragments, and control characters. */
export function normalizeRoutePath(path: string): string {
  assertRoutePathValue(path);
  assertRoutePathSyntax(path);
  return normalizePath(path);
}

/** Decodes a URL path component, throwing on malformed percent-encoding. */
export function decodeRoutePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    throw new MuboError("BAD_REQUEST", `Malformed percent-encoding in URL: ${path}`);
  }
}

/** Decodes and normalizes a lookup path, returning undefined if segments contain slashes. */
export function decodeLookupPath(path: string): string | undefined {
  const segments = path.split("/").map((segment) => decodeRoutePath(segment));
  if (segments.some((segment) => segment.includes("/"))) return undefined;
  return normalizePath(segments.join("/"));
}

/** Creates a stable identity string for a route path by normalizing and encoding segments. */
export function routeIdentity(path: string): string {
  const normalized = normalizePath(path);
  const segments = normalized === "/" ? [] : normalized.slice(1).split("/");
  return JSON.stringify(
    segments.map((segment) => {
      try {
        return ["decoded", decodeURIComponent(segment)];
      } catch {
        return ["raw", segment];
      }
    }),
  );
}

/** Compiles a route path into an array of segments, validating parameter names and wildcard placement. */
export function compileRouteSegments(path: string): RouteSegment[] {
  assertRoutePathValue(path);
  if (!path.startsWith("/")) {
    throw new MuboError("CONFIG_ERROR", `Route path must start with "/": ${path}`);
  }
  assertRoutePathSyntax(path);
  const raw = splitSegments(path);
  const parameters = new Set<string>();
  return raw.map((part, index) => {
    if (part === "*") {
      if (index !== raw.length - 1) {
        throw new MuboError("CONFIG_ERROR", `Wildcard route segment must be last: ${path}`);
      }
      return { kind: "wildcard" as const, value: "*" };
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
      return { kind: "param" as const, value: name };
    }
    if (part === "") {
      throw new MuboError("CONFIG_ERROR", `Route path contains an empty segment: ${path}`);
    }
    return { kind: "literal" as const, value: part };
  });
}

/** Creates the lookup key of a route path, distinguishing literals, parameters and wildcards. */
export function routeKey(path: string): string {
  return JSON.stringify(
    splitSegments(path).map((segment) => {
      if (segment === "*") return ["wildcard", segment];
      if (segment.startsWith(":")) return ["param", segment];
      return ["literal", decodeLiteral(segment)];
    }),
  );
}

/** Decodes a URL path component, throwing on malformed percent-encoding. */
export function decode(value: string): string {
  return decodeRoutePath(value);
}

/** Compares two route path segments, supporting both decoded and literal matching. */
export function literalMatches(part: string, expected: string): boolean {
  const decoded = decode(part);
  return decoded === expected || decodeLiteral(expected) === decoded;
}

/** Splits a pathname into segments, removing leading/trailing slashes. */
export function pathSegments(pathname: string): string[] {
  return splitSegments(pathname);
}

/** Matches route segments against URL path parts, collecting parameter values. */
export function matchSegments(
  route: { segments: RouteSegment[] },
  parts: string[],
): Record<string, string> | null {
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

/** Returns a numeric specificity weight for a route segment: literal=3, param=2, wildcard=1. */
export function segmentSpecificity(segment: { kind: RouteSegmentKind } | undefined): number {
  if (!segment) return 4;
  if (segment.kind === "literal") return 3;
  if (segment.kind === "param") return 2;
  return 1;
}

/** Compares two routes' segment specificity, returning true if the first is more specific. */
export function isMoreSpecific(
  route: { segments: RouteSegment[] },
  than: { segments: RouteSegment[] },
): boolean {
  const length = Math.max(route.segments.length, than.segments.length);
  for (let index = 0; index < length; index++) {
    const difference =
      segmentSpecificity(route.segments[index]) - segmentSpecificity(than.segments[index]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** Finds the best matching route from a list, prioritizing more specific paths. */
export function findBestMatch<Route extends MatchableRoute>(
  routes: readonly Route[],
  method: string,
  parts: string[],
): { route: Route; params: Record<string, string> } | undefined {
  let best: { route: Route; params: Record<string, string> } | undefined;
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchSegments(route, parts);
    if (params !== null && (!best || isMoreSpecific(route, best.route))) {
      best = { route, params };
    }
  }
  return best;
}
