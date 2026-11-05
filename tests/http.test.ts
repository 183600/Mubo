import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMuboApp, type MuboApp, resolveConfig } from "../src/index.ts";
import { MuboError } from "../src/core/errors.ts";
import { defineSchema } from "../src/db/schema.ts";

const apps: MuboApp[] = [];
const tempDirs: string[] = [];
async function startApp(...args: Parameters<typeof createMuboApp>): Promise<MuboApp> {
  const app = await createMuboApp(args[0], { ...(args[1] ?? {}), argv: [] });
  await app.start();
  apps.push(app);
  return app;
}
function base(app: MuboApp): string {
  return `http://127.0.0.1:${app.port}`;
}
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mubo-http-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.stop();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
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
    const readyJson = await ready.json() as { ok: boolean; checks: { database: string; migrations: string; dataDirectory: string } };
    expect(readyJson.ok).toBe(true);
    expect(readyJson.checks).toEqual({ database: "ok", migrations: "ok", dataDirectory: "ok" });

    for (const path of ["/healthz/", "//healthz", "//readyz///", "/healthz//", "//healthz//", "/readyz//"]) {
      const response = await fetch(`${base(app)}${path}`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as any).ok).toBe(true);
    }

    const headHealth = await fetch(`${base(app)}/healthz`, { method: "HEAD" });
    expect(headHealth.status).toBe(200);
    expect(await headHealth.text()).toBe("");
    expect(headHealth.headers.get("content-type")).toBe("application/json; charset=utf-8");

    const headReady = await fetch(`${base(app)}/readyz`, { method: "HEAD" });
    expect(headReady.status).toBe(200);
    expect(await headReady.text()).toBe("");
    expect(headReady.headers.get("content-type")).toBe("application/json; charset=utf-8");

    const missing = await fetch(`${base(app)}/missing`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("NOT_FOUND");

    const wrongMethod = await fetch(`${base(app)}/only-post`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toContain("POST");
    expect(wrongMethod.headers.get("allow")).toContain("OPTIONS");
  });

  test("readiness stays consistent under concurrent checks and leaves no probe files", async () => {
    const dir = tempDir();
    const app = await startApp({
      app: { name: "readiness-concurrent-test", env: "test" },
      dataDir: dir,
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });

    const responses = await Promise.all(
      Array.from({ length: 25 }, () => fetch(`${base(app)}/readyz`)),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        ok: boolean;
        checks: { database: string; migrations: string; dataDirectory: string };
      };
      expect(payload.ok).toBe(true);
      expect(payload.checks.dataDirectory).toBe("ok");
    }

    const leftovers = readdirSync(dir).filter((entry) => entry.startsWith(".mubo-readiness"));
    expect(leftovers).toEqual([]);
  });

  test("readiness reports pending migrations as not ready", async () => {
    const app = await startApp({
      app: { name: "readiness-pending-test", env: "test" },
      db: { path: ":memory:" },
      schema,
      log: { level: "error" },
      static: { mode: "off" },
    });

    const ready = await fetch(`${base(app)}/readyz`);
    expect(ready.status).toBe(200);

    app.db.exec("DROP TABLE users");

    const pending = await fetch(`${base(app)}/readyz`);
    expect(pending.status).toBe(503);
    const payload = (await pending.json()) as {
      ok: boolean;
      checks: { database: string; migrations: string; dataDirectory: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.checks.database).toBe("ok");
    expect(payload.checks.migrations).toContain("create table users");
    expect(payload.checks.dataDirectory).toBe("ok");
  });

  test("readiness reports a schema that cannot be planned", async () => {
    const app = await startApp({
      app: { name: "readiness-plan-failure-test", env: "test" },
      db: { path: ":memory:" },
      schema,
      log: { level: "error" },
      static: { mode: "off" },
    });

    app.db.exec("DROP TABLE users");
    app.db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");

    const response = await fetch(`${base(app)}/readyz`);
    expect(response.status).toBe(503);
    const payload = (await response.json()) as {
      ok: boolean;
      checks: { database: string; migrations: string; dataDirectory: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.checks.database).toBe("ok");
    expect(payload.checks.migrations).toBe("migration check failed");
  });

  test.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "readiness reports a data directory that cannot be written",
    async () => {
      const dir = tempDir();
      const app = await startApp({
        app: { name: "readiness-data-dir-test", env: "test" },
        dataDir: dir,
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
      });

      chmodSync(dir, 0o500);
      try {
        const response = await fetch(`${base(app)}/readyz`);
        expect(response.status).toBe(503);
        const payload = (await response.json()) as {
          ok: boolean;
          checks: { database: string; migrations: string; dataDirectory: string };
        };
        expect(payload.ok).toBe(false);
        expect(payload.checks.database).toBe("ok");
        expect(payload.checks.dataDirectory).toBe("not writable");
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  test("readiness reports a database that is no longer available", async () => {
    const app = await startApp({
      app: { name: "readiness-database-failure-test", env: "test" },
      db: { path: ":memory:" },
      schema,
      log: { level: "error" },
      static: { mode: "off" },
    });

    app.db.close();

    const response = await fetch(`${base(app)}/readyz`);
    expect(response.status).toBe(503);
    const payload = (await response.json()) as {
      ok: boolean;
      checks: { database: string; migrations: string; dataDirectory: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.checks.database).toBe("failed");
    expect(payload.checks.migrations).toBe("migration check failed");
  });

  test("handlers that return no value respond with 204", async () => {
    const app = await startApp({
      app: { name: "empty-response-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/empty", () => undefined);
    app.get("/null", () => null);

    const empty = await fetch(`${base(app)}/empty`);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");

    const nul = await fetch(`${base(app)}/null`);
    expect(nul.status).toBe(204);
  });

  test("handlers that return plain values respond with JSON", async () => {
    const app = await startApp({
      app: { name: "plain-response-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/object", () => ({ ok: true, items: [1, 2] }));
    app.get("/number", () => 42);
    app.get("/array", () => [1, "two"]);

    const object = await fetch(`${base(app)}/object`);
    expect(object.status).toBe(200);
    expect(object.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await object.json()).toEqual({ ok: true, items: [1, 2] });

    const number = await fetch(`${base(app)}/number`);
    expect(number.status).toBe(200);
    expect(await number.json()).toBe(42);

    const array = await fetch(`${base(app)}/array`);
    expect(array.status).toBe(200);
    expect(await array.json()).toEqual([1, "two"]);
  });

  test("rejects requests with an invalid URL", async () => {
    const app = await startApp({
      app: { name: "invalid-url-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });

    const malformed = { url: "not-a-url", method: "GET", headers: new Headers() } as unknown as Request;
    const response = await app.handleRequest(malformed, app.serverInstance!);
    expect(response?.status).toBe(400);
    expect(response?.headers.get("x-request-id")).toBeString();
    const payload = (await response?.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("BAD_REQUEST");
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

  test("does not duplicate built-in middleware when a failed start is retried", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
    let keyCalls = 0;
    const app = await createMuboApp(
      {
        app: { name: "failed-start-retry-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        http: {
          port: blocker.port,
          rateLimit: {
            maxRequests: 2,
            windowMs: 60_000,
            key: () => {
              keyCalls++;
              return "client";
            },
          },
        },
      },
      { argv: [] },
    );
    apps.push(app);
    await expect(app.start()).rejects.toThrow(/in use|listen|EADDRINUSE/i);
    await blocker.stop(true);

    await app.start();
    app.get("/limited", (ctx) => ctx.json({ ok: true }));

    const first = await fetch(`${base(app)}/limited`);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-remaining")).toBe("1");
    expect(keyCalls).toBe(1);
    const second = await fetch(`${base(app)}/limited`);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-ratelimit-remaining")).toBe("0");
    const limited = await fetch(`${base(app)}/limited`);
    expect(limited.status).toBe(429);
    expect(keyCalls).toBe(3);
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

  test("stopping an application that was never started marks it stopped", async () => {
    const app = await createMuboApp(
      {
        app: { name: "stop-before-start-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
      },
      { argv: [] },
    );
    expect(app.started).toBe(false);
    expect(app.stopped).toBe(false);

    await app.stop();
    expect(app.started).toBe(false);
    expect(app.stopped).toBe(true);

    await expect(app.start()).rejects.toThrow(/stopped/);
    const caught = await app.start().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(MuboError);
    expect((caught as MuboError).code).toBe("APP_STOPPED");
  });

  test("stopping an already stopped application is idempotent", async () => {
    const app = await createMuboApp(
      {
        app: { name: "double-stop-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
      },
      { argv: [] },
    );
    await app.start();
    await app.stop();
    expect(app.stopped).toBe(true);

    // A second stop must not throw and leaves the app stopped.
    await app.stop();
    expect(app.stopped).toBe(true);
    expect(app.started).toBe(false);
    await expect(app.start()).rejects.toThrow(/stopped/);
  });

  test("stops running applications when a shutdown signal is received", async () => {
    const app = await startApp({
      app: { name: "signal-shutdown-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });

    let stopResolved = false;
    const originalStop = app.stop.bind(app);
    app.stop = async () => {
      await originalStop();
      stopResolved = true;
    };

    const keepProcessAlive = () => {};
    process.on("SIGINT", keepProcessAlive);
    try {
      process.emit("SIGINT");
      for (let attempt = 0; attempt < 100 && !stopResolved; attempt++) await Bun.sleep(10);
      await Bun.sleep(0);
    } finally {
      process.off("SIGINT", keepProcessAlive);
    }

    expect(stopResolved).toBe(true);
    expect(app.started).toBe(false);
    expect(app.stopped).toBe(true);
    expect(app.port).toBeUndefined();
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
      app: { name: "cors-wildcard-origin-test", env: "test" },
      db: { path: ":memory:" },
      http: { port: 0, cors: { origin: "*" } },
      log: { level: "error" },
      static: { mode: "off" },
    });
    wildcard.get("/plain", () => new Response("ok"));
    const noOrigin = await fetch(`${base(wildcard)}/plain`);
    expect(noOrigin.headers.get("access-control-allow-origin")).toBeNull();
    expect(noOrigin.headers.get("vary")).toBeNull();

    const anyOrigin = await fetch(`${base(wildcard)}/plain`, {
      headers: { origin: "http://any.test" },
    });
    expect(anyOrigin.headers.get("access-control-allow-origin")).toBe("*");
    expect(anyOrigin.headers.get("vary")).toBeNull();
  });

  test("rejects wildcard CORS origins combined with credentials", async () => {
    await expect(
      startApp({
        app: { name: "cors-credentials-wildcard-test", env: "test" },
        db: { path: ":memory:" },
        http: { port: 0, cors: { origin: "*", credentials: true } },
        log: { level: "error" },
        static: { mode: "off" },
      }),
    ).rejects.toThrow(/credentials cannot be combined/);
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
      http: { port: 0, cors: { origin: "*" } },
      log: { level: "error" },
      static: { mode: "off" },
    });
    wildcard.get("/cors", (ctx) => ctx.json({ ok: true }));
    const wildcardResponse = await fetch(`${base(wildcard)}/cors`, {
      headers: { origin: "http://any.test" },
    });
    expect(wildcardResponse.headers.get("access-control-allow-origin")).toBe("*");
    expect(wildcardResponse.headers.get("vary")).toBeNull();
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

  test("reports database failures with the DB_ERROR code", async () => {
    const app = await startApp({
      app: { name: "db-error-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/broken", () => {
      app.db.query("SELECT FROM WHERE").all();
      return new Response("unreachable");
    });

    const response = await fetch(`${base(app)}/broken`);
    expect(response.status).toBe(500);
    const payload = (await response.json()) as {
      error: { code: string; message: string; details?: unknown };
      requestId: string;
    };
    expect(payload.error.code).toBe("DB_ERROR");
    expect(payload.requestId).toBeTruthy();
  });

  test("rejects invalid route handlers and middleware at registration time", async () => {
    const app = await startApp({
      app: { name: "registration-validation-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });

    expect(() => app.get("/broken", undefined as never)).toThrow(MuboError);
    expect(() => app.get("/broken", undefined as never)).toThrow(
      /Route handler for GET \/broken must be a function/,
    );
    expect(() => app.post("/broken", "nope" as never)).toThrow(
      /Route handler for POST \/broken must be a function/,
    );
    expect(() => app.use(undefined as never)).toThrow(/Middleware must be a function/);
    expect(() => app.use({} as never)).toThrow(/Middleware must be a function/);
    expect(app.router.routes).toHaveLength(0);

    app.get("/ok", (ctx) => ctx.json({ ok: true }));
    const response = await fetch(`${base(app)}/ok`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("rejects route paths that are not usable strings", async () => {
    const app = await startApp({
      app: { name: "route-path-validation-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });

    for (const path of [123, null, undefined, "", "   "]) {
      expect(() => app.get(path as never, () => new Response(""))).toThrow(MuboError);
      expect(() => app.get(path as never, () => new Response(""))).toThrow(
        /Route path must be a non-empty string/,
      );
      expect(() => app.ws(path as never, {})).toThrow(/Route path must be a non-empty string/);
    }
    expect(app.router.routes).toHaveLength(0);
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

  test("CORS keeps a registered OPTIONS route reachable and adds the preflight headers", async () => {
    const app = await startApp({
      app: { name: "options-cors-test", env: "test" },
      db: { path: ":memory:" },
      http: { cors: { origin: ["http://allowed.test"], credentials: true, maxAgeSeconds: 120 } },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/resource", (ctx) => ctx.json({ ok: true }));
    app.options("/resource", (ctx) => ctx.json({ custom: true }));

    const response = await fetch(`${base(app)}/resource`, {
      method: "OPTIONS",
      headers: { origin: "http://allowed.test" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ custom: true });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://allowed.test");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-max-age")).toBe("120");
    expect(response.headers.get("vary")).toBe("Origin");

    // Paths without an OPTIONS route keep the automatic preflight response.
    const fallback = await fetch(`${base(app)}/other`, {
      method: "OPTIONS",
      headers: { origin: "http://allowed.test" },
    });
    expect(fallback.status).toBe(204);
    expect(fallback.headers.get("access-control-allow-origin")).toBe("http://allowed.test");
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

describe("request timeout", () => {
  test("times out slow requests and returns 504", async () => {
    const app = await startApp({
      app: { name: "timeout-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
      http: { requestTimeoutMs: 50 },
    });
    app.get("/slow", async (ctx) => {
      await Bun.sleep(100);
      return ctx.json({ ok: true });
    });
    app.get("/fast", (ctx) => ctx.json({ ok: true }));

    const slowResponse = await fetch(`${base(app)}/slow`);
    expect(slowResponse.status).toBe(504);
    const slowPayload = (await slowResponse.json()) as { error: { code: string } };
    expect(slowPayload.error.code).toBe("REQUEST_TIMEOUT");

    const fastResponse = await fetch(`${base(app)}/fast`);
    expect(fastResponse.status).toBe(200);
    expect(await fastResponse.json()).toEqual({ ok: true });
  });

  test("does not timeout when requestTimeoutMs is 0 (default)", async () => {
    const app = await startApp({
      app: { name: "no-timeout-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/slow", async (ctx) => {
      await Bun.sleep(100);
      return ctx.json({ ok: true });
    });

    const response = await fetch(`${base(app)}/slow`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("rejects invalid requestTimeoutMs values", () => {
    expect(() =>
      resolveConfig({ http: { requestTimeoutMs: -1 } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid request timeout/);
    expect(() =>
      resolveConfig({ http: { requestTimeoutMs: 1.5 } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid request timeout/);
  });
});

describe("rate limiting", () => {
  test("limits requests per window and returns 429 with retry headers", async () => {
    const app = await startApp({
      app: { name: "ratelimit-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
      http: {
        rateLimit: {
          maxRequests: 3,
          windowMs: 1000,
          key: (req) => req.headers.get("x-forwarded-for") ?? "default",
        },
      },
    });
    app.get("/limited", (ctx) => ctx.json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${base(app)}/limited`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-ratelimit-limit")).toBe("3");
      expect(response.headers.get("x-ratelimit-remaining")).toBe(String(2 - i));
    }

    const limited = await fetch(`${base(app)}/limited`);
    expect(limited.status).toBe(429);
    const payload = (await limited.json()) as { error: { code: string; details: { retryAfterSeconds: number } } };
    expect(payload.error.code).toBe("RATE_LIMITED");
    expect(payload.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.headers.get("x-ratelimit-limit")).toBe("3");
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  test("uses custom key function for rate limiting", async () => {
    const app = await startApp({
      app: { name: "ratelimit-custom-key-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
      http: {
        rateLimit: {
          maxRequests: 2,
          windowMs: 1000,
          key: (req) => new URL(req.url).searchParams.get("user") ?? "anonymous",
        },
      },
    });
    app.get("/limited", (ctx) => ctx.json({ ok: true }));

    const r1 = await fetch(`${base(app)}/limited?user=alice`);
    expect(r1.status).toBe(200);
    const r2 = await fetch(`${base(app)}/limited?user=alice`);
    expect(r2.status).toBe(200);
    const r3 = await fetch(`${base(app)}/limited?user=alice`);
    expect(r3.status).toBe(429);

    const r4 = await fetch(`${base(app)}/limited?user=bob`);
    expect(r4.status).toBe(200);
  });

  test("uses the resolved client IP as the default rate limit bucket", async () => {
    const app = await startApp({
      app: { name: "ratelimit-default-key-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
      http: {
        rateLimit: {
          maxRequests: 2,
          windowMs: 1000,
        },
      },
    });
    app.get("/limited", (ctx) => ctx.json({ ok: true, ip: ctx.ip }));

    const first = await fetch(`${base(app)}/limited`);
    expect(first.status).toBe(200);
    const payload = (await first.json()) as { ip: string };
    expect(payload.ip).toBe("127.0.0.1");

    expect((await fetch(`${base(app)}/limited`)).status).toBe(200);
    const limited = await fetch(`${base(app)}/limited`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  test("does not apply rate limiting when disabled", async () => {
    const app = await startApp({
      app: { name: "no-ratelimit-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
    });
    app.get("/unlimited", (ctx) => ctx.json({ ok: true }));

    for (let i = 0; i < 10; i++) {
      const response = await fetch(`${base(app)}/unlimited`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-ratelimit-limit")).toBeNull();
    }
  });

  test("rejects invalid rateLimit config", () => {
    expect(() => resolveConfig({ http: { rateLimit: { maxRequests: 10, windowMs: 1000, key: "not-a-function" as never } } }, { env: {}, argv: [] })).toThrow(/Invalid rate limit key/);
    expect(() =>
      resolveConfig({ http: { rateLimit: { maxRequests: 0, windowMs: 1000, key: () => "x" } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid rate limit maxRequests/);
    expect(() =>
      resolveConfig({ http: { rateLimit: { maxRequests: 10, windowMs: -1, key: () => "x" } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid rate limit windowMs/);
    expect(() =>
      resolveConfig({ http: { rateLimit: { maxRequests: 10, windowMs: 1000, key: "not-a-function" as never } } }, { env: {}, argv: [] }),
    ).toThrow(/Invalid rate limit key/);
  });

  test("releases the rate limit cleanup timer when the application stops", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const scheduled = new Set<unknown>();
    const cleared = new Set<unknown>();
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = originalSetInterval(...args);
      scheduled.add(handle);
      return handle;
    }) as typeof globalThis.setInterval;
    globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
      cleared.add(handle);
      return originalClearInterval(handle);
    }) as typeof globalThis.clearInterval;

    try {
      const app = await createMuboApp(
        {
          app: { name: "ratelimit-timer-test", env: "test" },
          db: { path: ":memory:" },
          log: { level: "error" },
          static: { mode: "off" },
          ws: { enabled: false },
          http: { rateLimit: { maxRequests: 5, windowMs: 60_000 } },
        },
        { argv: [] },
      );
      await app.start();
      expect(scheduled.size).toBe(1);
      await app.stop();
      expect(cleared.size).toBe(1);
      for (const handle of scheduled) expect(cleared.has(handle)).toBe(true);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });
});

describe("HTTP trustProxy", () => {
  test("honors x-forwarded-for when trustProxy is enabled", async () => {
    const app = await startApp({
      app: { name: "trustproxy-forwarded-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
      http: { trustProxy: true },
    });
    app.get("/ip", (ctx) => ctx.json({ ip: ctx.ip }));
    await app.start();

    const response = await fetch(`${base(app)}/ip`, {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    });
    expect(response.status).toBe(200);
    const body1 = (await response.json()) as { ip: string };
    expect(body1.ip).toBe("203.0.113.9");
  });

  test("honors x-real-ip when trustProxy is enabled and x-forwarded-for absent", async () => {
    const app = await startApp({
      app: { name: "trustproxy-realip-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
      http: { trustProxy: true },
    });
    app.get("/ip", (ctx) => ctx.json({ ip: ctx.ip }));
    await app.start();

    const response = await fetch(`${base(app)}/ip`, {
      headers: { "x-real-ip": "198.51.100.7" },
    });
    expect(response.status).toBe(200);
    const body2 = (await response.json()) as { ip: string };
    expect(body2.ip).toBe("198.51.100.7");
  });

  test("prefers x-forwarded-for over x-real-ip when both present", async () => {
    const app = await startApp({
      app: { name: "trustproxy-both-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
      http: { trustProxy: true },
    });
    app.get("/ip", (ctx) => ctx.json({ ip: ctx.ip }));
    await app.start();

    const response = await fetch(`${base(app)}/ip`, {
      headers: {
        "x-forwarded-for": "203.0.113.9",
        "x-real-ip": "198.51.100.7",
      },
    });
    expect(response.status).toBe(200);
    const body3 = (await response.json()) as { ip: string };
    expect(body3.ip).toBe("203.0.113.9");
  });

  test("ignores x-forwarded-for when trustProxy is disabled", async () => {
    const app = await startApp({
      app: { name: "trustproxy-disabled-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
      http: { trustProxy: false },
    });
    app.get("/ip", (ctx) => ctx.json({ ip: ctx.ip }));
    await app.start();

    const response = await fetch(`${base(app)}/ip`, {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(response.status).toBe(200);
    const body4 = (await response.json()) as { ip: string };
    expect(body4.ip).toBe("127.0.0.1");
  });

  test("handles IPv6 addresses in x-forwarded-for", async () => {
    const app = await startApp({
      app: { name: "trustproxy-ipv6-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
      http: { trustProxy: true },
    });
    app.get("/ip", (ctx) => ctx.json({ ip: ctx.ip }));
    await app.start();

    const response = await fetch(`${base(app)}/ip`, {
      headers: { "x-forwarded-for": "2001:db8::1, 10.0.0.1" },
    });
    expect(response.status).toBe(200);
    const body5 = (await response.json()) as { ip: string };
    expect(body5.ip).toBe("2001:db8::1");
  });

  test("limits forwarded IP length to prevent abuse", async () => {
    const app = await startApp({
      app: { name: "trustproxy-length-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
      http: { trustProxy: true },
    });
    app.get("/ip", (ctx) => ctx.json({ ip: ctx.ip }));
    await app.start();

    const longIp = "192.168.1." + "1".repeat(200); // Over 100 chars
    const response = await fetch(`${base(app)}/ip`, {
      headers: { "x-forwarded-for": longIp },
    });
    expect(response.status).toBe(200);
    // Should fall back to direct connection IP when forwarded IP is too long
    const body6 = (await response.json()) as { ip: string };
    expect(body6.ip).toBe("127.0.0.1");
  });

  test("uses x-forwarded-for for rate limiting when trustProxy enabled", async () => {
    const app = await startApp({
      app: { name: "trustproxy-ratelimit-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "off" },
      http: {
        trustProxy: true,
        rateLimit: { maxRequests: 2, windowMs: 60_000 },
      },
    });
    app.get("/limited", (ctx) => ctx.json({ ip: ctx.ip }));
    await app.start();

    // First request from forwarded IP
    const r1 = await fetch(`${base(app)}/limited`, {
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    expect(r1.status).toBe(200);

    // Second request from same forwarded IP
    const r2 = await fetch(`${base(app)}/limited`, {
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    expect(r2.status).toBe(200);

    // Third request should be rate limited
    const r3 = await fetch(`${base(app)}/limited`, {
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    expect(r3.status).toBe(429);
  });
});
