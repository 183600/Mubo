import { afterEach, describe, expect, test } from "bun:test";
import { createMuboApp, serializePayload, type MuboApp } from "../src/index.ts";
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
      expect(errors).toEqual(["connect exploded", "message exploded"]);
      socket.socket.close();
    } finally {
      console.error = originalConsoleError;
    }
  });
});
