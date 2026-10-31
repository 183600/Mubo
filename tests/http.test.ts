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

    const missing = await fetch(`${base(app)}/missing`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("NOT_FOUND");

    const wrongMethod = await fetch(`${base(app)}/only-post`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toContain("POST");
    expect(wrongMethod.headers.get("allow")).toContain("OPTIONS");
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
