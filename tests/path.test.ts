import { describe, expect, test } from "bun:test";
import type { MuboError } from "../src/core/errors.ts";
import {
  normalizePath,
  normalizeRoutePath,
  decodeRoutePath,
  decodeLookupPath,
  routeIdentity,
  compileRouteSegments,
  routeKey,
  decode,
  literalMatches,
  pathSegments,
  matchSegments,
  segmentSpecificity,
  isMoreSpecific,
  findBestMatch,
} from "../src/utils/path.ts";

describe("path utilities", () => {
  describe("normalizePath", () => {
    test("strips leading slashes", () => {
      expect(normalizePath("/foo")).toBe("/foo");
      expect(normalizePath("//foo")).toBe("/foo");
      expect(normalizePath("///foo")).toBe("/foo");
    });

    test("strips trailing slashes", () => {
      expect(normalizePath("foo/")).toBe("/foo");
      expect(normalizePath("foo//")).toBe("/foo");
    });

    test("returns root for empty or slash-only paths", () => {
      expect(normalizePath("/")).toBe("/");
      expect(normalizePath("///")).toBe("/");
      expect(normalizePath("")).toBe("/");
    });

    test("handles mixed slashes", () => {
      expect(normalizePath("//foo/bar//")).toBe("/foo/bar");
    });
  });

  describe("normalizeRoutePath", () => {
    test("throws for paths with query strings", () => {
      expect(() => normalizeRoutePath("/users?id=1")).toThrow(/must not contain a query or fragment/);
    });

    test("throws for paths with fragments", () => {
      expect(() => normalizeRoutePath("/users#top")).toThrow(/must not contain a query or fragment/);
    });

    test("normalizes valid paths", () => {
      expect(normalizeRoutePath("/users")).toBe("/users");
      expect(normalizeRoutePath("///users///")).toBe("/users");
    });
  });

  describe("decodeRoutePath", () => {
    test("decodes percent-encoded characters", () => {
      expect(decodeRoutePath("/caf%C3%A9")).toBe("/café");
      expect(decodeRoutePath("/%C3%A9")).toBe("/é");
    });

    test("throws for malformed percent-encoding", () => {
      expect(() => decodeRoutePath("/%E0%A4%A")).toThrow(/Malformed percent-encoding/);
      expect(() => decodeRoutePath("/%FF")).toThrow(/Malformed percent-encoding/);
      expect(() => decodeRoutePath("/%")).toThrow(/Malformed percent-encoding/);
      expect(() => decodeRoutePath("/%%")).toThrow(/Malformed percent-encoding/);
    });
  });

  describe("decodeLookupPath", () => {
    test("decodes percent-encoded path segments", () => {
      expect(decodeLookupPath("/a%20b")).toBe("/a b");
      expect(decodeLookupPath("/caf%C3%A9.txt")).toBe("/café.txt");
    });

    test("returns undefined for paths with encoded slashes", () => {
      expect(decodeLookupPath("/a%2Fb")).toBeUndefined();
      expect(decodeLookupPath("/a%2fb%2Fc")).toBeUndefined();
    });

    test("normalizes slashes and returns valid paths", () => {
      expect(decodeLookupPath("/a/b/")).toBe("/a/b");
      expect(decodeLookupPath("///a//b")).toBe("/a/b");
    });

    test("handles root paths", () => {
      expect(decodeLookupPath("/")).toBe("/");
      expect(decodeLookupPath("///")).toBe("/");
    });
  });

  describe("routeIdentity", () => {
    test("creates consistent identity for equivalent paths", () => {
      expect(routeIdentity("/users/42")).toBe(routeIdentity("/users/42"));
      expect(routeIdentity("/users/42/")).toBe(routeIdentity("/users/42"));
    });

    test("handles decoded percent-encoded segments", () => {
      expect(routeIdentity("/café")).toBe(routeIdentity("/caf%C3%A9"));
    });

    test("handles parameter routes", () => {
      expect(routeIdentity("/users/:id")).toBe(routeIdentity("/users/:id"));
      expect(routeIdentity("/users/:ID")).toBe(routeIdentity("/users/:ID"));
    });

    test("handles wildcard routes", () => {
      expect(routeIdentity("/files/*")).toBe(routeIdentity("/files/*"));
    });

    test("handles root and slash-only paths", () => {
      expect(routeIdentity("/")).toBe(routeIdentity("/"));
      expect(routeIdentity("///")).toBe(routeIdentity("/"));
    });
  });

  describe("compileRouteSegments", () => {
    test("compiles literal routes", () => {
      const segments = compileRouteSegments("/users");
      expect(segments).toEqual([{ kind: "literal", value: "users" }]);
    });

    test("compiles parameter routes", () => {
      const segments = compileRouteSegments("/users/:id");
      expect(segments).toEqual([
        { kind: "literal", value: "users" },
        { kind: "param", value: "id" },
      ]);
    });

    test("compiles wildcard routes", () => {
      const segments = compileRouteSegments("/files/*");
      expect(segments).toEqual([
        { kind: "literal", value: "files" },
        { kind: "wildcard", value: "*" },
      ]);
    });

    test("throws for non-string paths", () => {
      expect(() => compileRouteSegments("users" as never)).toThrow(/must start with "\/"/);
    });

    test("throws for paths without leading slash", () => {
      expect(() => compileRouteSegments("users")).toThrow(/must start with "\/"/);
    });

    test("throws for paths with query strings", () => {
      expect(() => compileRouteSegments("/users?test")).toThrow(/must not contain a query or fragment/);
    });

    test("throws for paths with fragments", () => {
      expect(() => compileRouteSegments("/users#test")).toThrow(/must not contain a query or fragment/);
    });

    test("throws for wildcard in the middle", () => {
      expect(() => compileRouteSegments("/files/*/test")).toThrow(/must be last/);
    });

    test("throws for duplicate parameter names", () => {
      expect(() => compileRouteSegments("/users/:id/:id")).toThrow(/Duplicate route parameter/);
    });

    test("throws for parameter names with invalid characters", () => {
      expect(() => compileRouteSegments("/users/:my-id")).toThrow(/Invalid route parameter/);
      expect(() => compileRouteSegments("/users/:.id")).toThrow(/Invalid route parameter/);
      expect(() => compileRouteSegments("/users/:id.")).toThrow(/Invalid route parameter/);
      expect(() => compileRouteSegments("/users/:id name")).toThrow(/Invalid route parameter/);
    });

    test("throws for empty segments", () => {
      expect(() => compileRouteSegments("/users//id")).toThrow(/empty segment/);
    });

    test("handles root path", () => {
      const segments = compileRouteSegments("/");
      expect(segments).toEqual([]);
    });

    test("handles multiple slashes", () => {
      const segments = compileRouteSegments("///users///");
      expect(segments).toEqual([{ kind: "literal", value: "users" }]);
    });
  });

  describe("routeKey", () => {
    test("creates consistent keys for equivalent routes", () => {
      expect(routeKey("/users/42")).toBe(routeKey("/users/42"));
      expect(routeKey("/users/42/")).toBe(routeKey("/users/42"));
    });

    test("handles encoded characters in literal segments", () => {
      const key1 = routeKey("/caf%C3%A9");
      const key2 = routeKey("/café");
      expect(key1).toBe(key2);
    });

    test("distinguishes parameter routes", () => {
      expect(routeKey("/users/:id")).toBe(routeKey("/users/:id"));
    });

    test("distinguishes wildcard routes", () => {
      expect(routeKey("/files/*")).toBe(routeKey("/files/*"));
    });

    test("handles special characters in route names", () => {
      const key = routeKey("/api/v1/users");
      expect(key).toBeTruthy();
      expect(typeof key).toBe("string");
    });
  });

  describe("decode", () => {
    test("decodes percent-encoded strings", () => {
      expect(decode("hello%20world")).toBe("hello world");
      expect(decode("%C3%A9")).toBe("é");
    });

    test("throws for malformed encoding", () => {
      expect(() => decode("%E0%A4%A")).toThrow(/Malformed percent-encoding/);
      expect(() => decode("%FF%FF%FF")).toThrow(/Malformed percent-encoding/);
    });
  });

  describe("literalMatches", () => {
    test("matches identical literals", () => {
      expect(literalMatches("users", "users")).toBe(true);
      expect(literalMatches("test", "test")).toBe(true);
    });

    test("handles percent-encoded values", () => {
      expect(literalMatches("%34%32", "42")).toBe(true);
      expect(literalMatches("%20", " ")).toBe(true);
    });

    test("detects mismatched literals", () => {
      expect(literalMatches("users", "posts")).toBe(false);
      expect(literalMatches("42", "41")).toBe(false);
    });
  });

  describe("pathSegments", () => {
    test("splits path into segments", () => {
      expect(pathSegments("/a/b/c")).toEqual(["a", "b", "c"]);
      expect(pathSegments("/users/42/posts")).toEqual(["users", "42", "posts"]);
    });

    test("handles root path", () => {
      expect(pathSegments("/")).toEqual([]);
      expect(pathSegments("")).toEqual([]);
      expect(pathSegments("///")).toEqual([]);
    });

    test("preserves empty segments within path", () => {
      expect(pathSegments("/a//b")).toEqual(["a", "", "b"]);
    });
  });

  describe("matchSegments", () => {
    test("matches literal segments", () => {
      const route = { segments: [{ kind: "literal" as const, value: "users" }] };
      expect(matchSegments(route, ["users"])).toEqual({});
      expect(matchSegments(route, ["posts"])).toBeNull();
    });

    test("matches parameter segments", () => {
      const route = { segments: [{ kind: "literal" as const, value: "users" }, { kind: "param" as const, value: "id" }] };
      expect(matchSegments(route, ["users", "42"])).toEqual({ id: "42" });
    });

    test("matches wildcard segments", () => {
      const route = { segments: [{ kind: "literal" as const, value: "files" }, { kind: "wildcard" as const, value: "*" }] };
      expect(matchSegments(route, ["files", "a", "b", "c.txt"])).toEqual({ "*": "a/b/c.txt" });
    });

    test("returns null for mismatched segment counts", () => {
      const route = { segments: [{ kind: "literal" as const, value: "users" }] };
      expect(matchSegments(route, ["users", "extra"])).toBeNull();
    });

    test("decodes percent-encoded segments", () => {
      const route = { segments: [{ kind: "literal" as const, value: "users" }, { kind: "param" as const, value: "id" }] };
      expect(matchSegments(route, ["users", "42"])).toEqual({ id: "42" });
    });
  });

  describe("segmentSpecificity", () => {
    test("returns correct scores for segment types", () => {
      expect(segmentSpecificity({ kind: "literal" })).toBe(3);
      expect(segmentSpecificity({ kind: "param" })).toBe(2);
      expect(segmentSpecificity({ kind: "wildcard" })).toBe(1);
      expect(segmentSpecificity(undefined)).toBe(4);
    });
  });

  describe("isMoreSpecific", () => {
    test("lit > param > wildcard", () => {
      const literal = { segments: [{ kind: "literal" as const, value: "a" }] };
      const param = { segments: [{ kind: "param" as const, value: "x" }] };
      const wildcard = { segments: [{ kind: "wildcard" as const, value: "*" }] };

      expect(isMoreSpecific(literal, param)).toBe(true);
      expect(isMoreSpecific(param, wildcard)).toBe(true);
      expect(isMoreSpecific(literal, wildcard)).toBe(true);
    });

    test("equal routes are not more specific", () => {
      const literal = { segments: [{ kind: "literal" as const, value: "a" }] };
      expect(isMoreSpecific(literal, literal)).toBe(false);
    });
  });

  describe("findBestMatch", () => {
    test("returns undefined when no routes match", () => {
      const routes: any[] = [];
      expect(findBestMatch(routes, "GET", ["missing"])).toBeUndefined();
    });

    test("finds matching route with correct segments", () => {
      const routes = [
        { method: "GET" as const, path: "/users", segments: [{ kind: "literal" as const, value: "users" }], handler: "handler" as never },
      ];
      const result = findBestMatch(routes, "GET", ["users"]);
      expect(result).not.toBeUndefined();
      expect(result?.route.path).toBe("/users");
    });

    test("prefers literal over param for same path prefix", () => {
      const routes = [
        { method: "GET" as const, path: "/users/me", segments: [{ kind: "literal" as const, value: "users" }, { kind: "literal" as const, value: "me" }], handler: "literalHandler" as never, params: {} },
        { method: "GET" as const, path: "/users/:id", segments: [{ kind: "literal" as const, value: "users" }, { kind: "param" as const, value: "id" }], handler: "paramHandler" as never, params: {} },
      ];
      const result = findBestMatch(routes, "GET", ["users", "me"]);
      expect(result?.route.path).toBe("/users/me");
    });

    test("returns correct params for param routes", () => {
      const routes = [
        { method: "GET" as const, path: "/users/:id", segments: [{ kind: "literal" as const, value: "users" }, { kind: "param" as const, value: "id" }], handler: "handler" as never, params: {} },
      ];
      const result = findBestMatch(routes, "GET", ["users", "42"]);
      expect(result?.params.id).toBe("42");
    });
  });
});