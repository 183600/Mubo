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
  });
});
