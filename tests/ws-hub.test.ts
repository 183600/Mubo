import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createLogger } from "../src/core/logger.ts";
import { MuboError } from "../src/core/errors.ts";
import { WsRoomHub, type WsSocketData } from "../src/ws/hub.ts";

const logger = createLogger({ level: "error" });

function fakeSocket(): {
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
});
