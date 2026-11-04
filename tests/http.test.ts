import { afterEach, describe, expect, test } from "bun:test";
import { createMuboApp, type MuboApp } from "../src/index.ts";
import { MuboError } from "../src/core/errors.ts";
import { defineSchema } from "../src/db/schema.ts";

const apps: MuboApp[] = [];
async function startApp(...args: Parameters<typeof createMuboApp>): Promise<MuboApp> {
  const app = await createMuboApp(args[0], { ...(args[1] ?? {}), argv: [] });
  await app.start();
  apps.push(app);
  return app;
}
function base(app: MuboApp): string {
  return `http://127.0.0.1:${app.port}`;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.stop();
});

const schema = defineSchema({
  tables: {
    users: {
      columns: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        name: { type: "text", notNull: true },
      },
    },
  },
});

describe("HTTP routing and middleware", () => {
  test("routes params/query/body, runs middleware in order, and registers request ids", async () => {
    const order: string[] = [];
    const app = await startApp({
      app: { name: "http-test", env: "test" },
      db: { path: ":memory:" },
      schema,
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.use(async (ctx, next) => {
      order.push("one-before");
      ctx.set("value", 41);
      const response = await next();
      order.push("one-after");
      response.headers.set("x-middleware", "yes");
      return response;
    });
    app.use(async (ctx, next) => {
      order.push("two-before");
      const response = await next();
      order.push("two-after");
      return response;
    });
    app.get("/users/:id", (ctx) =>
      ctx.json({
        id: ctx.params.id,
        tab: ctx.query.get("tab"),
        value: ctx.get<number>("value"),
      }),
    );
    app.post("/echo", async (ctx) => ctx.json({ body: await ctx.body() }));
    app.post("/form", async (ctx) => {
      const form = await ctx.form();
      return ctx.json({ value: form.get("value") });
    });
    app.get("/files/*", (ctx) => ctx.json({ path: ctx.params["*"] }));
    app.get("/explicit-head", () => new Response("get", { headers: { "x-handler": "get" } }));
    app.head("/explicit-head", () => new Response(null, { status: 200, headers: { "x-handler": "head" } }));
    app.get("/failure", () => {
      throw new MuboError("VALIDATION_ERROR", "broken input");
    });
    app.get("/raw", () => new Response("raw", { status: 201 }));

    const userResponse = await fetch(`${base(app)}/users/42?tab=profile`, {
      headers: { "x-request-id": "req-123" },
    });
    expect(userResponse.status).toBe(200);
    expect(userResponse.headers.get("x-request-id")).toBe("req-123");
    expect(userResponse.headers.get("x-middleware")).toBe("yes");
    expect(await userResponse.json()).toEqual({ id: "42", tab: "profile", value: 41 });
    expect(order).toEqual(["one-before", "two-before", "two-after", "one-after"]);

    const echo = await fetch(`${base(app)}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(await echo.json()).toEqual({ body: { hello: "world" } });

    const form = await fetch(`${base(app)}/form`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "value=hello",
    });
    expect(await form.json()).toEqual({ value: "hello" });

    const wildcard = await fetch(`${base(app)}/files/a/b.txt`);
    expect(await wildcard.json()).toEqual({ path: "a/b.txt" });

    const head = await fetch(`${base(app)}/users/42`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const explicitHead = await fetch(`${base(app)}/explicit-head`, { method: "HEAD" });
    expect(explicitHead.headers.get("x-handler")).toBe("head");

    const invalid = await fetch(`${base(app)}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as any).error.code).toBe("VALIDATION_ERROR");

    const failure = await fetch(`${base(app)}/failure`);
    expect(failure.status).toBe(422);
    const payload = (await failure.json()) as { error: { code: string }; requestId: string };
    expect(payload.error.code).toBe("VALIDATION_ERROR");
    expect(payload.requestId).toBeString();
    expect(failure.headers.get("x-request-id")).toBe(payload.requestId);

    const raw = await fetch(`${base(app)}/raw`);
    expect(raw.status).toBe(201);
    expect(await raw.text()).toBe("raw");
  });

  test("logs successful and failed requests with their request ids", async () => {
    const app = await createMuboApp(
      {
        app: { name: "access-log-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "info", json: true },
        static: { mode: "off" },
      },
      { argv: [] },
    );
    app.get("/logged", (ctx) => ctx.json({ ok: true }));
    app.get("/logged-error", () => {
      throw new Error("boom");
    });

    const lines: string[] = [];
    const original = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((value) => String(value)).join(" "));
    };
    console.error = () => {};
    try {
      await app.start();
      const ok = await fetch(`${base(app)}/logged`, {
        headers: { "x-request-id": "req-log-ok" },
      });
      expect(ok.status).toBe(200);
      const failed = await fetch(`${base(app)}/logged-error`, {
        headers: { "x-request-id": "req-log-error" },
      });
      expect(failed.status).toBe(500);
    } finally {
      await app.stop();
      console.log = original;
      console.error = originalError;
    }

    const entries = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    expect(entries.find((entry) => entry.requestId === "req-log-ok")).toMatchObject({
      message: "http",
      method: "GET",
      path: "/logged",
      status: 200,
    });
    expect(entries.find((entry) => entry.requestId === "req-log-error")).toMatchObject({
      message: "http",
      method: "GET",
      path: "/logged-error",
      status: 500,
    });
  });

  test("tags malformed URL failures with the request id", async () => {
    const app = await startApp({
      app: { name: "malformed-url-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/users/:id", (ctx) => ctx.json({ id: ctx.params.id }));

    const response = await fetch(`${base(app)}/users/%E0%A4%A`, {
      headers: { "x-request-id": "malformed-req" },
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: { code: string };
      requestId: string;
    };
    expect(payload.error.code).toBe("BAD_REQUEST");
    expect(payload.requestId).toBe("malformed-req");
    expect(response.headers.get("x-request-id")).toBe("malformed-req");
  });

  test("returns the same body parse failure when the body is read twice", async () => {
    const app = await startApp({
      app: { name: "body-cache-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.post("/twice", async (ctx) => {
      const errors: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await ctx.body();
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return ctx.json({ errors });
    });

    const response = await fetch(`${base(app)}/twice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      errors: ["Invalid JSON body", "Invalid JSON body"],
    });
  });

  test("rejects context reads after the raw request body was consumed", async () => {
    const app = await startApp({
      app: { name: "body-consumed-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.post("/direct", async (ctx) => {
      await ctx.req.text();
      return ctx.json({ body: await ctx.body() });
    });

    const response = await fetch(`${base(app)}/direct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{\"ok\":true}",
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("BAD_REQUEST");
    expect(payload.error.message).toContain("already been consumed");
  });

  test("allows reading body then text after body is cached", async () => {
    const app = await startApp({
      app: { name: "body-then-text-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.post("/body-then-text", async (ctx) => {
      const body = await ctx.body();
      const text = await ctx.text();
      return ctx.json({ body: body ?? null, text });
    });

    const response = await fetch(`${base(app)}/body-then-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { text: string; body: unknown };
    expect(payload.text).toBe('{"hello":"world"}');
    expect(payload.body).toEqual({ hello: "world" });
  });

  test("rejects oversized bodies just over the limit", async () => {
    const app = await startApp({
      app: { name: "body-limit-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
      http: { bodyLimit: 10 },
    });
    app.post("/over", async (ctx) => ctx.json({ body: await ctx.body() }));

    const response = await fetch(`${base(app)}/over`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "01234567890" }),
    });
    expect(response.status).toBe(413);
    const payload = (await response.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("provides health, readiness, 404 and 405 responses", async () => {
    const app = await startApp({
      app: { name: "health-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.post("/only-post", (ctx) => ctx.json({ ok: true }));

    const health = await fetch(`${base(app)}/healthz`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as any).ok).toBe(true);

    const ready = await fetch(`${base(app)}/readyz`);
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as any).ok).toBe(true);

    for (const path of ["/healthz/", "//healthz", "//readyz///", "/healthz//", "//healthz//", "/readyz//"]) {
      const response = await fetch(`${base(app)}${path}`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as any).ok).toBe(true);
    }

    const missing = await fetch(`${base(app)}/missing`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("NOT_FOUND");

    const wrongMethod = await fetch(`${base(app)}/only-post`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toContain("POST");
    expect(wrongMethod.headers.get("allow")).toContain("OPTIONS");
  });

  test("OPTIONS to a GET-only route returns 405 with Allow and request id", async () => {
    const app = await startApp({
      app: { name: "options-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/users/:id", (ctx) => ctx.json({ id: ctx.params.id }));

    const response = await fetch(`${base(app)}/users/1`, { method: "OPTIONS" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("GET");
    expect(response.headers.get("allow")).toContain("HEAD");
    expect(response.headers.get("allow")).toContain("OPTIONS");
    expect(response.headers.get("x-request-id")).toBeString();
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("METHOD_NOT_ALLOWED");
  });

  test("GET with no body returns null from ctx.body", async () => {
    const app = await startApp({
      app: { name: "no-body-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/no-body", async (ctx) => ctx.json({ body: await ctx.body() }));

    const response = await fetch(`${base(app)}/no-body`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: null });
  });

  test("adds a request id to Bun.serve fallback errors", async () => {
    const app = await startApp({
      app: { name: "serve-error-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.handleRequest = () => {
      throw new Error("boom");
    };

    const response = await fetch(`${base(app)}/boom`);
    expect(response.status).toBe(500);
    const requestId = response.headers.get("x-request-id") ?? "";
    expect(requestId).not.toBe("");
    const payload = (await response.json()) as { error: { code: string }; requestId: string };
    expect(payload.error.code).toBe("INTERNAL_ERROR");
    expect(payload.requestId).toBe(requestId);
  });

  test("shares a single server across concurrent start calls", async () => {
    const app = await createMuboApp(
      {
        app: { name: "concurrent-start-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
      },
      { argv: [] },
    );
    try {
      const [first, second] = await Promise.all([app.start(), app.start()]);
      expect(first).toBe(second);
      expect(app.port).toBe(first.port);
    } finally {
      await app.stop();
    }
  });

  test("refuses to restart an application that was stopped", async () => {
    const app = await createMuboApp(
      {
        app: { name: "restart-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
      },
      { argv: [] },
    );
    await app.start();
    expect(app.started).toBe(true);
    expect(app.stopped).toBe(false);

    await app.stop();
    expect(app.started).toBe(false);
    expect(app.stopped).toBe(true);

    await expect(app.start()).rejects.toThrow(/stopped/);
    const error = await app.start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MuboError);
    expect((error as MuboError).code).toBe("APP_STOPPED");
    expect((error as MuboError).status).toBe(503);
  });

  test("does not start listening when the application is stopped during startup", async () => {
    const app = await createMuboApp(
      {
        app: { name: "stop-during-start-test", env: "test" },
        db: { path: ":memory:" },
        schema,
        log: { level: "error" },
        static: { mode: "off" },
      },
      { argv: [] },
    );
    const starting = app.start();
    await app.stop();
    await expect(starting).rejects.toThrow(/stopped/);
    expect(app.started).toBe(false);
    expect(app.stopped).toBe(true);
    expect(app.port).toBeUndefined();
  });

  test("validates request ID format and falls back to UUID", async () => {
    const app = await startApp({
      app: { name: "request-id-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/check", (ctx) => ctx.json({ requestId: ctx.requestId }));

    const validIds = [
      "simple-id",
      "with.numbers_123",
      "with-dashes-and.dots",
      "UPPERCASE",
      "a".repeat(128),
    ];
    for (const id of validIds) {
      const response = await fetch(`${base(app)}/check`, { headers: { "x-request-id": id } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { requestId: string };
      expect(body.requestId).toBe(id);
    }

    const invalidIds = [
      "",
      "with spaces",
      "with/slash",
      "with?query",
      "with#hash",
      "with@symbol",
      "a".repeat(129),
    ];
    for (const id of invalidIds) {
      const response = await fetch(`${base(app)}/check`, { headers: { "x-request-id": id } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { requestId: string };
      expect(body.requestId).not.toBe(id);
      expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    }
  });

  test("returns 400 for completely invalid URL", async () => {
    const app = await startApp({
      app: { name: "invalid-url-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/normal", (ctx) => ctx.json({ ok: true }));

    const response = await fetch(`http://127.0.0.1:${app.port}/%80%80`, {
      headers: { "x-request-id": "test-req" },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("refuses to start when migrations are pending", async () => {
    const app = await createMuboApp(
      {
        app: { name: "pending-migrations-test", env: "test" },
        db: { path: ":memory:", migrations: { mode: "check" } },
        schema,
        log: { level: "error" },
        static: { mode: "off" },
      },
      { argv: [] },
    );
    await expect(app.start()).rejects.toThrow(/migrations are pending/i);
    expect(app.started).toBe(false);
    expect(app.port).toBeUndefined();
    await app.stop();
  });

  test("does not duplicate Vary entries when applying CORS", async () => {
    const app = await startApp({
      app: { name: "cors-vary-test", env: "test" },
      db: { path: ":memory:" },
      http: { cors: { origin: ["http://allowed.test"] } },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/vary", () =>
      new Response("ok", { headers: { vary: "Accept-Encoding, origin" } }),
    );

    const response = await fetch(`${base(app)}/vary`, {
      headers: { origin: "http://allowed.test" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://allowed.test");
    expect(response.headers.get("vary")?.toLowerCase()).toBe("accept-encoding, origin");

    app.get("/vary-all", () => new Response("ok", { headers: { vary: "*" } }));
    const all = await fetch(`${base(app)}/vary-all`, {
      headers: { origin: "http://allowed.test" },
    });
    expect(all.headers.get("vary")).toBe("*");
  });

  test("varies CORS responses even when the request origin is absent or denied", async () => {
    const app = await startApp({
      app: { name: "cors-missing-origin-test", env: "test" },
      db: { path: ":memory:" },
      http: { port: 0, cors: { origin: ["http://allowed.test"] } },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/plain", () => new Response("ok"));

    const origins: Array<Record<string, string>> = [{}, { origin: "http://denied.test" }];
    for (const headers of origins) {
      const response = await fetch(`${base(app)}/plain`, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("vary")).toBe("Origin");
    }

    const wildcard = await startApp({
      app: { name: "cors-credentials-origin-test", env: "test" },
      db: { path: ":memory:" },
      http: { port: 0, cors: { origin: "*", credentials: true } },
      log: { level: "error" },
      static: { mode: "off" },
    });
    wildcard.get("/plain", () => new Response("ok"));
    const noOrigin = await fetch(`${base(wildcard)}/plain`);
    expect(noOrigin.headers.get("access-control-allow-origin")).toBeNull();
    expect(noOrigin.headers.get("vary")).toBe("Origin");
  });

  test("enforces body limits and optionally handles CORS preflight", async () => {
    const app = await startApp({
      app: { name: "limits-test", env: "test" },
      db: { path: ":memory:" },
      http: {
        bodyLimit: 16,
        cors: { origin: ["http://allowed.test"], credentials: true, maxAgeSeconds: 120 },
      },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.post("/data", async (ctx) => ctx.json({ body: await ctx.body() }));

    const tooLarge = await fetch(`${base(app)}/data`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "012345678901234567890123456789" }),
    });
    expect(tooLarge.status).toBe(413);

    const preflight = await fetch(`${base(app)}/data`, {
      method: "OPTIONS",
      headers: {
        origin: "http://allowed.test",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://allowed.test");
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");

    const actual = await fetch(`${base(app)}/data`, {
      method: "POST",
      headers: { origin: "http://allowed.test", "content-type": "application/json" },
      body: "{}",
    });
    expect(actual.headers.get("access-control-allow-origin")).toBe("http://allowed.test");

    const deniedPreflight = await fetch(`${base(app)}/data`, {
      method: "OPTIONS",
      headers: { origin: "http://denied.test" },
    });
    expect(deniedPreflight.status).toBe(405);
    expect(deniedPreflight.headers.get("access-control-allow-origin")).toBeNull();

    const deniedActual = await fetch(`${base(app)}/data`, {
      method: "POST",
      headers: { origin: "http://denied.test", "content-type": "application/json" },
      body: "{}",
    });
    expect(deniedActual.status).toBe(200);
    expect(deniedActual.headers.get("access-control-allow-origin")).toBeNull();

    const wildcard = await startApp({
      app: { name: "cors-wildcard-test", env: "test" },
      db: { path: ":memory:" },
      http: { port: 0, cors: { origin: "*", credentials: true } },
      log: { level: "error" },
      static: { mode: "off" },
    });
    wildcard.get("/cors", (ctx) => ctx.json({ ok: true }));
    const wildcardResponse = await fetch(`${base(wildcard)}/cors`, {
      headers: { origin: "http://any.test" },
    });
    expect(wildcardResponse.headers.get("access-control-allow-origin")).toBe("http://any.test");
    expect(wildcardResponse.headers.get("vary")).toContain("Origin");
  });
});

describe("middleware boundaries", () => {
  test("throws INTERNAL_ERROR when a middleware calls next() more than once", async () => {
    const app = await startApp({
      app: { name: "middleware-multi-next-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.use(async (ctx, next) => {
      await next();
      await next(); // second call throws INTERNAL_ERROR
      return new Response("ok");
    });
    app.get("/hit", (ctx) => ctx.json({ ok: true }));

    const response = await fetch(`${base(app)}/hit`);
    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("INTERNAL_ERROR");
  });

  test("supports a terminal middleware that short-circuits without calling next", async () => {
    const app = await startApp({
      app: { name: "middleware-short-circuit-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    let downstreamRan = false;
    app.use(async () => {
      return ctxJsonBlocked();
    });
    app.use(async (ctx, next) => {
      downstreamRan = true;
      return next();
    });
    app.get("/hit", (ctx) => {
      downstreamRan = true;
      return ctx.json({ ok: true });
    });

    function ctxJsonBlocked() {
      return new Response(JSON.stringify({ blocked: true }), {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const response = await fetch(`${base(app)}/hit`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ blocked: true });
    expect(downstreamRan).toBe(false);
  });

  test("runs all middleware when every handler calls next exactly once", async () => {
    const order: string[] = [];
    const app = await startApp({
      app: { name: "middleware-once-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.use(async (ctx, next) => {
      order.push("a-before");
      const response = await next();
      order.push("a-after");
      return response;
    });
    app.use(async (ctx, next) => {
      order.push("b-before");
      const response = await next();
      order.push("b-after");
      return response;
    });
    app.get("/hit", (ctx) => {
      order.push("handler");
      return ctx.json({ ok: true });
    });

    const response = await fetch(`${base(app)}/hit`);
    expect(response.status).toBe(200);
    expect(order).toEqual(["a-before", "b-before", "handler", "b-after", "a-after"]);
  });

  test("app.options() registers an OPTIONS route and responds to preflight-style requests", async () => {
    const app = await startApp({
      app: { name: "options-route-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.options("/resource", (ctx) =>
      ctx.json({ allowed: ["GET", "POST", "OPTIONS"] }),
    );
    app.get("/resource", (ctx) => ctx.json({ ok: true }));

    const optionsResponse = await fetch(`${base(app)}/resource`, { method: "OPTIONS" });
    expect(optionsResponse.status).toBe(200);
    expect(await optionsResponse.json()).toEqual({
      allowed: ["GET", "POST", "OPTIONS"],
    });

    const getResponse = await fetch(`${base(app)}/resource`);
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual({ ok: true });
  });

  test("app.patch() registers a PATCH route and handles partial updates", async () => {
    const app = await startApp({
      app: { name: "patch-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.patch("/users/:id", async (ctx) => {
      const body = await ctx.body<{ name?: string }>();
      return ctx.json({ id: ctx.params.id, updated: body?.name });
    });

    const response = await fetch(`${base(app)}/users/42`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "patched" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "42", updated: "patched" });
  });

  test("app.put() registers a PUT route and handles full updates", async () => {
    const app = await startApp({
      app: { name: "put-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.put("/users/:id", async (ctx) => {
      const body = await ctx.body<{ name: string; email: string }>();
      return ctx.json({ id: ctx.params.id, name: body?.name, email: body?.email });
    });

    const response = await fetch(`${base(app)}/users/42`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "updated", email: "new@example.com" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "42", name: "updated", email: "new@example.com" });
  });

  test("app.delete() registers a DELETE route", async () => {
    const app = await startApp({
      app: { name: "delete-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.delete("/users/:id", async (ctx) => {
      return ctx.json({ deleted: ctx.params.id });
    });

    const response = await fetch(`${base(app)}/users/42`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: "42" });
  });

  test("HEAD request falls back to explicit HEAD handler when both GET and HEAD registered", async () => {
    const app = await startApp({
      app: { name: "head-explicit-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/dual", () => new Response(JSON.stringify({ source: "get" }), { headers: { "content-type": "application/json" } }));
    app.head("/dual", () => new Response(JSON.stringify({ source: "head" }), { headers: { "content-type": "application/json" } }));

    const head = await fetch(`${base(app)}/dual`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const get = await fetch(`${base(app)}/dual`, { method: "GET" });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ source: "get" });
  });

  test("HEAD request with only GET registered falls back to GET handler", async () => {
    const app = await startApp({
      app: { name: "head-fallback-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/fallback", (ctx) => ctx.json({ source: "get-fallback" }));

    const head = await fetch(`${base(app)}/fallback`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-type")).toContain("application/json");

    const get = await fetch(`${base(app)}/fallback`, { method: "GET" });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ source: "get-fallback" });
  });

  test("HEAD request on POST-only route returns 405", async () => {
    const app = await startApp({
      app: { name: "head-post-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.post("/only-post", (ctx) => ctx.json({ source: "post" }));

    const head = await fetch(`${base(app)}/only-post`, { method: "HEAD" });
    expect(head.status).toBe(405);
    // When only POST is registered, allowed methods are OPTIONS and POST
    expect(head.headers.get("allow")).toContain("OPTIONS");
    expect(head.headers.get("allow")).toContain("POST");
    expect(head.headers.get("x-request-id")).toBeString();

    // GET on POST-only also returns 405 (HEAD falls back to GET, not vice versa)
    const get = await fetch(`${base(app)}/only-post`, { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toContain("OPTIONS");
    expect(get.headers.get("allow")).toContain("POST");
  });
});
