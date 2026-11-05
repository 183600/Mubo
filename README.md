# Mubo

A "hyper-monolith" framework built on Bun's native capabilities.

Mubo depends only on Bun's built-in features: HTTP/WebSocket (`Bun.serve`), SQLite (`bun:sqlite`), static assets and single-file compilation. It bundles frontend assets, backend logic and database migrations into a single executable, suitable for private internal tools, CRM/ERP, edge nodes and small SaaS applications.

> Design details and implementation constraints: [PLAN.md](./PLAN.md) | Working example: [`examples/minimal`](./examples/minimal)

## Table of Contents

- [Why Hyper-Monolith?](#why-hyper-monolith)
- [Core Capabilities](#core-capabilities)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Basic Usage](#basic-usage)
- [Observability](#observability)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Security & Limitations](#security--limitations)
- [Development & Testing](#development--testing)
- [License](#license)

## Why Hyper-Monolith?

A small internal application typically requires significant infrastructure:

- Docker or Docker Compose
- PostgreSQL or MySQL
- Redis
- Object storage (S3)
- Reverse proxy, certificates, configuration management

Mubo reduces this "infrastructure cost" to near zero: applications ship as a single executable, databases are created automatically on first start, and upgrades are just binary replacements.

It's not trying to replace Kubernetes, large microservice architectures or full-featured ORMs. Mubo prioritizes **reliability, controllability, portability**, while allowing frontend frameworks like React, Vue, Svelte or plain static pages.

## Core Capabilities

| Capability | Description |
| --- | --- |
| HTTP Service | Routing, middleware, JSON/form parsing, unified error responses |
| SQLite | WAL mode, busy timeout, prepared statement caching, transactions |
| Auto Migrations | Append-only migrations from declarative schema |
| WebSocket | Connection handling, rooms, broadcasting, heartbeats |
| Static Assets | Disk or embedded, ETag, caching, directory index, SPA fallback |
| Single-File Builds | Frontend, backend entry and migrations in one executable |
| Observability | Structured logging, request IDs, slow query hints, `/healthz` and `/readyz` |

## Quick Start

### Requirements

- Bun >= 1.2
- macOS, Linux, or Windows

```bash
curl -fsSL https://bun.sh/install | bash
bun --version
```

### Create a Project

```bash
bunx mubo init my-app
cd my-app
bun install
bun run dev
# Default: http://localhost:3000
```

When developing inside this repo:

```bash
bun run src/cli/index.ts init /tmp/my-app
```

`mubo init` generates `package.json`, `tsconfig.json`, `mubo.config.ts`, example schema, routes, WebSocket handlers and a minimal test. Use `--force` to overwrite non-empty directories, `--install` to run `npm install` after creation.

### Run the Example

```bash
cd examples/minimal
bun install
bun run dev
```

The example provides:

- `GET /api/notes` and `POST /api/notes`
- WebSocket `/ws` with `ping`, `echo` and room broadcasting
- Static homepage and `notes` table migrations

### Build and Run Single-File

```bash
bun run build
# Output: ./dist/<app-name> (Windows: .exe)

./dist/my-app
# With custom data directory:
./dist/my-app --data-dir /var/lib/my-app
```

### Diagnostics and Migrations

```bash
bunx mubo doctor          # Check Bun/platform/config/data-dir/SQLite/port/schema/static
bunx mubo doctor --json   # Machine-readable diagnostics
bunx mubo migrate --check # Check for pending migrations
bunx mubo migrate         # Apply migrations (auto-applied on startup)
```

### CLI Reference

```bash
mubo init <dir> [--force] [--install]
mubo dev [--entry <file>] [--port <port>] [--host <host>] [--data-dir <dir>]
         [--db <path>] [--static-dir <dir>] [--log-level <level>] [--config <file>]
         [--request-timeout <ms>] [--no-static] [--no-ws]
mubo build [--entry <file>] [--outfile <file>] [--static-dir <dir>] [--target <target>]
           [--minify] [--config <file>]
mubo migrate [--check] [--config <file>] [--data-dir <dir>]
mubo doctor [--json] [--config <file>]
mubo --version
```

CLI flags have highest priority. Missing flag values, invalid booleans or invalid log levels throw errors rather than silently ignoring. `--static-dir` affects the embedded static assets in the build output. `mubo dev` forwards the runtime flags (`--port`, `--host`, `--data-dir`, `--db`, `--static-dir`, `--log-level`, `--request-timeout`, `--config`, `--no-static`, `--no-ws`) to the server it starts.

## Project Structure

```txt
my-app/
  src/
    server/
      index.ts            # Entry: create app, register routes/WS, start
      schema.ts           # Declarative schema
      routes/             # HTTP routes (optional)
      ws/                 # WebSocket events/rooms/broadcasts (optional)
      db/queries/         # SQL queries and repository layer (optional)
  client/                 # Frontend (optional)
  public/                 # Static assets (served in dev, embedded in build)
  mubo.config.ts          # Optional framework configuration
  package.json
```

## Basic Usage

### Creating an Application

```ts
import { createMuboApp, defineSchema } from "mubo";

const schema = defineSchema({
  tables: {
    notes: {
      columns: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        title: { type: "text", notNull: true },
        created_at: { type: "integer", notNull: true },
      },
      indexes: [{ name: "idx_notes_created_at", columns: ["created_at"] }],
    },
  },
});

const app = await createMuboApp({
  app: { name: "notes", env: "production" },
  http: { host: "127.0.0.1", port: 3000 },
  db: { migrations: { mode: "apply", safeOnly: true } },
  static: { mode: "embedded", dir: "public", spaFallback: true },
  schema,
});

app.get("/healthz", () => Response.json({ ok: true }));

await app.start();
```

`app.start()` is idempotent while the app is running: concurrent calls share a single server. `app.stop()` stops the HTTP server, closes WebSocket connections and the database. A stopped application cannot be restarted; create a new one instead.

When `createMuboApp` receives no explicit config, it loads the local `mubo.config.*`; any explicit config disables file loading (use `{ loadFile: true }` to force it). Explicit `--config <file>` always loads that file, overriding inline config. Environment variables and other CLI flags still take precedence over everything. CLI-generated entry files import config directly, so single-file binaries don't depend on runtime config files.

`mubo build` additionally bakes the project configuration into the binary. A compiled application therefore starts with the settings it was built with and never reads `mubo.config.*` from its working directory; environment variables and CLI flags still override the baked values at runtime.

### Routes and Middleware

```ts
app.get("/api/notes/:id", (ctx) =>
  ctx.json({ id: ctx.params.id, query: Object.fromEntries(ctx.query) }),
);

app.post("/api/notes", async (ctx) => {
  const body = await ctx.body<{ title?: string }>();
  if (!body?.title?.trim()) {
    return ctx.fail("VALIDATION_ERROR", "title is required", 422);
  }
  const result = ctx.db
    .query("INSERT INTO notes (title, created_at) VALUES (?, ?)")
    .run(body.title.trim(), Date.now());
  return ctx.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
});

app.use(async (ctx, next) => {
  const response = await next();
  response.headers.set("x-demo", "1");
  return response;
});
```

Routes support static paths (`/healthz`), parameter paths (`:id`), and trailing wildcards (`*`). `HEAD` requests automatically fall back to matching `GET` routes.

Route paths, middleware functions and WebSocket handlers are validated when they are registered. Invalid registrations throw `CONFIG_ERROR` immediately instead of failing on the first request.

### Request Context

Properties: `ctx.req`, `ctx.url`, `ctx.method`, `ctx.params`, `ctx.query`, `ctx.requestId`, `ctx.ip`, `ctx.state`, `ctx.db`, `ctx.log`, `ctx.app`, `ctx.set/get`, `ctx.body()`, `ctx.text()`, `ctx.formData()` (alias `ctx.form()`), `ctx.json()`, `ctx.textResponse()`, `ctx.ok()`, `ctx.fail()`.

`ctx.app` is the running application instance, so handlers can reach framework services such as `ctx.app.wsHub` or `ctx.app.config` without capturing the app in a closure.

Request body is read only once and cached. If business code consumes the stream directly before calling `ctx.body()` / `ctx.text()`, those methods return a clear `BAD_REQUEST` error. Unhandled `MuboError` exceptions produce JSON:

```json
{
  "error": { "code": "VALIDATION_ERROR", "message": "..." },
  "requestId": "..."
}
```

Response includes `x-request-id` header.

### HTTP Options

```ts
const app = await createMuboApp({
  http: {
    trustProxy: true,                 // honour x-forwarded-for / x-real-ip
    bodyLimit: 1024 * 1024,           // max request body bytes
    requestTimeoutMs: 5_000,          // 0 disables the timeout
    cors: { origin: ["https://app.test"], credentials: true, maxAgeSeconds: 600 },
    rateLimit: { maxRequests: 120, windowMs: 60_000 },
  },
});
```

- `requestTimeoutMs` aborts slow handlers with `504` and `REQUEST_TIMEOUT`.
- `rateLimit` buckets requests per client IP; pass `key: (request) => string` to use another bucket key. Responses carry `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`; exceeding the limit returns `429` and `RATE_LIMITED`.
- `cors` accepts `"*"` or a list of origins. `credentials` cannot be combined with `"*"`; pre-flight requests are answered with `204`. When an `OPTIONS` route is registered for the path it handles the request instead, and the pre-flight headers are added to its response.
- `ctx.ip` exposes the resolved client address and honours `trustProxy`.

### Database

```ts
app.db.exec("CREATE TABLE ...; CREATE INDEX ...;");

app.db.query("SELECT * FROM users WHERE id = ?").get(id);
app.db.query("SELECT * FROM users").all();
app.db.query("SELECT id FROM users").values();
app.db.query("INSERT INTO users (name) VALUES (?)").run("Ada");

app.db.transaction((db) => {
  db.query("INSERT INTO users (name) VALUES (?)").run("Ada");
});
```

Transaction callbacks are sync when given sync functions, return `Promise` for async. Nested transactions use `SAVEPOINT`. Queries use cached prepared statements; migration failures roll back and throw `MIGRATION_ERROR`.

SQLite failures are reported as `MuboError` with the code `DB_ERROR`; the failing statement is attached to `error.details.sql` and the original SQLite error is kept as `error.cause`. Using a database that was already closed throws `DB_CLOSED` (`503`).

`app.db.migrate(schema, options)` applies the declarative schema using the app's configured `db.migrations` settings (history table, mode, `safeOnly` and lock strategy), so manual migrations record history in the same table as startup migrations. Explicit `options` override the configuration.

### Declarative Schema

`defineSchema` describes the tables and indexes of the application. The schema is applied as append-only migrations when the app starts.

```ts
const schema = defineSchema({
  tables: {
    users: {
      columns: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        email: { type: "text", notNull: true, unique: true },
        name: { type: "text", default: "anon" },
        org_id: { type: "integer", references: { table: "orgs", column: "id", onDelete: "CASCADE" } },
        created_at: { type: "text", sqlDefault: "CURRENT_TIMESTAMP" },
      },
      indexes: [
        { name: "idx_users_name", columns: ["name"] },
        { name: "idx_users_open", columns: ["email"], unique: true, where: "active = 1" },
      ],
    },
  },
});
```

Column options are `type` (`text`, `integer`, `real`, `blob`, `numeric`, `boolean`), `primaryKey`, `autoIncrement`, `notNull`, `unique`, `default`, `sqlDefault` and `references` (`table`, `column`, `onDelete`, `onUpdate`). Index options are `name`, `columns`, `unique` and `where`.

`default` takes a JavaScript value and is stored as a literal, `sqlDefault` is raw SQL. Use `sqlDefault: "CURRENT_TIMESTAMP"` for the SQLite timestamp function; `default: "CURRENT_TIMESTAMP"` stores the text `CURRENT_TIMESTAMP`.

Automatic migrations are append-only: dropping columns or tables, changing column types, primary keys, foreign keys, `UNIQUE` constraints, defaults or nullability is rejected with `MIGRATION_ERROR`. Apply such a change by hand before `app.start()` - the automatic migration then sees the updated structure and stays a no-op:

```ts
const app = await createMuboApp(config);
app.db.exec("ALTER TABLE users DROP COLUMN nickname"); // manual migration
await app.start();
```

With `db.migrations.lock: "file"`, migrations are serialized through a lock file next to the database. Locks left behind by crashed processes are detected and reclaimed automatically; locks held by a live process are respected.

Database tuning options: `db.wal` (WAL mode, default `true`), `db.foreignKeys` (default `true`), `db.busyTimeoutMs` (default `5000`) and `db.slowQueryMs` (default `200`, logs a warning for slower queries).

### WebSocket

```ts
app.ws("/ws", {
  authorize(request) {
    const token = new URL(request.url).searchParams.get("token");
    return token ? { token } : null; // Reject connection with null/false
  },
  onConnect(ctx) {
    ctx.subscribe("lobby");
    ctx.emit("welcome", { connectionId: ctx.id });
  },
  onMessage(ctx, message) {
    ctx.publish("lobby", { type: "message", data: String(message) });
  },
  onClose(ctx, code, reason) {
    ctx.log.debug("socket closed", { id: ctx.id, code, reason });
  },
});
```

WebSocket context: `ctx.id`, `ctx.ip`, `ctx.url`, `ctx.user`, `ctx.state`, `ctx.rooms`, `ctx.app`, `ctx.send()`, `ctx.emit()`, `ctx.publish()`, `ctx.broadcast()`, `ctx.subscribe()`, `ctx.unsubscribe()`, `ctx.close()`. The `emit()` protocol uses `{ t: "event", e, d, id? }`.

WebSocket routes are matched by their exact path, so parameter and wildcard paths are rejected with `CONFIG_ERROR` when they are registered.

Room names must contain non-whitespace. Duplicate subscriptions are idempotent. `ctx.rooms` is a read-only live view of the current subscriptions; use `ctx.subscribe()` / `ctx.unsubscribe()` to change them. `publish()` / `broadcast()` return successful connection count. Failed sends are logged but not counted.

With `http.trustProxy`, HTTP logs and WebSocket `ctx.ip` prefer `x-forwarded-for` (first address) or `x-real-ip`.

### Static Assets

```ts
app.static({
  mode: "embedded",        // "embedded" | "disk" | "off"
  dir: "public",
  spaFallback: true,
  cache: { immutableExtensions: ["js", "css", "woff2"] },
});
```

- Use `disk` mode for development or when proxying an external dev server
- Use `embedded` mode to bundle frontend builds into the binary
- `/docs` and `/docs/` attempt `docs/index.html`
- HTML defaults to `no-cache`; content-hashed assets default to 1-year `immutable`
- Supports `ETag` / `If-None-Match` / `304` and `HEAD`
- Supports single byte ranges (`Range: bytes=0-1023`) with `206` / `Content-Range`
- Unsatisfiable ranges answer `416` with `Content-Range: bytes */<size>`; malformed ranges are ignored and serve the full body
- Hash detection based on filename tokens like `app.3f9a1c2d.js`
- Invalid options (unknown mode, negative cache time, malformed asset payload) fail fast with `CONFIG_ERROR`

### Observability

Every log entry carries the application name, the environment and, for request scoped logs, the request ID. `log.level` selects the minimum severity (`debug`, `info`, `warn`, `error`) and `log.json` switches between human-readable and JSON output; JSON output is enabled by default in production.

JSON entries always describe the entry itself with `time`, `level` and `message`. A user field that uses one of those names is preserved under a prefixed key (`field_level`, `field_message`, `field_time`) instead of overwriting the envelope. Newlines in messages and field values are escaped, and circular references and bigint values are serialized safely.

Requests are logged with method, path, status, duration and client IP. Queries slower than `db.slowQueryMs` produce a warning that includes the statement text. `GET /healthz` reports the application name and uptime, `GET /readyz` verifies the database, the migration state and the data directory and answers `503` when any of them is unavailable.

## Configuration

Priority order (highest to lowest):

1. CLI arguments (`--port`, `--host`, `--data-dir`, `--db`, `--static-dir`, etc.)
2. Environment variables (`MUBO_*`)
3. `mubo.config.ts` / `mubo.config.js` / `mubo.config.mjs`
4. Default values

Specify config file with `--config <file>`. Common environment variables:

| Variable | Description | Default |
| --- | --- | --- |
| `MUBO_APP_NAME` | Application name (sanitized) | `mubo-app` |
| `MUBO_ENV` | Environment (`development` / `production` / `test`) | `development` |
| `MUBO_HOST` | HTTP listen address | `127.0.0.1` |
| `MUBO_PORT` | HTTP listen port | `3000` |
| `MUBO_TRUST_PROXY` | Honour `x-forwarded-for` / `x-real-ip` | `false` |
| `MUBO_BODY_LIMIT` | Max request body bytes | `1048576` |
| `MUBO_REQUEST_TIMEOUT_MS` | Request timeout in milliseconds (`0` disables) | `0` |
| `MUBO_DATA_DIR` | Data directory for DB, logs | `$HOME/.mubo/<appName>` |
| `MUBO_DB_PATH` | SQLite file path | `<dataDir>/mubo.sqlite` |
| `MUBO_BUSY_TIMEOUT_MS` | SQLite busy timeout | `5000` |
| `MUBO_WAL` | Enable SQLite WAL mode | `true` |
| `MUBO_FOREIGN_KEYS` | Enforce foreign keys | `true` |
| `MUBO_SLOW_QUERY_MS` | Slow query warning threshold | `200` |
| `MUBO_MIGRATIONS_MODE` | `apply` / `check` / `off` | `apply` |
| `MUBO_MIGRATIONS_SAFE_ONLY` | Only append-only migrations | `true` |
| `MUBO_MIGRATIONS_TABLE` | Migration history table | `_mubo_migrations` |
| `MUBO_MIGRATIONS_LOCK` | `file` / `sqlite` migration locking | `sqlite` |
| `MUBO_STATIC_MODE` | `embedded` / `disk` / `off` | `disk` |
| `MUBO_STATIC_DIR` | Static assets directory | `public` |
| `MUBO_STATIC_SPA_FALLBACK` | Return `index.html` on 404 | `true` |
| `MUBO_WS_ENABLED` | Enable WebSocket | `true` |
| `MUBO_WS_MAX_PAYLOAD` | Max WebSocket message bytes | `1048576` |
| `MUBO_WS_MAX_CONNECTIONS` | Max concurrent WebSocket connections | `0` (unlimited) |
| `MUBO_WS_MAX_CONNECTIONS_PER_IP` | Max WebSocket connections per IP | `0` (unlimited) |
| `MUBO_WS_HEARTBEAT_INTERVAL_MS` | WebSocket ping interval (`0` disables pings) | `30000` |
| `MUBO_WS_HEARTBEAT_TIMEOUT_MS` | WebSocket idle timeout, must be greater than the interval | `60000` |
| `MUBO_LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `MUBO_LOG_JSON` | JSON structured logging | `true` in production |

Default data directory:

- macOS/Linux: `$HOME/.mubo/<appName>/`
- Windows: `%APPDATA%\Mubo\<appName>\`

Numeric configs (port, body limits, timeouts, caches) are validated at startup. Invalid values fail with `CONFIG_ERROR`. Timeouts must be non-negative integers, and WebSocket heartbeat timeout must be greater than interval. App names are sanitized and truncated to 64 characters. Empty `MUBO_ENV` triggers validation error; invalid `NODE_ENV` is ignored and falls back to `development`.

### Configuration File Example

```ts
// mubo.config.ts
import { defineConfig } from "mubo";

export default defineConfig({
  app: { name: "my-app", env: "production" },
  http: { host: "0.0.0.0", port: 3000, trustProxy: true },
  db: { path: "./data/app.sqlite", busyTimeoutMs: 10000 },
  static: { mode: "embedded", dir: "dist/client", spaFallback: true },
  ws: { enabled: true, maxPayloadBytes: 2 * 1024 * 1024 },
  log: { level: "info", json: true },
});
```

## Deployment

### Private Single-Node

- Copy the compiled single-file to the target machine
- Run directly or register as a system service
- Data defaults to user directory, configurable via `--data-dir` / `MUBO_DATA_DIR`
- Databases and migrations auto-create on first run; upgrades are binary swaps

### Edge Environments

- Suitable for file-system equipped edge nodes
- Runs independently on weak networks; can sync to larger systems when available

### Systemd Service Example

```ini
# /etc/systemd/system/my-app.service
[Unit]
Description=My Mubo Application
After=network.target

[Service]
Type=simple
User=appuser
WorkingDirectory=/opt/my-app
ExecStart=/opt/my-app/my-app --data-dir /var/lib/my-app
Restart=on-failure
RestartSec=5
Environment=MUBO_ENV=production

[Install]
WantedBy=multi-user.target
```

## Security & Limitations

- Production binds to `127.0.0.1` by default; use reverse proxy for external access
- WebSocket connections should enable authorization (token/session)
- Consider rate limiting on public APIs
- SQLite suits medium-scale workloads; evaluate for extreme concurrent writes
- Requires Bun runtime for development and building

## Development & Testing

```bash
bun install
bun run check     # tsc --noEmit + bun test
bun test
```

New features require corresponding tests. Maintain the "simple by default, powerful when needed" principle: prefer fewer dependencies over extensive chains.

## License

MIT. See [LICENSE](./LICENSE).