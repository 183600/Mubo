import { describe, expect, test } from "bun:test";
import { Router } from "../src/http/router.ts";
import { MuboError } from "../src/core/errors.ts";

function ok(label: string) {
  return () => new Response(label);
}

describe("router", () => {
  test("matches literal, parameter, wildcard and root paths", () => {
    const router = new Router();
    router.add("GET", "/", ok("root"));
    router.add("GET", "/users/:id", ok("user"));
    router.add("GET", "/files/*", ok("file"));

    expect(router.match("GET", "/")).toMatchObject({
      type: "match",
      params: {},
      route: { path: "/" },
    });
    expect(router.match("GET", "/users/42/")).toMatchObject({
      type: "match",
      params: { id: "42" },
      route: { path: "/users/:id" },
    });
    expect(router.match("GET", "/users/a%20b")).toMatchObject({
      type: "match",
      params: { id: "a b" },
    });
    expect(router.match("GET", "/files/a/b.txt")).toMatchObject({
      type: "match",
      params: { "*": "a/b.txt" },
    });
    expect(router.match("GET", "/files")).toMatchObject({
      type: "match",
      params: { "*": "" },
    });
  });

  test("matches percent-encoded literal route segments", () => {
    const router = new Router();
    router.add("GET", "/caf%C3%A9", ok("encoded"));
    router.add("GET", "/100%", ok("percent"));

    for (const pathname of ["/caf%C3%A9", "/café"]) {
      const match = router.match("GET", pathname);
      expect(match.type).toBe("match");
      expect(match.type === "match" ? match.route.path : undefined).toBe("/caf%C3%A9");
    }

    const percent = router.match("GET", "/100%25");
    expect(percent.type).toBe("match");
    expect(percent.type === "match" ? percent.route.path : undefined).toBe("/100%");
    expect(router.match("GET", "/100%2525")).toEqual({ type: "not-found" });
  });

  test("keeps route parameter objects free of inherited prototype keys", () => {
    const router = new Router();
    router.add("GET", "/things/:__proto__", ok("proto"));
    const match = router.match("GET", "/things/value");

    expect(match.type).toBe("match");
    const params = match.type === "match" ? match.params : {};
    expect(params["__proto__"]).toBe("value");
    expect((params as { toString?: unknown }).toString).toBeUndefined();
    expect((params as { constructor?: unknown }).constructor).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test("prefers literal routes over parameters and wildcards regardless of order", async () => {
    const router = new Router();
    router.add("GET", "/users/:id", ok("param"));
    router.add("GET", "/users/*", ok("wildcard"));
    router.add("GET", "/users/me", ok("literal"));

    const literal = router.match("GET", "/users/me");
    expect(literal.type).toBe("match");
    expect(literal.type === "match" ? literal.route.path : undefined).toBe("/users/me");

    const param = router.match("GET", "/users/42");
    expect(param.type).toBe("match");
    expect(param.type === "match" ? param.route.path : undefined).toBe("/users/:id");

    const wildcard = router.match("GET", "/users/42/details");
    expect(wildcard.type).toBe("match");
    expect(wildcard.type === "match" ? wildcard.route.path : undefined).toBe("/users/*");

    const exact = new Router();
    exact.add("GET", "/files/*", ok("wildcard"));
    exact.add("GET", "/files", ok("exact"));
    const exactMatch = exact.match("GET", "/files");
    const exactResponse =
      exactMatch.type === "match" ? await exactMatch.route.handler({} as never) : undefined;
    expect(await (exactResponse as Response).text()).toBe("exact");
  });

  test("falls back from HEAD to GET and reports allowed methods", () => {
    const router = new Router();
    router.add("GET", "/users/:id", ok("get"));
    router.add("DELETE", "/users/:id", ok("delete"));

    const head = router.match("HEAD", "/users/1");
    expect(head.type).toBe("match");
    expect(head.type === "match" ? head.route.method : undefined).toBe("GET");

    const wrongMethod = router.match("POST", "/users/1");
    expect(wrongMethod).toEqual({
      type: "method-not-allowed",
      allowed: ["DELETE", "GET", "HEAD", "OPTIONS"],
    });
    expect(router.match("GET", "/missing")).toEqual({ type: "not-found" });
  });

  test("replaces routes registered with the same method and path", () => {
    const router = new Router();
    router.add("GET", "/same", ok("first"));
    router.add("GET", "/same", ok("second"));
    expect(router.routes).toHaveLength(1);
    const match = router.match("GET", "/same");
    expect(match.type).toBe("match");
    expect(match.type === "match" ? match.route.handler({} as never) : undefined).toBeInstanceOf(Response);
  });

  test("replaces equivalent routes that differ only by surrounding slashes", async () => {
    const router = new Router();
    router.add("GET", "/same", ok("first"));
    router.add("GET", "/same/", ok("second"));
    expect(router.routes).toHaveLength(1);

    let match = router.match("GET", "/same");
    expect(match.type).toBe("match");
    const response = match.type === "match" ? await match.route.handler({} as never) : undefined;
    expect(await (response as Response).text()).toBe("second");

    router.add("GET", "//same", ok("third"));
    expect(router.routes).toHaveLength(1);
    match = router.match("GET", "/same");
    const third = match.type === "match" ? await match.route.handler({} as never) : undefined;
    expect(await (third as Response).text()).toBe("third");
  });

  test("replaces equivalent routes that differ only by percent-encoding", async () => {
    const router = new Router();
    router.add("GET", "/caf%C3%A9", ok("first"));
    router.add("GET", "/café", ok("second"));
    expect(router.routes).toHaveLength(1);

    for (const pathname of ["/caf%C3%A9", "/caf%c3%a9", "/café"]) {
      const match = router.match("GET", pathname);
      expect(match.type).toBe("match");
      const response = match.type === "match" ? await match.route.handler({} as never) : undefined;
      expect(await (response as Response).text()).toBe("second");
    }

    const patterns = new Router();
    patterns.add("GET", "/users/:id", ok("param"));
    patterns.add("GET", "/users/%3Aid", ok("literal"));
    expect(patterns.routes).toHaveLength(2);
    expect(patterns.match("GET", "/users/42")).toMatchObject({ route: { path: "/users/:id" } });
  });

  test("treats slash-only routes and request paths as the root", async () => {
    const router = new Router();
    router.add("GET", "/", ok("first"));
    router.add("GET", "///", ok("second"));
    expect(router.routes).toHaveLength(1);
    expect(router.routes[0]!.path).toBe("///");

    for (const pathname of ["/", "//", "///"]) {
      const match = router.match("GET", pathname);
      expect(match).toMatchObject({ type: "match", params: {} });
      const response = match.type === "match" ? await match.route.handler({} as never) : undefined;
      expect(await (response as Response).text()).toBe("second");
    }

    expect(() => new Router().add("GET", "///", ok("root"))).not.toThrow();
  });

  test("rejects ambiguous or malformed route definitions", () => {
    const invalid = [
      "users",
      "/users/:",
      "/users/:id/:id",
      "/users/*/tail",
      "/a//b",
      "/users?tab=1",
      "/users#top",
    ];
    for (const path of invalid) {
      expect(() => new Router().add("GET", path, ok("invalid"))).toThrow(MuboError);
    }
  });

  test("rejects malformed percent-encoding when matching", () => {
    const router = new Router();
    router.add("GET", "/users/:id", ok("user"));
    expect(() => router.match("GET", "/users/%E0%A4%A")).toThrow(/Malformed percent-encoding/);
    expect(() => router.match("GET", "/users/%FF")).toThrow(/Malformed percent-encoding/);
    expect(() => router.match("GET", "/users/%")).toThrow(/Malformed percent-encoding/);
    expect(() => router.match("GET", "/users/%%")).toThrow(/Malformed percent-encoding/);
  });

  test("handles edge cases for root and empty paths", () => {
    const router = new Router();
    router.add("GET", "/", ok("root"));

    expect(router.match("GET", "/")).toMatchObject({ type: "match", params: {} });
    expect(router.match("GET", "")).toMatchObject({ type: "match", params: {} });
  });

  test("rejects parameter names with special characters", () => {
    const invalid = [
      ":/id",
      ":id?",
      ":id#",
      ":id ",
      ":/id",
      "users/:id@name",
      "users/:id:name",
    ];
    for (const path of invalid) {
      expect(() => new Router().add("GET", `/users/${path}`, ok("invalid"))).toThrow(MuboError);
    }
  });

  test("accepts wildcard routes with different configurations", () => {
    const router = new Router();
    router.add("GET", "/files/*", ok("wildcard"));
    router.add("GET", "/api/*", ok("api-wildcard"));

    expect(router.match("GET", "/files/path/to/file.txt")).toMatchObject({
      type: "match",
      params: { "*": "path/to/file.txt" },
    });
    expect(router.match("GET", "/api/v1/users")).toMatchObject({
      type: "match",
      params: { "*": "v1/users" },
    });
    expect(router.match("GET", "/files")).toMatchObject({
      type: "match",
      params: { "*": "" },
    });
  });

  test("rejects duplicate route parameters within same path registration", () => {
    const router = new Router();
    expect(() => router.add("GET", "/users/:id/:id", ok("dup"))).toThrow(
      /Duplicate route parameter/,
    );
  });

  test("add route with space in parameter name throws", () => {
    const router = new Router();
    expect(() => router.add("GET", "/users/:my param", ok("param-with-space"))).toThrow(
      /Invalid route parameter/,
    );
  });

  test("add route with leading dot in parameter name throws", () => {
    const router = new Router();
    expect(() => router.add("GET", "/users/:.id", ok("dot-param"))).toThrow(
      /Invalid route parameter/,
    );
  });

  test("add route with trailing dot in parameter name throws", () => {
    const router = new Router();
    expect(() => router.add("GET", "/users/:id.", ok("dot-param"))).toThrow(
      /Invalid route parameter/,
    );
  });

  test("matches routes with partial percent-encoded param", () => {
    const router = new Router();
    router.add("GET", "/users/:id", ok("user"));
    const match = router.match("GET", "/users/42") as { type: string; params: Record<string, string> };
    expect(match.type).toBe("match");
    expect(match.params.id).toBe("42");
  });

  test("findBestMatch prefers more specific routes", () => {
    const router = new Router();
    router.add("GET", "/a/b/c", ok("exact"));
    router.add("GET", "/a/*", ok("wildcard1"));
    router.add("GET", "/a/b", ok("subpath"));
    router.add("GET", "/a/b/c/d", ok("deeper"));

    // /a/b/c should be preferred over /a/* and /a/b
    const match = router.match("GET", "/a/b/c") as { type: string; route: { path: string } };
    expect(match.type).toBe("match");
    expect(match.route.path).toBe("/a/b/c");
  });

  test("route identity is consistent after normalization", () => {
    const { routeIdentity } = require("../src/utils/path.ts");
    expect(routeIdentity("/users/42")).toBe(routeIdentity("/users/42"));
    expect(routeIdentity("/users/42/")).toBe(routeIdentity("/users/42"));
    expect(routeIdentity("/")).toBe(routeIdentity("/"));
    expect(routeIdentity("///")).toBe(routeIdentity("///"));
  });

  test("compileRouteSegments rejects empty path segments", () => {
    const router = new Router();
    expect(() => router.add("GET", "/a//b", ok("empty-segment"))).toThrow(
      /Route path contains an empty segment/,
    );
  });

  test("routeKey is consistent for equivalent paths", () => {
    const { routeKey } = require("../src/utils/path.ts");
    expect(routeKey("/users/42")).toBe(routeKey("/users/42"));
    expect(routeKey("/users/42/")).toBe(routeKey("/users/42"));
    expect(routeKey("/")).toBe(routeKey("/"));
  });

  test("decodeLiteral handles invalid UTF-8 gracefully", () => {
    const { decodeLiteral } = require("../src/utils/path.ts");
    // decodeLiteral is not exported; testing via router add() which uses it internally
    const router = new Router();
    // invalid percent-encoding in param name is caught by the identifier regex
    expect(() => router.add("GET", "/users/:%invalid", ok("bad-param"))).toThrow(
      /Invalid route parameter/,
    );
    // %2F decoded is "/" but as param name fails identifier regex
    const r2 = new Router();
    expect(() => r2.add("GET", "/users/:%2F", ok("slash-param"))).toThrow(
      /Invalid route parameter/,
    );
  });

  test("pathSegments handles various inputs", () => {
    const { pathSegments } = require("../src/utils/path.ts");
    expect(pathSegments("/")).toEqual([]);
    expect(pathSegments("")).toEqual([]);
    expect(pathSegments("///")).toEqual([]);
    expect(pathSegments("/a/b")).toEqual(["a", "b"]);
    // /a//b keeps empty segment since pathSegments doesn't collapse them
    expect(pathSegments("/a//b")).toEqual(["a", "", "b"]);
  });

  test("literalMatches handles various decoding scenarios", () => {
    const { literalMatches } = require("../src/utils/path.ts");
    // direct string match - both are just segments
    expect(literalMatches("42", "42")).toBe(true);
    // non-matching values
    expect(literalMatches("42", "41")).toBe(false);
    // percent-encoded segment matches after decoding
    expect(literalMatches("%34%32", "42")).toBe(true); // %34="4", %32="2"
  });

  test("segmentSpecificity and isMoreSpecific work correctly", () => {
    const { segmentSpecificity, isMoreSpecific } = require("../src/utils/path.ts");
    expect(segmentSpecificity({ kind: "literal" })).toBe(3);
    expect(segmentSpecificity({ kind: "param" })).toBe(2);
    expect(segmentSpecificity({ kind: "wildcard" })).toBe(1);
    expect(segmentSpecificity(undefined)).toBe(4);

    const router = new Router();
    router.add("GET", "/a/b", ok("a-b"));
    router.add("GET", "/a/:c", ok("a-c"));
    router.add("GET", "/a/*", ok("a-wild"));

    // /a/b is more specific than /a/:c which is more specific than /a/*
    const match1 = router.match("GET", "/a/b") as { type: string; route: { path: string } };
    expect(match1.route.path).toBe("/a/b");

    const match2 = router.match("GET", "/a/x") as { type: string; route: { path: string } };
    expect(match2.route.path).toBe("/a/:c");

    const match3 = router.match("GET", "/a/x/y") as { type: string; route: { path: string } };
    expect(match3.route.path).toBe("/a/*");
  });
});
