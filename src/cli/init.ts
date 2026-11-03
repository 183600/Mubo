import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { MuboError } from "../core/errors.ts";

const MUBO_VERSION = "0.1.0";

export interface InitOptions {
  cwd: string;
  force?: boolean;
  install?: boolean;
}

function packageName(value: string): string {
  const name = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return name || "mubo-app";
}

async function resolveMuboDependency(cwd: string): Promise<string> {
  const muboPkg = resolve(cwd, "package.json");
  try {
    const pkg = JSON.parse(await Bun.file(muboPkg).text());
    if (pkg.name === "mubo") return "file:.";
  } catch {}
  const frameworkRoot = resolve(import.meta.dir, "..", "..");
  try {
    const pkg = JSON.parse(await Bun.file(join(frameworkRoot, "package.json")).text());
    if (pkg.name === "mubo") return `file:${relative(cwd, frameworkRoot)}`;
  } catch {}
  return `^${MUBO_VERSION}`;
}

async function write(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

function clientHtml(appName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${appName}</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { max-width: 760px; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.6; }
      code { background: color-mix(in srgb, currentColor 12%, transparent); padding: .15rem .35rem; border-radius: .3rem; }
      #status { font-weight: 600; }
    </style>
  </head>
  <body>
    <h1>${appName}</h1>
    <p>Mubo is running. <span id="status">connecting…</span></p>
    <p>API: <a href="/api/hello/world"><code>GET /api/hello/world</code></a> · Health: <a href="/healthz"><code>/healthz</code></a></p>
    <ul id="messages"></ul>
    <script>
      const status = document.getElementById("status");
      const messages = document.getElementById("messages");
      fetch("/healthz").then((r) => r.json()).then(() => { status.textContent = "healthy"; }).catch(() => { status.textContent = "offline"; });
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(protocol + "//" + location.host + "/ws");
      socket.addEventListener("message", (event) => {
        const item = document.createElement("li");
        item.textContent = event.data;
        messages.append(item);
      });
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "ping", data: Date.now() })));
    </script>
  </body>
</html>
`;
}

export async function initProject(target: string, options: InitOptions): Promise<string> {
  const dir = resolve(options.cwd, target);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) {
      throw new MuboError("CONFIG_ERROR", `Target exists and is not a directory: ${dir}`);
    }
    const entries = readdirSync(dir);
    if (entries.length > 0 && !options.force) {
      throw new MuboError("CONFIG_ERROR", `Directory is not empty: ${dir} (use --force to overwrite)`);
    }
  }
  mkdirSync(join(dir, "src", "server"), { recursive: true });
  mkdirSync(join(dir, "public"), { recursive: true });

  const name = packageName(basename(dir));
  const muboDep = await resolveMuboDependency(dir);
  await write(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          dev: "mubo dev",
          start: "bun run src/server/index.ts",
          build: "mubo build",
          migrate: "mubo migrate",
          doctor: "mubo doctor",
          typecheck: "tsc --noEmit",
          test: "bun test",
        },
        dependencies: { mubo: muboDep },
        devDependencies: { "@types/bun": "^1.4.4", typescript: "^7.0.2" },
      },
      null,
      2,
    )}\n`,
  );
  await write(
    join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          moduleDetection: "force",
          lib: ["ESNext"],
          types: ["bun"],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          allowImportingTsExtensions: true,
        },
        include: ["src/**/*.ts", "mubo.config.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await write(
    join(dir, "mubo.config.ts"),
    `import { defineConfig } from "mubo";
import { schema } from "./src/server/schema";

export default defineConfig({
  app: { name: ${JSON.stringify(name)} },
  http: {
    host: process.env.MUBO_HOST?.trim() || "127.0.0.1",
    port: Number(process.env.MUBO_PORT?.trim() || 3000),
  },
  db: {
    migrations: { mode: "apply", safeOnly: true },
  },
  static: {
    mode: "embedded",
    dir: "public",
    spaFallback: true,
  },
  ws: {
    enabled: true,
    heartbeat: { intervalMs: 30000, timeoutMs: 60000 },
  },
  schema,
});
`,
  );
  await write(
    join(dir, "src", "server", "schema.ts"),
    `import { defineSchema } from "mubo";

export const schema = defineSchema({
  tables: {
    users: {
      columns: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        email: { type: "text", notNull: true, unique: true },
        name: { type: "text", notNull: true },
        created_at: { type: "integer", notNull: true },
      },
      indexes: [{ name: "idx_users_created_at", columns: ["created_at"] }],
    },
  },
});
`,
  );
  await write(
    join(dir, "src", "server", "schema.test.ts"),
    `import { expect, test } from "bun:test";
import { schema } from "./schema";

test("defines the users table", () => {
  expect(schema.tables.users).toBeDefined();
});
`,
  );
  await write(
    join(dir, "src", "server", "index.ts"),
    `import { createMuboApp } from "mubo";
import config from "../../mubo.config.ts";

const app = await createMuboApp(config);

app.get("/api/hello/:name", (ctx) =>
  ctx.json({
    message: \`Hello, \${ctx.params.name}!\`,
    requestId: ctx.requestId,
  }),
);

app.get("/api/users", async (ctx) =>
  ctx.json({
    users: await ctx.db.transaction(async (db) => {
      return ctx.db.query("SELECT id, email, name, created_at FROM users ORDER BY id").all();
    }),
  }),
);

app.ws("/ws", {
  onConnect(ctx) {
    ctx.subscribe("lobby");
    ctx.send({ type: "welcome", connectionId: ctx.id });
    ctx.publish("lobby", { type: "presence", connections: app.wsHub.roomSize("lobby") });
  },
  onMessage(ctx, message) {
    let event: { type?: string; data?: unknown } = {};
    try {
      event = JSON.parse(String(message));
    } catch {
      ctx.send({ type: "error", message: "Messages must be JSON" });
      return;
    }
    if (event.type === "join" && typeof event.data === "string") {
      ctx.subscribe(event.data);
      ctx.send({ type: "joined", room: event.data });
      return;
    }
    if (event.type === "ping") {
      ctx.send({ type: "pong", data: event.data });
      return;
    }
    app.wsHub.publish("lobby", { type: event.type ?? "message", data: event.data });
  },
  onClose(ctx) {
    app.wsHub.publish("lobby", { type: "presence", connections: app.wsHub.roomSize("lobby") });
    ctx.log.debug("socket closed", { id: ctx.id });
  },
});

const shutdown = async () => {
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.start();
`,
  );
  await write(join(dir, "public", "index.html"), clientHtml(name));
  await write(
    join(dir, ".gitignore"),
    "node_modules/\ndist/\n.mubo/\n*.sqlite\n*.sqlite-wal\n*.sqlite-shm\n.env\n.env.*\ntmp/\n",
  );

  if (options.install) {
    const proc = Bun.spawn(["bun", "install"], { cwd: dir, stdout: "inherit", stderr: "inherit" });
    if ((await proc.exited) !== 0) {
      throw new MuboError("CONFIG_ERROR", "bun install failed");
    }
  }
  return dir;
}