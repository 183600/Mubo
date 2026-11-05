import type { ServerWebSocket } from "bun";
import { errorMessage, MuboError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type { MuboApp } from "../core/app.ts";

export type WsPayload = string | ArrayBuffer | ArrayBufferView | Blob | unknown;

export interface WsSocketData {
  /** The WebSocket route path associated with this connection. */
  routePath: string;
  /** Unique request identifier for the connection. */
  requestId: string;
  /** The full URL of the WebSocket connection. */
  url: string;
  /** The resolved client IP address. */
  ip: string;
  /** Authorization result from the connection's authorize hook. */
  user: unknown;
  /** Additional connection-level state. */
  state: Record<string, unknown>;
}

export interface MuboWsContext<App = MuboApp> {
  /** Unique connection identifier. */
  readonly id: string;
  readonly ws: ServerWebSocket<WsSocketData>;
  readonly ip: string;
  readonly url: string;
  readonly requestId: string;
  /** Authorization result from the connection's authorize hook. */
  readonly user: unknown;
  readonly state: Record<string, unknown>;
  /** Read-only live view of the current room subscriptions. */
  readonly rooms: ReadonlySet<string>;
  readonly log: Logger;
  /** The application instance that owns the connection. */
  readonly app: App;
  send(data: WsPayload): void;
  /** Emit an event to the connection. */
  emit(event: string, data?: unknown, id?: string): void;
  /** Publish data to a specific room. */
  publish(room: string, data: WsPayload): number;
  /** Broadcast data to all connections (optionally excluding some). */
  broadcast(data: WsPayload, options?: { except?: string }): number;
  /** Subscribe to a room. */
  subscribe(room: string): void;
  /** Unsubscribe from a room. */
  unsubscribe(room: string): void;
  /** Close the WebSocket connection. */
  close(code?: number, reason?: string): void;
}

export interface WsHandlers {
  /** Optional authorization hook. Returns user context, null/false to reject. */
  authorize?: (
    request: Request,
    info: { path: string },
  ) => unknown | null | false | Promise<unknown | null | false>;
  /** Called when a connection is established. */
  onConnect?: (ctx: MuboWsContext) => unknown | Promise<unknown>;
  /** Called when a message is received. */
  onMessage?: (ctx: MuboWsContext, message: string | Buffer) => unknown | Promise<unknown>;
  /** Called when a connection is closed. */
  onClose?: (ctx: MuboWsContext, code: number, reason: string) => unknown | Promise<unknown>;
  /** Called when a message handling error occurs. */
  onError?: (ctx: MuboWsContext, error: unknown) => unknown | Promise<unknown>;
}

interface Client<App> {
  ctx: MuboWsContext<App>;
  ws: ServerWebSocket<WsSocketData>;
  rooms: Set<string>;
}

function isRawPayload(data: unknown): data is string | ArrayBuffer | ArrayBufferView | Blob {
  return (
    typeof data === "string" ||
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data) ||
    data instanceof Blob
  );
}

