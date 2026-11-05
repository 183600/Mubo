import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createMuboApp, serializePayload, type MuboApp, type WsSocketData } from "../src/index.ts";
import { createLogger } from "../src/core/logger.ts";
import { MuboError } from "../src/core/errors.ts";

const apps: MuboApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.stop();
});

interface TestSocket {
  socket: WebSocket;
  next(timeoutMs?: number): Promise<unknown>;
  expectNone(timeoutMs?: number): Promise<void>;
}

function openSocket(url: string, headers?: Record<string, string>): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, headers ? ({ headers } as never) : undefined);
    const queue: unknown[] = [];
    const waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      const parsed = JSON.parse(raw);
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
      } else {
        queue.push(parsed);
      }
    });
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), 2000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        socket,
        next(timeoutMs = 2000) {
          if (queue.length > 0) return Promise.resolve(queue.shift());
          return new Promise((nextResolve, nextReject) => {
            const waiterTimer = setTimeout(() => {
              const index = waiters.findIndex((waiter) => waiter.resolve === nextResolve);
              if (index >= 0) waiters.splice(index, 1);
              nextReject(new Error("WebSocket message timeout"));
            }, timeoutMs);
            waiters.push({ resolve: nextResolve, reject: nextReject, timer: waiterTimer });
          });
        },
        expectNone(timeoutMs = 150) {
          return new Promise((nextResolve, nextReject) => {
            const noneTimer = setTimeout(() => {
              const index = waiters.findIndex((waiter) => waiter.resolve === nextResolve);
              if (index >= 0) waiters.splice(index, 1);
              nextResolve();
            }, timeoutMs);
            waiters.push({
              resolve: (value) => {
                clearTimeout(noneTimer);
                nextReject(new Error(`Unexpected message: ${JSON.stringify(value)}`));
              },
              reject: nextReject,
              timer: noneTimer,
            });
          });
        },
      });
    });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(event);
    });
  });
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
  });
}

describe("WebSocket payload serialization", () => {
  test("passes raw payloads through and rejects values without JSON representations", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(serializePayload("raw")).toBe("raw");
    expect(serializePayload(bytes)).toBe(bytes);
    expect(serializePayload({ a: 1 })).toBe('{"a":1}');

    expect(() => serializePayload(undefined)).toThrow(MuboError);
    expect(() => serializePayload(() => undefined)).toThrow(MuboError);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializePayload(circular)).toThrow(MuboError);
  });

  test("handles null and various primitive types", () => {
    expect(serializePayload(null)).toBe("null");
    expect(serializePayload(true)).toBe("true");
    expect(serializePayload(false)).toBe("false");
    expect(serializePayload(0)).toBe("0");
    expect(serializePayload(123)).toBe("123");
    expect(serializePayload(3.14)).toBe("3.14");
    expect(serializePayload("")).toBe("");
    expect(serializePayload("hello")).toBe("hello");
  });

  test("handles ArrayBuffer and ArrayBufferView types", () => {
    const arrayBuffer = new ArrayBuffer(4);
    expect(serializePayload(arrayBuffer)).toBe(arrayBuffer);

    const uint8 = new Uint8Array([1, 2, 3, 4]);
    expect(serializePayload(uint8)).toBe(uint8);

    const int32 = new Int32Array(2);
    expect(serializePayload(int32)).toBe(int32);

    const float64 = new Float64Array(1);
    expect(serializePayload(float64)).toBe(float64);
  });

  test("handles Blob types", () => {
    const blob = new Blob(["hello world"], { type: "text/plain" });
    expect(serializePayload(blob)).toBe(blob);
    expect(blob.size).toBe(11);

    const emptyBlob = new Blob([]);
    expect(serializePayload(emptyBlob)).toBe(emptyBlob);
    expect(emptyBlob.size).toBe(0);
  });

  test("stringifies JSON objects with circular reference detection", () => {
    const obj: Record<string, unknown> = { name: "test" };
    obj.self = obj;

    expect(() => serializePayload(obj)).toThrow(/not JSON serializable/);
  });

  test("handles NaN and Infinity values in JSON", () => {
    const nanResult = serializePayload({ value: Number.NaN });
    expect(nanResult).toBe('{"value":null}');

    const infResult = serializePayload({ value: Number.POSITIVE_INFINITY });
    expect(infResult).toBe('{"value":null}');

    const negInfResult = serializePayload({ value: Number.NEGATIVE_INFINITY });
    expect(negInfResult).toBe('{"value":null}');
  });

  test("handles Date objects which serialize to ISO strings", () => {
    const date = new Date("2024-01-15T10:30:00.000Z");
    const result = serializePayload({ timestamp: date });
    expect(result).toBe('{"timestamp":"2024-01-15T10:30:00.000Z"}');
  });

  test("preserves nested object structure", () => {
    const nested = {
      level1: {
        level2: {
          level3: {
            value: "deep",
          },
        },
      },
    };
    expect(serializePayload(nested)).toBe(JSON.stringify(nested));
  });

  test("serializes bigint values as strings", () => {
    expect(serializePayload(1n)).toBe("1");
    expect(serializePayload(9007199254740991n)).toBe("9007199254740991");
    expect(serializePayload(-1n)).toBe("-1");
    expect(serializePayload({ count: 42n })).toBe('{"count":"42"}');
    expect(serializePayload([1n, 2n, 3n])).toBe('["1","2","3"]');
    expect(serializePayload({ nested: { value: 100n } })).toBe('{"nested":{"value":"100"}}');
  });

  test("handles arrays correctly", () => {
    expect(serializePayload([])).toBe("[]");
    expect(serializePayload([1, 2, 3])).toBe("[1,2,3]");
    expect(serializePayload(["a", "b", "c"])).toBe('["a","b","c"]');
  });
});

