import { MuboError } from "../core/errors.ts";

export function normalizePath(path: string): string {
  const collapsed = path.replace(/\/+/g, "/");
  const trimmed = collapsed.replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "/";
}

export function normalizeRoutePath(path: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new MuboError("CONFIG_ERROR", `Route path must be a non-empty string: ${String(path)}`);
  }
  if (path.includes("?") || path.includes("#")) {
    throw new MuboError("CONFIG_ERROR", `must not contain a query or fragment: ${path}`);
  }
  return normalizePath(path);
}

export function decodeRoutePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    throw new MuboError("BAD_REQUEST", `Malformed percent-encoding in URL: ${path}`);
  }
}

export function decodeLookupPath(path: string): string | undefined {
  const segments = path.split("/").map((segment) => decodeRoutePath(segment));
  if (segments.some((segment) => segment.includes("/"))) return undefined;
  return normalizePath(segments.join("/"));
}

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

export function compileRouteSegments(path: string): { kind: "literal" | "param" | "wildcard"; value: string }[] {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new MuboError("CONFIG_ERROR", `Route path must be a non-empty string: ${String(path)}`);
  }
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

export function routeKey(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const segments = trimmed === "" ? [] : trimmed.split("/");
  return JSON.stringify(
    segments.map((segment) => {
      if (segment === "*") return ["wildcard", segment];
      if (segment.startsWith(":")) return ["param", segment];
      return ["literal", decodeLiteral(segment)];
    }),
  );
}

function decodeLiteral(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new MuboError("BAD_REQUEST", `Malformed percent-encoding in URL: ${value}`);
  }
}

export function literalMatches(part: string, expected: string): boolean {
  const decoded = decode(part);
  return decoded === expected || decodeLiteral(expected) === decoded;
}

export function pathSegments(pathname: string): string[] {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? [] : trimmed.split("/");
}

export function matchSegments(
  route: { segments: { kind: "literal" | "param" | "wildcard"; value: string }[] },
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

export function segmentSpecificity(segment: { kind: "literal" | "param" | "wildcard" } | undefined): number {
  if (!segment) return 4;
  if (segment.kind === "literal") return 3;
  if (segment.kind === "param") return 2;
  return 1;
}

export function isMoreSpecific(
  route: { segments: { kind: "literal" | "param" | "wildcard" }[] },
  than: { segments: { kind: "literal" | "param" | "wildcard" }[] },
): boolean {
  const length = Math.max(route.segments.length, than.segments.length);
  for (let index = 0; index < length; index++) {
    const difference =
      segmentSpecificity(route.segments[index]) - segmentSpecificity(than.segments[index]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export function findBestMatch(
  routes: readonly { method: string; path: string; segments: { kind: "literal" | "param" | "wildcard"; value: string }[]; handler: unknown }[],
  method: string,
  parts: string[],
): { route: typeof routes[0]; params: Record<string, string> } | undefined {
  let best: { route: typeof routes[0]; params: Record<string, string> } | undefined;
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchSegments(route, parts);
    if (params !== null && (!best || isMoreSpecific(route, best.route))) {
      best = { route, params };
    }
  }
  return best;
}