import type { ServerWebSocket } from "bun";
import { MuboError } from "../core/errors.ts";
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
  publish(room: string, data: WsPayload): void;
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

function safeSend(ws: ServerWebSocket<WsSocketData>, data: unknown, logger?: Logger): void {
  try {
    ws.send(serializePayload(data) as any);
  } catch (error) {
    logger?.warn("WebSocket send failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

export class WsRoomHub {
  private readonly clients = new Map<string, Client>();
  private readonly rooms = new Map<string, Set<Client>>();
  private readonly logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  roomSize(room: string): number {
    return this.rooms.get(room)?.size ?? 0;
  }

  add(ws: ServerWebSocket<WsSocketData>, app: unknown, logger: Logger, ip: string): MuboWsContext {
    const id = crypto.randomUUID();
    let client!: Client;
    const context: MuboWsContext = {
      id,
      ws,
      ip,
      url: ws.data.url,
      requestId: ws.data.requestId,
      user: ws.data.user,
      state: ws.data.state,
      get rooms() {
        return client.rooms as ReadonlySet<string>;
      },
      log: logger,
      app,
      send: (data) => safeSend(ws, data, this.logger),
      emit: (event, data, messageId) => safeSend(ws, { t: "event", e: event, d: data, id: messageId }, this.logger),
      publish: (room, data) => this.publish(room, data),
      subscribe: (room) => this.subscribe(context, room),
      unsubscribe: (room) => this.unsubscribe(context, room),
      close: (code, reason) => ws.close(code, reason),
    };
    client = { ctx: context, ws, rooms: new Set() };
    this.clients.set(id, client);
    return context;
  }

  getContext(ws: ServerWebSocket<WsSocketData>): MuboWsContext | undefined {
    for (const client of this.clients.values()) {
      if (client.ws === ws) return client.ctx;
    }
    return undefined;
  }

  remove(ws: ServerWebSocket<WsSocketData>): MuboWsContext | undefined {
    for (const [id, client] of this.clients) {
      if (client.ws !== ws) continue;
      for (const room of [...client.rooms]) this.unsubscribe(client.ctx, room);
      this.clients.delete(id);
      return client.ctx;
    }
    return undefined;
  }

  subscribe(ctx: MuboWsContext, room: string): void {
    if (!room) throw new MuboError("VALIDATION_ERROR", "Room name cannot be empty");
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

  unsubscribe(ctx: MuboWsContext, room: string): void {
    const client = this.clients.get(ctx.id);
    if (!client) return;
    client.rooms.delete(room);
    const members = this.rooms.get(room);
    if (!members) return;
    members.delete(client);
    if (members.size === 0) this.rooms.delete(room);
  }

  publish(room: string, data: unknown, options: { except?: string } = {}): number {
    const members = this.rooms.get(room);
    if (!members) return 0;
    let sent = 0;
    for (const client of members) {
      if (options.except && client.ctx.id === options.except) continue;
      safeSend(client.ws, data, this.logger);
      sent++;
    }
    return sent;
  }

  broadcast(data: unknown, options: { except?: string } = {}): number {
    let sent = 0;
    for (const client of this.clients.values()) {
      if (options.except && client.ctx.id === options.except) continue;
      safeSend(client.ws, data, this.logger);
      sent++;
    }
    return sent;
  }

  pingAll(): void {
    for (const client of this.clients.values()) {
      try {
        client.ws.ping();
      } catch {
        // The close handler removes dead connections.
      }
    }
  }

  closeAll(code = 1001, reason = "Server shutting down"): void {
    for (const client of this.clients.values()) {
      try {
        client.ws.close(code, reason);
      } catch {
        // Already closed.
      }
    }
  }
}
