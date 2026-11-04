import { createMuboApp } from "mubo";
import config from "../../mubo.config.ts";

const app = await createMuboApp(config);

app.get("/api/notes", (ctx) =>
  ctx.json({
    notes: ctx.db.query("SELECT id, title, body, created_at FROM notes ORDER BY id DESC").all(),
  }),
);

app.post("/api/notes", async (ctx) => {
  const body = await ctx.body<{ title?: unknown; body?: unknown }>();
  if (!body || typeof body.title !== "string" || body.title.trim() === "") {
    return ctx.fail("VALIDATION_ERROR", "title is required", 422);
  }
  const title = body.title.trim();
  const text = typeof body.body === "string" ? body.body : "";
  const result = ctx.db
    .query("INSERT INTO notes (title, body, created_at) VALUES (?, ?, ?)")
    .run(title, text, Date.now());
  const note = ctx.db
    .query("SELECT id, title, body, created_at FROM notes WHERE id = ?")
    .get(Number(result.lastInsertRowid));
  app.wsHub.publish("lobby", { t: "event", e: "note.created", d: note });
  return ctx.json({ note }, { status: 201 });
});

app.ws("/ws", {
  onConnect(ctx) {
    ctx.subscribe("lobby");
    ctx.send({
      t: "event",
      e: "welcome",
      d: { connectionId: ctx.id, connections: app.wsHub.roomSize("lobby") },
    });
  },
  onMessage(ctx, message) {
    let event: { type?: string; data?: unknown } = {};
    try {
      event = JSON.parse(String(message));
    } catch {
      ctx.send({ t: "event", e: "error", d: "Messages must be JSON" });
      return;
    }
    if (event.type === "ping") {
      ctx.send({ t: "event", e: "pong", d: event.data });
    } else if (event.type === "echo") {
      ctx.emit("echo", event.data);
    } else {
      ctx.publish("lobby", { t: "event", e: event.type ?? "message", d: event.data });
    }
  },
  onClose(ctx) {
    ctx.log.debug("socket closed", { id: ctx.id });
  },
});

const shutdown = async () => {
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
await app.start();