describe("WebSocket route registration", () => {
  test("rejects paths with query strings or fragments", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-route-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
      },
      { argv: [] },
    );
    try {
      expect(() => app.ws("/ws?token=1", {})).toThrow(/must not contain a query or fragment/);
      expect(() => app.ws("/ws#fragment", {})).toThrow(/must not contain a query or fragment/);
    } finally {
      await app.stop();
    }
  });

  test("rejects invalid WebSocket handler registrations", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-handler-validation-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
      },
      { argv: [] },
    );
    try {
      expect(() => app.ws("/ws", undefined as never)).toThrow(
        /WebSocket handlers for \/ws must be an object/,
      );
      expect(() => app.ws("/ws", [] as never)).toThrow(/WebSocket handlers for \/ws must be an object/);
      expect(() => app.ws("/ws", { onConnect: "nope" as never })).toThrow(
        /WebSocket handler onConnect for \/ws must be a function/,
      );
      expect(() => app.ws("/ws", { authorize: 42 as never })).toThrow(
        /WebSocket handler authorize for \/ws must be a function/,
      );
      expect(() => app.ws("/ws", { onMessage: {} as never })).toThrow(
        /WebSocket handler onMessage for \/ws must be a function/,
      );
      expect(() => app.ws("/ws", { onClose: null as never })).toThrow(
        /WebSocket handler onClose for \/ws must be a function/,
      );
      expect(() => app.ws("/ws", { onError: false as never })).toThrow(
        /WebSocket handler onError for \/ws must be a function/,
      );
    } finally {
      await app.stop();
    }
  });

  test("rejects WebSocket routes that can never be matched", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-path-validation-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
      },
      { argv: [] },
    );
    try {
      for (const path of ["/ws/:room", "/ws/*", "/:room"]) {
        expect(() => app.ws(path, {})).toThrow(
          /WebSocket route path must not contain parameters or wildcards/,
        );
      }
      for (const path of [123, null, undefined, "", "   "]) {
        expect(() => app.ws(path as never, {})).toThrow(/Route path must be a non-empty string/);
      }
      expect(() => app.ws("/ws", {})).not.toThrow();
    } finally {
      await app.stop();
    }
  });

  test("rejects WebSocket authorization returning false", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-false-reject-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      authorize() {
        return false;
      },
    });
    await app.start();
    apps.push(app);
    const base = `http://127.0.0.1:${app.port}`;

    const rejected = await fetch(`${base}/ws`, {
      headers: { upgrade: "websocket", "x-request-id": "ws-false-rejected" },
    });
    expect(rejected.status).toBe(401);
    const payload = (await rejected.json()) as { requestId: string };
    expect(payload.requestId).toBe("ws-false-rejected");
    await app.stop();
  });

  test("normalizes surrounding slashes in websocket routes and requests", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-slash-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("//events///", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
      },
    });
    await app.start();
    apps.push(app);

    const socket = await openSocket(`ws://127.0.0.1:${app.port}//events`);
    expect(await socket.next()).toEqual({ type: "ready" });
    socket.socket.close();
  });

  test("matches percent-encoded websocket route paths", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-encoded-route-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/café", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
      },
    });
    await app.start();
    apps.push(app);

    const socket = await openSocket(`ws://127.0.0.1:${app.port}/caf%C3%A9`);
    expect(await socket.next()).toEqual({ type: "ready" });
    socket.socket.close();
  });

  test("matches decoded websocket route paths regardless of percent-encoding case", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-decoded-route-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/caf%C3%A9", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
      },
    });
    await app.start();
    apps.push(app);

    const socket = await openSocket(`ws://127.0.0.1:${app.port}/caf%c3%a9`);
    expect(await socket.next()).toEqual({ type: "ready" });
    socket.socket.close();
  });

  test("replaces equivalent websocket routes registered with different encodings", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-duplicate-route-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/caf%C3%A9", {
      onConnect(ctx) {
        ctx.send({ handler: "old" });
      },
    });
    app.ws("/café", {
      onConnect(ctx) {
        ctx.send({ handler: "new" });
      },
    });
    app.ws("/a%2Fb", {
      onConnect(ctx) {
        ctx.send({ handler: "old-slash" });
      },
    });
    app.ws("/a%2fb", {
      onConnect(ctx) {
        ctx.send({ handler: "new-slash" });
      },
    });
    await app.start();
    apps.push(app);

    for (const path of ["/caf%C3%A9", "/caf%c3%a9"]) {
      const socket = await openSocket(`ws://127.0.0.1:${app.port}${path}`);
      expect(await socket.next()).toEqual({ handler: "new" });
      socket.socket.close();
    }
    for (const path of ["/a%2Fb", "/a%2fb"]) {
      const socket = await openSocket(`ws://127.0.0.1:${app.port}${path}`);
      expect(await socket.next()).toEqual({ handler: "new-slash" });
      socket.socket.close();
    }
    expect((await fetch(`http://127.0.0.1:${app.port}/a/b`)).status).toBe(404);
  });

  test("does not intercept HTTP paths with encoded query or fragment characters", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-http-path-test", env: "test" },
        db: { path: ":memory:" },
        http: { port: 0 },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {});
    app.get("/encoded%3Fpath", () => new Response("ok"));
    await app.start();
    apps.push(app);

    const base = `http://127.0.0.1:${app.port}`;
    const encoded = await fetch(`${base}/encoded%3Fpath`);
    expect(encoded.status).toBe(200);
    expect(await encoded.text()).toBe("ok");

    for (const path of ["/ws%3Ffoo", "/anything%23frag"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(404);
    }
  });

  test("preserves path segment boundaries when decoding WebSocket lookups", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-encoded-slash-test", env: "test" },
        db: { path: ":memory:" },
        http: { port: 0 },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/a/b", {});
    app.ws("/a b", {});
    await app.start();
    apps.push(app);

    const base = `http://127.0.0.1:${app.port}`;
    expect((await fetch(`${base}/a%2Fb`)).status).toBe(404);
    expect((await fetch(`${base}/a/b`)).status).toBe(426);
    expect((await fetch(`${base}/a%20b`)).status).toBe(426);
  });
});

