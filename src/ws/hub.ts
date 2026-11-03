import type { ServerWebSocket } from "bun";
import { errorMessage, MuboError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";

export type WsPayload = string | ArrayBuffer | ArrayBufferView | Blob | unknown;

export interface WsSocketData {
  routePath: string;
  requestId: string;
  url: string;
  ip: string;
  user: unknown;
  state: Record<string, unknown>;
}

export interface MuboWsContext {
  readonly id: string;
  readonly ws: ServerWebSocket<WsSocketData>;
  readonly ip: string;
  readonly url: string;
  readonly requestId: string;
  readonly user: unknown;
  readonly state: Record<string, unknown>;
  readonly rooms: ReadonlySet<string>;
  readonly log: Logger;
  readonly app: unknown;
  send(data: WsPayload): void;
  emit(event: string, data?: unknown, id?: string): void;
  publish(room: string, data: WsPayload): number;
  broadcast(data: WsPayload, options?: { except?: string }): number;
  subscribe(room: string): void;
  unsubscribe(room: string): void;
  close(code?: number, reason?: string): void;
}

export interface WsHandlers {
  authorize?: (
    request: Request,
    info: { path: string },
  ) => unknown | null | false | Promise<unknown | null | false>;
  onConnect?: (ctx: MuboWsContext) => unknown | Promise<unknown>;
  onMessage?: (ctx: MuboWsContext, message: string | Buffer) => unknown | Promise<unknown>;
  onClose?: (ctx: MuboWsContext, code: number, reason: string) => unknown | Promise<unknown>;
  onError?: (ctx: MuboWsContext, error: unknown) => unknown | Promise<unknown>;
}

interface Client {
  ctx: MuboWsContext;
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

export function serializePayload(data: unknown): string | ArrayBuffer | ArrayBufferView | Blob {
  if (isRawPayload(data)) return data;
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
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
}

function isEmptyPayload(payload: string | ArrayBuffer | ArrayBufferView | Blob): boolean {
  if (typeof payload === "string") return payload.length === 0;
  if (payload instanceof Blob) return payload.size === 0;
  return payload.byteLength === 0;
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

export class WsRoomHub {
  private readonly clients = new Map<string, Client>();
  private readonly clientsBySocket = new Map<ServerWebSocket<WsSocketData>, Client>();
  private readonly rooms = new Map<string, Set<Client>>();
  private readonly logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  roomSize(room: string): number {
    assertRoomName(room);
    return this.rooms.get(room)?.size ?? 0;
  }

  add(ws: ServerWebSocket<WsSocketData>, app: unknown, logger: Logger, ip: string): MuboWsContext {
    const existing = this.clientsBySocket.get(ws);
    if (existing) return existing.ctx;
    const id = crypto.randomUUID();
    let client!: Client;
    const state = Object.assign(Object.create(null) as Record<string, unknown>, ws.data.state);
    const context: MuboWsContext = {
      id,
      ws,
      ip,
      url: ws.data.url,
      requestId: ws.data.requestId,
      user: ws.data.user,
      state,
      get rooms() {
        return client.rooms as ReadonlySet<string>;
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
    this.clients.set(id, client);
    this.clientsBySocket.set(ws, client);
    return context;
  }

  getContext(ws: ServerWebSocket<WsSocketData>): MuboWsContext | undefined {
    return this.clientsBySocket.get(ws)?.ctx;
  }

  remove(ws: ServerWebSocket<WsSocketData>): MuboWsContext | undefined {
    const client = this.clientsBySocket.get(ws);
    if (!client) return undefined;
    for (const room of [...client.rooms]) this.unsubscribeFromRoom(client.ctx, room);
    this.clients.delete(client.ctx.id);
    this.clientsBySocket.delete(ws);
    return client.ctx;
  }

  subscribe(ctx: MuboWsContext | string, room?: string): void {
    const context = typeof ctx === "string" ? this.clients.get(ctx as string)?.ctx : ctx;
    const roomName = typeof ctx === "string" ? room! : room!;
    this.subscribeToRoom(context!, roomName);
  }

  unsubscribe(ctx: MuboWsContext | string, room?: string): void {
    const context = typeof ctx === "string" ? this.clients.get(ctx as string)?.ctx : ctx;
    const roomName = typeof ctx === "string" ? room! : room!;
    this.unsubscribeFromRoom(context!, roomName);
  }

  private subscribeToRoom(ctx: MuboWsContext, room: string): void {
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

  private unsubscribeFromRoom(ctx: MuboWsContext, room: string): void {
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