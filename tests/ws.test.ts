import { afterEach, describe, expect, test } from "bun:test";
import { createMuboApp, type MuboApp } from "../src/index.ts";

const apps: MuboApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.stop();
});

interface TestSocket {
  socket: WebSocket;
  next(timeoutMs?: number): Promise<unknown>;
  expectNone(timeoutMs?: number): Promise<void>;
}

function openSocket(url: string): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
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