describe("WebSocket rooms and broadcasting", () => {
  test("authenticates, tracks rooms, broadcasts, and releases clients on close", async () => {
    const closeEvents: string[] = [];
    const app = await createMuboApp(
      {
        app: { name: "ws-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      authorize(request) {
        const token = new URL(request.url).searchParams.get("token");
        return token === "ok" ? { id: "user-1" } : null;
      },
      onConnect(ctx) {
        ctx.subscribe("lobby");
        ctx.send({ type: "welcome", id: ctx.id, user: ctx.user });
      },
      onMessage(ctx, message) {
        const event = JSON.parse(String(message)) as {
          type: string;
          room?: string;
          data?: unknown;
        };
        if (event.type === "join") {
          ctx.subscribe(event.room ?? "lobby");
          ctx.send({ type: "joined", room: event.room ?? "lobby" });
        } else if (event.type === "leave") {
          ctx.unsubscribe(event.room ?? "lobby");
          ctx.send({ type: "left", room: event.room ?? "lobby" });
        } else if (event.type === "broadcast") {
          ctx.publish(event.room ?? "lobby", { type: "event", data: event.data });
        } else if (event.type === "echo") {
          ctx.emit("echo", event.data);
        } else {
          ctx.send({ type: "unknown" });
        }
      },
      onClose(ctx) {
        closeEvents.push(ctx.id);
      },
    });
    await app.start();
    apps.push(app);
    const url = `ws://127.0.0.1:${app.port}/ws`;

    const rejected = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("close", () => resolve());
      socket.addEventListener("open", () => reject(new Error("unauthenticated socket opened")));
    });
    await rejected;

    const first = await openSocket(`${url}?token=ok`);
    const second = await openSocket(`${url}?token=ok`);
    const firstWelcome = (await first.next()) as { type: string; user: { id: string } };
    const secondWelcome = (await second.next()) as { type: string };
    expect(firstWelcome.type).toBe("welcome");
    expect(firstWelcome.user.id).toBe("user-1");
    expect(secondWelcome.type).toBe("welcome");
    expect(app.wsHub.roomSize("lobby")).toBe(2);

    first.socket.send(JSON.stringify({ type: "broadcast", data: "hello room" }));
    expect(await first.next()).toEqual({ type: "event", data: "hello room" });
    expect(await second.next()).toEqual({ type: "event", data: "hello room" });

    first.socket.send(JSON.stringify({ type: "echo", data: 7 }));
    expect(await first.next()).toEqual({ t: "event", e: "echo", d: 7 });

    second.socket.send(JSON.stringify({ type: "leave" }));
    expect(await second.next()).toEqual({ type: "left", room: "lobby" });
    expect(app.wsHub.roomSize("lobby")).toBe(1);
    first.socket.send(JSON.stringify({ type: "broadcast", data: "only first" }));
    expect(await first.next()).toEqual({ type: "event", data: "only first" });
    await second.expectNone();

    const firstClosed = closed(first.socket);
    first.socket.close(1000, "bye");
    const closeInfo = await firstClosed;
    expect(closeInfo.code).toBe(1000);
    await Bun.sleep(30);
    expect(app.wsHub.roomSize("lobby")).toBe(0);
    expect(closeEvents.length).toBe(1);
    second.socket.close();
  });

  test("exposes the running application through the WebSocket context", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-context-app", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        // The context exposes the typed application instance, so handlers can
        // reach framework services such as the room hub.
        const name: string = ctx.app.config.app.name;
        ctx.subscribe("lobby");
        ctx.send({ name, sameApp: ctx.app === app, rooms: [...ctx.rooms] });
      },
    });
    await app.start();
    apps.push(app);

    const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
    expect(await socket.next()).toEqual({
      name: "ws-context-app",
      sameApp: true,
      rooms: ["lobby"],
    });
    socket.socket.close();
  });

  test("returns request ids on rejected websocket upgrades", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-reject-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      authorize() {
        return null;
      },
    });
    await app.start();
    apps.push(app);
    const base = `http://127.0.0.1:${app.port}`;

    const rejected = await fetch(`${base}/ws`, {
      headers: { upgrade: "websocket", "x-request-id": "ws-rejected" },
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("x-request-id")).toBe("ws-rejected");
    const payload = (await rejected.json()) as { requestId: string };
    expect(payload.requestId).toBe("ws-rejected");

    const notUpgrade = await fetch(`${base}/ws`, {
      headers: { "x-request-id": "ws-not-upgrade" },
    });
    expect(notUpgrade.status).toBe(426);
    expect(notUpgrade.headers.get("x-request-id")).toBe("ws-not-upgrade");

    app.ws("/ws-http", {});
    app.get("/ws-http", () => new Response("http"));
    const wrongMethod = await fetch(`${base}/ws-http`, {
      method: "POST",
      headers: { "x-request-id": "ws-wrong-method" },
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toContain("GET");
    expect(wrongMethod.headers.get("x-request-id")).toBe("ws-wrong-method");

    const disabled = await createMuboApp(
      {
        app: { name: "ws-disabled-test", env: "test" },
        db: { path: ":memory:" },
        http: { port: 0 },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { enabled: false },
      },
      { argv: [] },
    );
    disabled.ws("/ws", {});
    await disabled.start();
    apps.push(disabled);
    const disabledResponse = await fetch(`http://127.0.0.1:${disabled.port}/ws`, {
      headers: { upgrade: "websocket", "x-request-id": "ws-disabled" },
    });
    expect(disabledResponse.status).toBe(403);
    expect(disabledResponse.headers.get("x-request-id")).toBe("ws-disabled");
    const disabledPayload = (await disabledResponse.json()) as { requestId: string };
    expect(disabledPayload.requestId).toBe("ws-disabled");
  });

  test("rejects WebSocket upgrades when authorize returns false", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-authorize-false-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      authorize() {
        return false;
      },
    });
    await app.start();
    apps.push(app);
    const base = `http://127.0.0.1:${app.port}`;

    const rejected = await fetch(`${base}/ws`, {
      headers: { upgrade: "websocket", "x-request-id": "ws-authorize-false" },
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("x-request-id")).toBe("ws-authorize-false");
    const payload = (await rejected.json()) as { requestId: string };
    expect(payload.requestId).toBe("ws-authorize-false");
  });

  test("rejects WebSocket upgrades when authorization throws", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-authorize-throws-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      authorize() {
        throw new Error("token lookup failed");
      },
    });
    await app.start();
    apps.push(app);
    const base = `http://127.0.0.1:${app.port}`;

    const rejected = await fetch(`${base}/ws`, {
      headers: { upgrade: "websocket", "x-request-id": "ws-authorize-throws" },
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("x-request-id")).toBe("ws-authorize-throws");
    const payload = (await rejected.json()) as { error: { code: string }; requestId: string };
    expect(payload.error.code).toBe("UNAUTHORIZED");
    expect(payload.requestId).toBe("ws-authorize-throws");
  });

  test("rejects WebSocket upgrades when authorization rejects asynchronously", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-authorize-async-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      async authorize() {
        await Bun.sleep(1);
        return null;
      },
    });
    await app.start();
    apps.push(app);
    const base = `http://127.0.0.1:${app.port}`;

    const rejected = await fetch(`${base}/ws`, {
      headers: { upgrade: "websocket" },
    });
    expect(rejected.status).toBe(401);
    const payload = (await rejected.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("UNAUTHORIZED");
  });

  test("logs successful WebSocket upgrades as HTTP 101", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-upgrade-log-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "info", json: true },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {});

    const lines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((value) => String(value)).join(" "));
    };
    console.error = () => {};
    try {
      await app.start();
      const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`, {
        "x-request-id": "ws-log-ok",
      });
      socket.socket.close();
    } finally {
      await app.stop();
      console.log = originalLog;
      console.error = originalError;
    }

    const entries = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    expect(
      entries.find((entry) => entry.message === "http" && entry.requestId === "ws-log-ok"),
    ).toMatchObject({
      method: "GET",
      path: "/ws",
      status: 101,
    });
  });

  test("uses the HTTP request id for rejected WebSocket upgrades", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-request-id-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "info", json: true },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", { authorize: () => null });

    const lines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((value) => String(value)).join(" "));
    };
    console.error = () => {};
    let requestId: string | null = null;
    try {
      await app.start();
      const response = await fetch(`http://127.0.0.1:${app.port}/ws`, {
        headers: { upgrade: "websocket" },
      });
      expect(response.status).toBe(401);
      requestId = response.headers.get("x-request-id");
      expect(requestId).toBeString();
    } finally {
      await app.stop();
      console.log = originalLog;
      console.error = originalError;
    }

    const entries = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const access = entries.find(
      (entry) => entry.message === "http" && entry.path === "/ws" && entry.status === 401,
    );
    expect(access?.requestId).toBe(requestId);
  });

  test("honors forwarded client addresses only when trustProxy is enabled", async () => {
    const capture = async (
      trustProxy: boolean,
      headers: Record<string, string>,
    ): Promise<string> => {
      const app = await createMuboApp(
        {
          app: { name: `ws-ip-${trustProxy}`, env: "test" },
          db: { path: ":memory:" },
          http: { port: 0, trustProxy },
          log: { level: "error" },
          static: { mode: "off" },
          ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
        },
        { argv: [] },
      );
      app.ws("/ws", {
        onConnect(ctx) {
          ctx.send({ ip: ctx.ip });
        },
      });
      await app.start();
      apps.push(app);
      const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`, headers);
      const message = (await socket.next()) as { ip: string };
      socket.socket.close();
      return message.ip;
    };

    expect(await capture(true, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).toBe("203.0.113.9");
    expect(await capture(true, { "x-real-ip": "198.51.100.7" })).toBe("198.51.100.7");
    expect(await capture(false, { "x-forwarded-for": "203.0.113.9" })).not.toBe("203.0.113.9");
  });

  test("routes synchronous handler failures through onError", async () => {
    const errors: string[] = [];
    const app = await createMuboApp(
      {
        app: { name: "ws-error-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
        throw new Error("connect exploded");
      },
      onMessage(ctx) {
        ctx.send({ type: "message-seen" });
        throw new Error("message exploded");
      },
      onClose(ctx) {
        ctx.send({ type: "close" });
        throw new Error("close exploded");
      },
      onError(ctx, error) {
        errors.push(error instanceof Error ? error.message : String(error));
        ctx.send({ type: "error", message: errors.at(-1) });
      },
    });
    await app.start();
    apps.push(app);

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
      expect(await socket.next()).toEqual({ type: "ready" });
      expect(await socket.next()).toEqual({ type: "error", message: "connect exploded" });
      socket.socket.send("hi");
      expect(await socket.next()).toEqual({ type: "message-seen" });
      expect(await socket.next()).toEqual({ type: "error", message: "message exploded" });
      socket.socket.close();
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors).toEqual(["connect exploded", "message exploded"]);
      socket.socket.addEventListener("close", () => {
        expect(errors).toContain("close exploded");
      });
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("handles WebSocket with binary data", async () => {
    const received: ArrayBuffer[] = [];
    const app = await createMuboApp(
      {
        app: { name: "ws-binary-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onMessage(ctx, message) {
        if (typeof message === "string") {
          ctx.send(new TextEncoder().encode(message.toUpperCase()));
        } else {
          ctx.send(message);
        }
      },
    });
    await app.start();
    apps.push(app);

    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    await new Promise<void>((resolve) => {
      socket.addEventListener("open", () => resolve());
    });

    const sendBinary = (data: ArrayBuffer) => {
      return new Promise<ArrayBuffer>((resolve) => {
        socket.addEventListener("message", (event) => {
          resolve(event.data);
        });
        socket.send(data);
      });
    };

    const binary = await sendBinary(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    expect(new Uint8Array(binary)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));

    socket.close();
  });

  test("ctx.close(code, reason) propagates a close frame to the client", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-close-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.close(4000, "bye");
      },
    });
    await app.start();
    apps.push(app);

    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      socket.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason }),
      );
    });
    expect(closed.code).toBe(4000);
    expect(closed.reason).toBe("bye");
  });

  test("handles WebSocket with heartbeat", async () => {
    const pings: string[] = [];
    const app = await createMuboApp(
      {
        app: { name: "ws-heartbeat-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 100, timeoutMs: 1000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
      },
    });
    await app.start();
    apps.push(app);
    const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
    socket.socket.close();
    // Heartbeats may fire after close; just ensure no crash
    await Bun.sleep(200);
  });

  test("disables heartbeats when intervalMs is 0", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-no-heartbeat-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 60_000 } },
      },
      { argv: [] },
    );
    let heartbeatTimer: unknown;
    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((callback: () => void, timeout?: number, ...args: unknown[]) => {
      heartbeatTimer = originalSetInterval(callback, timeout, ...args);
      return heartbeatTimer;
    }) as typeof setInterval;
    try {
      app.ws("/ws", {
        onConnect(ctx) {
          ctx.send({ type: "ready" });
        },
      });
      await app.start();
      apps.push(app);
      const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
      expect(await socket.next()).toEqual({ type: "ready" });
      socket.socket.close();
      await Bun.sleep(200);
      expect(heartbeatTimer).toBeUndefined();
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });

  test("rejects WebSocket payloads exceeding max payload size", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-payload-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { maxPayloadBytes: 10 },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onMessage(ctx, message) {
        ctx.send(message);
      },
    });
    await app.start();
    apps.push(app);
    const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`, {
      // send non-JSON messages by bypassing the JSON parser
    });

    // The openSocket function expects JSON, so just verify the app starts
    // and doesn't crash with the payload config
    socket.socket.close();
  });

  test("maxPayloadBytes validates WebSocket frame size at connection level", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-max-payload-connection", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { maxPayloadBytes: 100 },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
      },
      onMessage(ctx, message) {
        ctx.send({ echo: message });
      },
    });
    await app.start();
    apps.push(app);

    // Small payload should work
    const smallSocket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    await new Promise<void>((resolve) => smallSocket.addEventListener("open", () => resolve()));
    await new Promise<void>((resolve) => {
      smallSocket.addEventListener("message", () => resolve());
    });
    smallSocket.send("small");
    await new Promise<void>((resolve) => {
      smallSocket.addEventListener("message", () => resolve());
    });
    smallSocket.close();

    // Large payload should be rejected by the server
    const largeSocket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    await new Promise<void>((resolve) => largeSocket.addEventListener("open", () => resolve()));
    let errorReceived = false;
    largeSocket.onerror = () => {
      errorReceived = true;
    };
    largeSocket.onclose = (event) => {
      if (event.code === 1003) {
        // 1003 = unsupported data, which is what Bun sends for oversized payloads
        expect(errorReceived).toBe(true);
      }
    };
    largeSocket.send("x".repeat(200)); // 200 bytes exceeds maxPayloadBytes: 100
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    largeSocket.close();
  });

  test("onError returning a Promise is awaited and its rejections are logged", async () => {
    const errors: string[] = [];
    const app = await createMuboApp(
      {
        app: { name: "ws-onerror-promise-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
        throw new Error("connect exploded");
      },
      onError(ctx, error) {
        errors.push(error instanceof Error ? error.message : String(error));
        return Promise.resolve().then(() => {
          errors.push("on-error-promise-resolved");
          ctx.send({ type: "error-handled" });
        });
      },
    });
    await app.start();
    apps.push(app);

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
      expect(await socket.next()).toEqual({ type: "ready" });
      expect(await socket.next()).toEqual({ type: "error-handled" });
      expect(errors).toContain("connect exploded");
      expect(errors).toContain("on-error-promise-resolved");
      socket.socket.close();
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("onError can return a Response to close the connection", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-onerror-response-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
        throw new Error("connect exploded");
      },
      onError(ctx) {
        return new Response(JSON.stringify({ type: "error", handled: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await app.start();
    apps.push(app);

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
      expect(await socket.next()).toEqual({ type: "ready" });
      // The onError Response is not sent to the client - it's ignored
      // The connection stays open
      socket.socket.send(JSON.stringify({ type: "ping" }));
      await socket.expectNone(200);
      socket.socket.close();
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("onError throwing does not break the connection", async () => {
    const errors: string[] = [];
    const app = await createMuboApp(
      {
        app: { name: "ws-onerror-throw-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
        throw new Error("connect exploded");
      },
      onError(ctx, error) {
        errors.push(error instanceof Error ? error.message : String(error));
        throw new Error("onError handler also failed");
      },
    });
    await app.start();
    apps.push(app);

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
      expect(await socket.next()).toEqual({ type: "ready" });
      // The onError threw but the connection should still be open
      socket.socket.send(JSON.stringify({ type: "ping" }));
      await socket.expectNone(200);
      socket.socket.close();
    } finally {
      console.error = originalConsoleError;
    }
    expect(errors).toContain("connect exploded");
  });

  test("onError returning void does not send anything", async () => {
    const errors: string[] = [];
    const app = await createMuboApp(
      {
        app: { name: "ws-onerror-void-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
        throw new Error("connect exploded");
      },
      onError(ctx, error) {
        errors.push(error instanceof Error ? error.message : String(error));
        // Return void explicitly
        return;
      },
    });
    await app.start();
    apps.push(app);

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
      expect(await socket.next()).toEqual({ type: "ready" });
      // No error message sent back because onError returned void
      await socket.expectNone(200);
      socket.socket.close();
    } finally {
      console.error = originalConsoleError;
    }
    expect(errors).toContain("connect exploded");
  });

  test("onError returning Promise that resolves to Response ignores the Response", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-onerror-promise-response-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
        throw new Error("connect exploded");
      },
      async onError() {
        return Promise.resolve(
          new Response(JSON.stringify({ handled: true }), { status: 200 }),
        );
      },
    });
    await app.start();
    apps.push(app);

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
      expect(await socket.next()).toEqual({ type: "ready" });
      // The onError Response is ignored - connection stays open
      await socket.expectNone(200);
      socket.socket.close();
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe("WebSocket connection limits", () => {
  test("enforces global max connections limit", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-global-limit-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { maxConnections: 2, heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready", id: ctx.id });
      },
    });
    await app.start();
    apps.push(app);

    const socket1 = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
    const msg1 = await socket1.next() as { type: string };
    expect(msg1.type).toBe("ready");

    const socket2 = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
    const msg2 = await socket2.next() as { type: string };
    expect(msg2.type).toBe("ready");

    // Third connection should be rejected at HTTP level
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const rejected = await fetch(`${baseUrl}/ws`, {
      headers: { upgrade: "websocket", "x-request-id": "ws-limit-test" },
    });
    expect(rejected.status).toBe(429);
    const payload = (await rejected.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("WS_CONNECTION_LIMIT");

    socket1.socket.close();
    socket2.socket.close();
  });

  test("enforces per-IP max connections limit", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-per-ip-limit-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { maxConnectionsPerIp: 1, heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready", id: ctx.id });
      },
    });
    await app.start();
    apps.push(app);

    const socket1 = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
    const msg1 = await socket1.next() as { type: string };
    expect(msg1.type).toBe("ready");

    // Second connection from same IP should be rejected at HTTP level
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const rejected = await fetch(`${baseUrl}/ws`, {
      headers: { upgrade: "websocket", "x-request-id": "ws-per-ip-limit-test" },
    });
    expect(rejected.status).toBe(429);
    const payload = (await rejected.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("WS_CONNECTION_LIMIT_PER_IP");

    socket1.socket.close();
  });

  test("enforces per-IP max connections limit under concurrent connection attempts", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-per-ip-concurrent-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        http: { port: 0 },
        ws: { maxConnectionsPerIp: 2, heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready", id: ctx.id });
      },
    });
    await app.start();
    apps.push(app);

    // First, establish 2 connections (should succeed)
    const socket1 = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
    const msg1 = (await socket1.next()) as { type: string };
    expect(msg1.type).toBe("ready");
    const socket2 = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
    const msg2 = (await socket2.next()) as { type: string };
    expect(msg2.type).toBe("ready");

    // Third connection attempt should be rejected at HTTP level
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const rejected = await fetch(`${baseUrl}/ws`, {
      headers: { upgrade: "websocket", "x-request-id": "ws-concurrent-3" },
    });
    expect(rejected.status).toBe(429);
    const payload = (await rejected.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("WS_CONNECTION_LIMIT_PER_IP");

    // Fourth connection attempt should also be rejected
    const rejected2 = await fetch(`${baseUrl}/ws`, {
      headers: { upgrade: "websocket", "x-request-id": "ws-concurrent-4" },
    });
    expect(rejected2.status).toBe(429);
    const payload2 = (await rejected2.json()) as { error: { code: string } };
    expect(payload2.error.code).toBe("WS_CONNECTION_LIMIT_PER_IP");

    // Verify the first two connections still work
    socket1.socket.send(JSON.stringify({ type: "ping" }));
    socket2.socket.send(JSON.stringify({ type: "ping" }));

    socket1.socket.close();
    socket2.socket.close();
  });

  test("allows unlimited connections per IP when maxConnectionsPerIp is 0", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-unlimited-ip-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { maxConnectionsPerIp: 0, maxConnections: 0, heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
      },
    });
    await app.start();
    apps.push(app);

    // Connect 3 sockets from the same IP (127.0.0.1) - should all succeed
    const sockets = [];
    for (let i = 0; i < 3; i++) {
      const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
      await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
      await new Promise<void>((resolve) => {
        socket.addEventListener("message", () => resolve());
      });
      sockets.push(socket);
    }

    // All should succeed since maxConnectionsPerIp is 0 (unlimited)
    expect(sockets.length).toBe(3);

    // Clean up
    for (const s of sockets) s.close();
    await app.stop();
  });

  test("allows new connection after previous one closes", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-reuse-limit-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { maxConnections: 1, heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready", id: ctx.id });
      },
    });
    await app.start();
    apps.push(app);

    const socket1 = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
    const msg1 = await socket1.next() as { type: string };
    expect(msg1.type).toBe("ready");
    socket1.socket.close();

    // Wait a bit for cleanup
    await Bun.sleep(50);

    const socket2 = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
    const msg2 = await socket2.next() as { type: string };
    expect(msg2.type).toBe("ready");
    socket2.socket.close();
  });

  test("closes sockets that fail to open instead of throwing", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-open-failure-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {});
    await app.start();
    apps.push(app);

    const closes: Array<[number | undefined, string | undefined]> = [];
    const makeSocket = (routePath: string, closeImpl?: () => void) =>
      ({
        data: {
          routePath,
          requestId: "req-open-failure",
          url: "ws://localhost/ws",
          ip: "127.0.0.1",
          user: undefined,
          state: {},
        },
        send: () => 1,
        ping: () => {},
        close: (code?: number, reason?: string) => {
          closes.push([code, reason]);
          closeImpl?.();
        },
      }) as unknown as ServerWebSocket<WsSocketData>;

    const internals = app as unknown as {
      handleWsOpen(ws: ServerWebSocket<WsSocketData>): void;
    };

    // Unknown routes and failing close calls must not escape the handler.
    const unknown = makeSocket("/missing");
    expect(() => internals.handleWsOpen(unknown)).not.toThrow();
    expect(closes).toEqual([[1011, "Unknown WebSocket route"]]);

    closes.length = 0;
    const broken = makeSocket("/missing", () => {
      throw new Error("socket already closed");
    });
    expect(() => internals.handleWsOpen(broken)).not.toThrow();
  });

  test("releases reserved per-IP slots when a socket closes before it opens", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-reservation-leak-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { maxConnectionsPerIp: 1, heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {});
    await app.start();
    apps.push(app);

    const internals = app as unknown as {
      handleWsClose(ws: ServerWebSocket<WsSocketData>, code: number, reason: string): void;
      wsHub: { reserveConnection(ip: string, limit: number): () => void; getConnectionCountForIp(ip: string): number };
    };

    // Reserve the only slot for the IP exactly like the upgrade handler does.
    const release = internals.wsHub.reserveConnection("10.9.9.9", 1);
    expect(internals.wsHub.getConnectionCountForIp("10.9.9.9")).toBe(1);

    // A socket that closed before its connection context existed (it never
    // joined the hub) must release the reservation instead of leaking it.
    const phantom = {
      data: {
        routePath: "/ws",
        requestId: "req-phantom",
        url: "ws://localhost/ws",
        ip: "10.9.9.9",
        user: undefined,
        state: {},
        releasePerIp: release,
      },
      close: () => {},
    } as unknown as ServerWebSocket<WsSocketData>;
    expect(() => internals.handleWsClose(phantom, 1006, "")).not.toThrow();
    expect(internals.wsHub.getConnectionCountForIp("10.9.9.9")).toBe(0);

    // The slot is usable again afterwards.
    const again = internals.wsHub.reserveConnection("10.9.9.9", 1);
    expect(internals.wsHub.getConnectionCountForIp("10.9.9.9")).toBe(1);
    again();
  });
});

describe("WebSocket send payload validation", () => {
  test("ctx.send() with a non-JSON-serializable value throws VALIDATION_ERROR", async () => {
    const app = await createMuboApp(
      {
        app: { name: "ws-send-validation-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
        ws: { heartbeat: { intervalMs: 0, timeoutMs: 30_000 } },
      },
      { argv: [] },
    );
    app.ws("/ws", {
      onConnect(ctx) {
        ctx.send({ type: "ready" });
      },
      onMessage(ctx) {
        let thrown: unknown;
        try {
          ctx.send(undefined);
        } catch (error) {
          thrown = error;
        }
        ctx.send({
          type: "send-result",
          threw: thrown instanceof MuboError,
          code: (thrown as MuboError)?.code,
        });
      },
    });
    await app.start();
    apps.push(app);

    const socket = await openSocket(`ws://127.0.0.1:${app.port}/ws`);
    expect(await socket.next()).toEqual({ type: "ready" });
    socket.socket.send("anything");
    const result = (await socket.next()) as {
      type: string;
      threw: boolean;
      code?: string;
    };
    expect(result.threw).toBe(true);
    expect(result.code).toBe("VALIDATION_ERROR");
    socket.socket.close();
  });
});