function serializeBigint(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function serializePayload(data: unknown): string | ArrayBuffer | ArrayBufferView | Blob {
  /** Serializes a payload for WebSocket transmission. */
  if (isRawPayload(data)) return data;
  if (typeof data === "bigint") return data.toString();
  let json: string | undefined;
  try {
    json = JSON.stringify(data, serializeBigint);
  } catch (error) {
    throw new MuboError("VALIDATION_ERROR", "WebSocket payload is not JSON serializable", { cause: error });
  }
  if (json === undefined) {
    throw new MuboError("VALIDATION_ERROR", "WebSocket payload is not JSON serializable");
  }
  return json;
}

function assertRoomName(room: string): void {
  if (typeof room !== "string" || room.trim().length === 0) {
    throw new MuboError("VALIDATION_ERROR", "Room name cannot be empty");
  }
  if (/\s/.test(room)) {
    throw new MuboError("VALIDATION_ERROR", "Room name cannot contain whitespace");
  }
  if (/\0/.test(room) || /[\x01-\x1F\x7F]/.test(room)) {
    throw new MuboError("VALIDATION_ERROR", "Room name cannot contain control characters");
  }
}

function isEmptyPayload(payload: string | ArrayBuffer | ArrayBufferView | Blob): boolean {
  if (typeof payload === "string") return payload.length === 0;
  if (payload instanceof Blob) return payload.size === 0;
  return payload.byteLength === 0;
}

const READONLY_SET_MUTATORS = new Set(["add", "delete", "clear"]);

function readonlySetError(): never {
  throw new MuboError(
    "VALIDATION_ERROR",
    "Room subscriptions are read-only; use subscribe() or unsubscribe() instead",
  );
}

/** Creates a read-only view of a Set, preventing direct mutation. */
export function createReadonlySetView<T>(source: Set<T>): ReadonlySet<T> {
  const bound = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy(source, {
    get(target, property) {
      if (typeof property === "string" && READONLY_SET_MUTATORS.has(property)) {
        return readonlySetError;
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      let method = bound.get(property);
      if (!method) {
        method = value.bind(target) as (...args: unknown[]) => unknown;
        bound.set(property, method);
      }
      return method;
    },
    set() {
      return readonlySetError();
    },
    deleteProperty() {
      return readonlySetError();
    },
  });
}

function sendStatus(
  ws: ServerWebSocket<WsSocketData>,
  payload: string | ArrayBuffer | ArrayBufferView | Blob,
  logger?: Logger,
): boolean {
  const status = ws.send(payload as any);
  if (status === 0 && !isEmptyPayload(payload)) {
    logger?.warn("WebSocket send failed", { error: "Message dropped" });
    return false;
  }
  return true;
}

function safeSend(ws: ServerWebSocket<WsSocketData>, data: unknown, logger?: Logger): boolean {
  try {
    return sendStatus(ws, serializePayload(data), logger);
  } catch (error) {
    logger?.warn("WebSocket send failed", { error: errorMessage(error) });
    return false;
  }
}

function sendDirect(ws: ServerWebSocket<WsSocketData>, data: unknown, logger?: Logger): void {
  const payload = serializePayload(data);
  try {
    sendStatus(ws, payload, logger);
  } catch (error) {
    logger?.warn("WebSocket send failed", { error: errorMessage(error) });
  }
}

export class WsRoomHub<App = unknown> {
  private readonly clients = new Map<string, Client<App>>();
  private readonly clientsBySocket = new Map<ServerWebSocket<WsSocketData>, Client<App>>();
  private readonly rooms = new Map<string, Set<Client<App>>>();
  private readonly logger?: Logger;
  private readonly maxConnections: number;
  private readonly maxConnectionsPerIp: number;
  private readonly connectionsPerIp = new Map<string, number>();

  constructor(logger?: Logger, maxConnections = 0, maxConnectionsPerIp = 0) {
    this.logger = logger;
    this.maxConnections = maxConnections;
    this.maxConnectionsPerIp = maxConnectionsPerIp;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  roomSize(room: string): number {
    assertRoomName(room);
    return this.rooms.get(room)?.size ?? 0;
  }

  getConnectionCountForIp(ip: string): number {
    return this.connectionsPerIp.get(ip) ?? 0;
  }

  /** Atomically reserves a connection slot for the given IP. Returns a release function. */
  reserveConnection(ip: string, maxConnectionsPerIp: number): () => void {
    if (maxConnectionsPerIp <= 0) return () => {};
    const ipCount = this.connectionsPerIp.get(ip) ?? 0;
    if (ipCount >= maxConnectionsPerIp) {
      throw new MuboError("WS_CONNECTION_LIMIT_PER_IP", "Too many connections from this IP");
    }
    this.connectionsPerIp.set(ip, ipCount + 1);
    return () => {
      const current = this.connectionsPerIp.get(ip) ?? 0;
      if (current <= 1) this.connectionsPerIp.delete(ip);
      else this.connectionsPerIp.set(ip, current - 1);
    };
  }

  add(
    ws: ServerWebSocket<WsSocketData>,
    app: App,
    logger: Logger,
    ip: string,
    reserved = false,
  ): MuboWsContext<App> {
    const existing = this.clientsBySocket.get(ws);
    if (existing) return existing.ctx;

    const id = crypto.randomUUID();
    let client!: Client<App>;
    let roomView!: ReadonlySet<string>;
    const state = Object.assign(Object.create(null) as Record<string, unknown>, ws.data.state);
    const context: MuboWsContext<App> = {
      id,
      ws,
      ip,
      url: ws.data.url,
      requestId: ws.data.requestId,
      user: ws.data.user,
      state,
      get rooms() {
        return roomView;
      },
      log: logger,
      app,
      send: (data) => sendDirect(ws, data, this.logger),
      emit: (event, data, messageId) =>
        sendDirect(ws, { t: "event", e: event, d: data, id: messageId }, this.logger),
      publish: (room, data) => this.publishToRoom(room, data),
      broadcast: (data, options) => this.broadcastToAll(data, options),
      subscribe: (room) => this.subscribeToRoom(context, room),
      unsubscribe: (room) => this.unsubscribeFromRoom(context, room),
      close: (code, reason) => ws.close(code, reason),
    };
    client = { ctx: context, ws, rooms: new Set() };
    roomView = createReadonlySetView(client.rooms);
    this.clients.set(id, client);
    this.clientsBySocket.set(ws, client);

    if (!reserved && this.maxConnectionsPerIp > 0) {
      const ipCount = this.connectionsPerIp.get(ip) ?? 0;
      this.connectionsPerIp.set(ip, ipCount + 1);
    }
    return context;
  }

  getContext(ws: ServerWebSocket<WsSocketData>): MuboWsContext<App> | undefined {
    return this.clientsBySocket.get(ws)?.ctx;
  }

  remove(ws: ServerWebSocket<WsSocketData>): MuboWsContext<App> | undefined {
    const client = this.clientsBySocket.get(ws);
    if (!client) return undefined;
    for (const room of [...client.rooms]) this.unsubscribeFromRoom(client.ctx, room);
    this.clients.delete(client.ctx.id);
    this.clientsBySocket.delete(ws);
    if (this.maxConnectionsPerIp > 0) {
      const ip = client.ctx.ip;
      const ipCount = this.connectionsPerIp.get(ip) ?? 0;
      if (ipCount <= 1) this.connectionsPerIp.delete(ip);
      else this.connectionsPerIp.set(ip, ipCount - 1);
    }
    return client.ctx;
  }

  subscribe(ctx: MuboWsContext<App> | string, room: string): void {
    const context = typeof ctx === "string" ? this.clients.get(ctx as string)?.ctx : ctx;
    if (!context) return;
    this.subscribeToRoom(context, room);
  }

  unsubscribe(ctx: MuboWsContext<App> | string, room: string): void {
    const context = typeof ctx === "string" ? this.clients.get(ctx as string)?.ctx : ctx;
    if (!context) return;
    this.unsubscribeFromRoom(context, room);
  }

  private subscribeToRoom(ctx: MuboWsContext<App>, room: string): void {
    assertRoomName(room);
    const client = this.clients.get(ctx.id);
    if (!client) return;
    if (client.rooms.has(room)) return;
    client.rooms.add(room);
    let members = this.rooms.get(room);
    if (!members) {
      members = new Set();
      this.rooms.set(room, members);
    }
    members.add(client);
  }

  private unsubscribeFromRoom(ctx: MuboWsContext<App>, room: string): void {
    assertRoomName(room);
    const client = this.clients.get(ctx.id);
    if (!client) return;
    client.rooms.delete(room);
    const members = this.rooms.get(room);
    if (!members) return;
    members.delete(client);
    if (members.size === 0) this.rooms.delete(room);
  }

  publish(room: string, data: unknown, options: { except?: string } = {}): number {
    assertRoomName(room);
    return this.publishToRoom(room, data, options);
  }

  private publishToRoom(room: string, data: unknown, options: { except?: string } = {}): number {
    assertRoomName(room);
    const members = this.rooms.get(room);
    if (!members) return 0;
    let sent = 0;
    for (const client of members) {
      if (options.except && client.ctx.id === options.except) continue;
      if (safeSend(client.ws, data, this.logger)) sent++;
    }
    return sent;
  }

  broadcast(data: unknown, options: { except?: string } = {}): number {
    return this.broadcastToAll(data, options);
  }

  private broadcastToAll(data: unknown, options: { except?: string } = {}): number {
    let sent = 0;
    for (const client of this.clients.values()) {
      if (options.except && client.ctx.id === options.except) continue;
      if (safeSend(client.ws, data, this.logger)) sent++;
    }
    return sent;
  }

  pingAll(): void {
    for (const client of this.clients.values()) {
      try {
        client.ws.ping();
      } catch {
      }
    }
  }

  closeAll(code = 1001, reason = "Server shutting down"): void {
    for (const client of this.clients.values()) {
      try {
        client.ws.close(code, reason);
      } catch {
      }
    }
  }
}