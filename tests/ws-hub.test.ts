import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createLogger } from "../src/core/logger.ts";
import { MuboError } from "../src/core/errors.ts";
import { WsRoomHub, type WsSocketData } from "../src/ws/hub.ts";

const logger = createLogger({ level: "error" });

function fakeSocket(sendStatus?: number): {
  ws: ServerWebSocket<WsSocketData>;
  sent: unknown[];
  readonly pings: number;
  readonly closes: Array<[number | undefined, string | undefined]>;
} {
  const sent: unknown[] = [];
  const closes: Array<[number | undefined, string | undefined]> = [];
  let pings = 0;
  const ws = {
    data: {
      routePath: "/ws",
      requestId: "req-hub",
      url: "ws://localhost/ws",
      ip: "127.0.0.1",
      user: undefined,
      state: {},
    },
    send(data: unknown) {
      sent.push(data);
      return sendStatus;
    },
    ping() {
      pings++;
    },
    close(code?: number, reason?: string) {
      closes.push([code, reason]);
    },
  } as unknown as ServerWebSocket<WsSocketData>;
  return {
    ws,
    sent,
    get pings() {
      return pings;
    },
    closes,
  };
}

describe("WebSocket room hub", () => {
  test("tracks clients, room membership and targeted broadcasts", () => {
    const hub = new WsRoomHub();
    const first = fakeSocket();
    const second = fakeSocket();
    const firstCtx = hub.add(first.ws, null, logger, "10.0.0.1");
    const secondCtx = hub.add(second.ws, null, logger, "10.0.0.2");

    expect(hub.clientCount).toBe(2);
    expect(hub.getContext(first.ws)).toBe(firstCtx);
    expect(firstCtx.ip).toBe("10.0.0.1");
    expect(secondCtx.ip).toBe("10.0.0.2");

    hub.subscribe(firstCtx, "lobby");
    hub.subscribe(firstCtx, "lobby");
    hub.subscribe(secondCtx, "lobby");
    expect(hub.roomSize("lobby")).toBe(2);
    expect([...firstCtx.rooms]).toEqual(["lobby"]);

    expect(hub.publish("lobby", { event: 1 })).toBe(2);
    expect(JSON.parse(first.sent[0] as string)).toEqual({ event: 1 });
    expect(JSON.parse(second.sent[0] as string)).toEqual({ event: 1 });

    expect(hub.publish("lobby", { event: 2 }, { except: secondCtx.id })).toBe(1);
    expect(JSON.parse(first.sent[1] as string)).toEqual({ event: 2 });
    expect(second.sent).toHaveLength(1);

    expect(hub.broadcast({ event: 3 }, { except: firstCtx.id })).toBe(1);
    expect(JSON.parse(second.sent[1] as string)).toEqual({ event: 3 });

    firstCtx.emit("custom", 7, "message-1");
    expect(JSON.parse(first.sent[2] as string)).toEqual({
      t: "event",
      e: "custom",
      d: 7,
      id: "message-1",
    });
  });

  test("exposes room publish and global broadcast counts on contexts", () => {
    const hub = new WsRoomHub();
    const first = fakeSocket();
    const second = fakeSocket();
    const firstCtx = hub.add(first.ws, null, logger, "127.0.0.1");
    const secondCtx = hub.add(second.ws, null, logger, "127.0.0.1");
    hub.subscribe(firstCtx, "lobby");
    hub.subscribe(secondCtx, "lobby");

    expect(firstCtx.publish("lobby", { event: 1 })).toBe(2);
    expect(JSON.parse(second.sent[0] as string)).toEqual({ event: 1 });

    expect(firstCtx.broadcast({ event: 2 }, { except: firstCtx.id })).toBe(1);
    expect(JSON.parse(second.sent[1] as string)).toEqual({ event: 2 });
    expect(first.sent).toHaveLength(1);
  });

  test("is idempotent for duplicate socket registration", () => {
    const hub = new WsRoomHub();
    const socket = fakeSocket();
    const first = hub.add(socket.ws, null, logger, "127.0.0.1");
    const second = hub.add(socket.ws, null, logger, "127.0.0.1");

    expect(second).toBe(first);
    expect(hub.clientCount).toBe(1);
    hub.subscribe(first, "lobby");
    expect(hub.publish("lobby", { ok: true })).toBe(1);
    expect(socket.sent).toHaveLength(1);
  });

  test("ignores subscribe and unsubscribe for unknown client ids", () => {
    const hub = new WsRoomHub();
    expect(() => hub.subscribe("stale-id", "lobby")).not.toThrow();
    expect(() => hub.unsubscribe("stale-id", "lobby")).not.toThrow();
    expect(hub.roomSize("lobby")).toBe(0);

    const socket = fakeSocket();
    const ctx = hub.add(socket.ws, null, logger, "");
    hub.subscribe(ctx, "lobby");
    hub.remove(socket.ws);
    expect(() => hub.subscribe(ctx.id, "lobby")).not.toThrow();
    expect(() => hub.unsubscribe(ctx.id, "lobby")).not.toThrow();
    expect(hub.clientCount).toBe(0);
  });

  test("rejects blank room names and reports failed sends", () => {
    const hub = new WsRoomHub();
    const socket = fakeSocket();
    const ctx = hub.add(socket.ws, null, logger, "");
    hub.subscribe(ctx, "lobby");

    for (const room of ["", "   ", "\n\t", "\0", "\x01"]) {
      expect(() => hub.subscribe(ctx, room)).toThrow(MuboError);
      expect(() => hub.unsubscribe(ctx, room)).toThrow(MuboError);
      expect(() => hub.publish(room, {})).toThrow(MuboError);
      expect(() => hub.roomSize(room)).toThrow(MuboError);
    }
    expect(() => hub.subscribe(ctx, 42 as never)).toThrow(/Room name cannot be empty/);
    expect(() => hub.publish(42 as never, {})).toThrow(/Room name cannot be empty/);
    expect(() => hub.roomSize(42 as never)).toThrow(/Room name cannot be empty/);
    expect(hub.publish("lobby", { value: 1n })).toBe(1);
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ value: "1" });
    expect(hub.broadcast({ value: 1n })).toBe(1);
    expect(socket.sent).toHaveLength(2);
  });

  test("counts only sends accepted by the socket", () => {
    const hub = new WsRoomHub();
    const dropped = fakeSocket(0);
    const empty = fakeSocket(0);
    const queued = fakeSocket(-1);
    const sent = fakeSocket(12);
    for (const socket of [dropped, empty, queued, sent]) {
      hub.subscribe(hub.add(socket.ws, null, logger, ""), "lobby");
    }

    expect(hub.publish("lobby", { ok: true })).toBe(2);
    expect(dropped.sent).toHaveLength(1);
    expect(queued.sent).toHaveLength(1);
    expect(sent.sent).toHaveLength(1);

    expect(hub.publish("lobby", "")).toBe(4);
    expect(empty.sent).toHaveLength(2);
  });

  test("direct sends reject payloads without JSON representations", () => {
    const hub = new WsRoomHub();
    const socket = fakeSocket();
    const ctx = hub.add(socket.ws, null, logger, "");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => ctx.send(circular)).toThrow(MuboError);
    expect(() => ctx.send(() => 1)).toThrow(MuboError);
    expect(socket.sent).toHaveLength(0);

    ctx.send({ ok: true });
    ctx.emit("ready", { ok: true });
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ ok: true });
    expect(JSON.parse(socket.sent[1] as string)).toEqual({
      t: "event",
      e: "ready",
      d: { ok: true },
    });

    const failing = fakeSocket();
    failing.ws.send = () => {
      throw new Error("closed");
    };
    const failingCtx = hub.add(failing.ws, null, logger, "");
    expect(() => failingCtx.send({ ok: true })).not.toThrow();
  });

  test("exposes room subscriptions as a read-only live view", () => {
    const hub = new WsRoomHub();
    const socket = fakeSocket();
    const ctx = hub.add(socket.ws, null, logger, "");
    hub.subscribe(ctx, "lobby");

    expect(ctx.rooms.has("lobby")).toBe(true);
    expect(ctx.rooms.size).toBe(1);
    expect([...ctx.rooms]).toEqual(["lobby"]);

    const rooms = ctx.rooms as Set<string>;
    expect(() => rooms.add("ghost")).toThrow(/read-only/);
    expect(() => rooms.delete("lobby")).toThrow(/read-only/);
    expect(() => rooms.clear()).toThrow(/read-only/);
    expect(() => {
      (rooms as unknown as Record<string, unknown>).tampered = true;
    }).toThrow(/read-only/);
    expect(() => {
      delete (rooms as unknown as Record<string, unknown>).tampered;
    }).toThrow(/read-only/);

    expect(hub.roomSize("lobby")).toBe(1);
    expect(hub.roomSize("ghost")).toBe(0);
    expect([...ctx.rooms]).toEqual(["lobby"]);

    hub.unsubscribe(ctx, "lobby");
    expect(ctx.rooms.size).toBe(0);
    expect(ctx.rooms.has("lobby")).toBe(false);
  });

  test("releases rooms and clients on removal", () => {
    const hub = new WsRoomHub();
    const first = fakeSocket();
    const second = fakeSocket();
    const firstCtx = hub.add(first.ws, null, logger, "");
    const secondCtx = hub.add(second.ws, null, logger, "");
    hub.subscribe(firstCtx, "one");
    hub.subscribe(firstCtx, "two");
    hub.subscribe(secondCtx, "one");

    expect(hub.unsubscribe(firstCtx, "missing")).toBeUndefined();
    hub.unsubscribe(secondCtx, "one");
    expect(firstCtx.rooms.has("one")).toBe(true);
    expect(secondCtx.rooms.has("one")).toBe(false);

    expect(hub.remove(first.ws)).toBe(firstCtx);
    expect(hub.remove(first.ws)).toBeUndefined();
    expect(hub.clientCount).toBe(1);
    expect(hub.roomSize("one")).toBe(0);
    expect(hub.roomSize("two")).toBe(0);
    expect(firstCtx.rooms.size).toBe(0);
  });

  test("isolates socket state from object prototype keys", () => {
    const hub = new WsRoomHub();
    const socket = fakeSocket();
    const ctx = hub.add(socket.ws, null, logger, "");

    expect((ctx.state as { toString?: unknown }).toString).toBeUndefined();
    ctx.state["__proto__"] = { polluted: "yes" };
    expect((ctx.state as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect((ctx.state as { constructor?: unknown }).constructor).toBeUndefined();
  });

  test("rejects empty room names and handles pings and shutdown", () => {
    const hub = new WsRoomHub();
    const first = fakeSocket();
    const second = fakeSocket();
    const firstCtx = hub.add(first.ws, null, logger, "");
    hub.add(second.ws, null, logger, "");

    expect(() => hub.subscribe(firstCtx, "")).toThrow(MuboError);
    expect(hub.roomSize("missing")).toBe(0);
    expect(hub.publish("missing", {})).toBe(0);

    hub.pingAll();
    expect(first.pings).toBe(1);
    expect(second.pings).toBe(1);

    hub.closeAll(1001, "restart");
    expect(first.closes).toEqual([[1001, "restart"]]);
    expect(second.closes).toEqual([[1001, "restart"]]);
  });

  test("rejects room names containing whitespace", () => {
    const hub = new WsRoomHub();
    const socket = fakeSocket();
    const ctx = hub.add(socket.ws, null, logger, "");
    expect(() => hub.subscribe(ctx, "my room")).toThrow(MuboError);
    expect(() => hub.subscribe(ctx, "room\t")).toThrow(MuboError);
    expect(() => hub.subscribe(ctx, " room")).toThrow(MuboError);
    expect(() => hub.publish("bad name", {})).toThrow(MuboError);
  });

  test("rejects sending non-JSON-serializable payloads via ctx.send", () => {
    const hub = new WsRoomHub();
    const socket = fakeSocket();
    const ctx = hub.add(socket.ws, null, logger, "");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => ctx.send(circular)).toThrow(MuboError);
    expect(() => ctx.send(function() { return 1; })).toThrow(MuboError);
    expect(socket.sent).toHaveLength(0);
  });

  test("publish and broadcast with non-existent room return zero for publish, broadcast counts clients", () => {
    const hub = new WsRoomHub();
    const socket = fakeSocket();
    const ctx = hub.add(socket.ws, null, logger, "");

    expect(hub.publish("nonexistent", { data: 1 })).toBe(0);
    expect(hub.broadcast({ data: 1 })).toBe(1);
  });

  test("broadcast with a non-existent except id reaches every client", () => {
    const hub = new WsRoomHub();
    const first = fakeSocket();
    const second = fakeSocket();
    hub.add(first.ws, null, logger, "127.0.0.1");
    hub.add(second.ws, null, logger, "127.0.0.1");

    expect(hub.broadcast({ event: 1 }, { except: "does-not-exist" })).toBe(2);
    expect(JSON.parse(first.sent[0] as string)).toEqual({ event: 1 });
    expect(JSON.parse(second.sent[0] as string)).toEqual({ event: 1 });
  });

  test("handles send failure when socket returns 0 for non-empty payload", () => {
    const hub = new WsRoomHub();
    const failing = fakeSocket(0);
    const ctx = hub.add(failing.ws, null, logger, "");

    hub.subscribe(ctx, "test");
    const result = hub.publish("test", { data: 1 });
    expect(result).toBe(0);
    expect(failing.sent).toHaveLength(1);
  });

  test("handles ping failure gracefully", async () => {
    const hub = new WsRoomHub();
    const errorSocket = fakeSocket();
    const pingError = new Error("ping failed");
    errorSocket.ws.ping = () => {
      throw pingError;
    };
    hub.add(errorSocket.ws, null, logger, "");

    hub.pingAll();
  });

  test("handles close failure gracefully", () => {
    const hub = new WsRoomHub();
    const errorSocket = fakeSocket();
    errorSocket.ws.close = () => {
      throw new Error("close failed");
    };
    hub.add(errorSocket.ws, null, logger, "");

    expect(() => hub.closeAll()).not.toThrow();
  });

  test("handles WebSocket error handler failures gracefully", async () => {
    const errors: string[] = [];
    const hub = new WsRoomHub(createLogger({ level: "error" }));
    const socket = fakeSocket();
    const ctx = hub.add(socket.ws, null, createLogger({ level: "error" }), "");

    ctx.send({ value: 1 });
    expect(socket.sent).toHaveLength(1);
  });

  test("does not count payloads that cannot be serialized", () => {
    const hub = new WsRoomHub(logger);
    const socket = fakeSocket();
    const ctx = hub.add(socket.ws, null, logger, "127.0.0.1");
    hub.subscribe(ctx, "lobby");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(hub.publish("lobby", circular)).toBe(0);
    expect(hub.broadcast(circular)).toBe(0);
    expect(socket.sent).toHaveLength(0);
  });

  test("tracks per-IP connection count and releases the slot on removal", () => {
    const hub = new WsRoomHub(logger, 0, 100);
    const first = fakeSocket();
    const second = fakeSocket();

    hub.add(first.ws, null, logger, "10.0.0.1");
    hub.add(second.ws, null, logger, "10.0.0.1");
    expect(hub.getConnectionCountForIp("10.0.0.1")).toBe(2);

    hub.remove(second.ws);
    expect(hub.getConnectionCountForIp("10.0.0.1")).toBe(1);
    hub.remove(first.ws);
    expect(hub.getConnectionCountForIp("10.0.0.1")).toBe(0);
  });

  test("treats empty binary payloads as successful sends", () => {
    const hub = new WsRoomHub(logger);
    const socket = fakeSocket(0);
    const ctx = hub.add(socket.ws, null, logger, "127.0.0.1");
    hub.subscribe(ctx, "lobby");

    expect(hub.publish("lobby", new ArrayBuffer(0))).toBe(1);
    expect(hub.publish("lobby", new Uint8Array(0))).toBe(1);
    expect(hub.publish("lobby", new Blob([]))).toBe(1);
    expect(socket.sent).toHaveLength(3);
  });

  test("reserveConnection releases slot correctly when count reaches zero", () => {
    const hub = new WsRoomHub(logger, 0, 2);
    const release = hub.reserveConnection("10.0.0.5", 2);
    expect(hub.getConnectionCountForIp("10.0.0.5")).toBe(1);
    release();
    expect(hub.getConnectionCountForIp("10.0.0.5")).toBe(0);
  });

  test("reserveConnection handles release when count is already zero", () => {
    const hub = new WsRoomHub(logger, 0, 2);
    const release = hub.reserveConnection("10.0.0.6", 2);
    release();
    release(); // Second release should not throw or corrupt state
    expect(hub.getConnectionCountForIp("10.0.0.6")).toBe(0);
  });

  test("reserveConnection throws when limit exceeded and releases on error", () => {
    const hub = new WsRoomHub(logger, 0, 1);
    hub.reserveConnection("10.0.0.7", 1);
    expect(() => hub.reserveConnection("10.0.0.7", 1)).toThrow(/Too many connections/);
    expect(hub.getConnectionCountForIp("10.0.0.7")).toBe(1);
  });
});
