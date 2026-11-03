# Mubo Implementation Plan

> Goal: Build a "hyper-monolith" framework using only Bun built-in capabilities, integrating HTTP, WebSocket, SQLite auto-migration, static assets and single-file builds.
>
> Constraints: Docker, external databases, Redis, S3, etc. cannot be core runtime requirements.
>
> This document describes framework design boundaries, module responsibilities and implementation path. It does not cover the Bun compiler itself.

## Table of Contents

- [1. Scope and Deliverables](#1-scope-and-deliverables)
- [2. Design Principles](#2-design-principles)
- [3. Repository Structure](#3-repository-structure)
- [4. Runtime Architecture](#4-runtime-architecture)
- [5. Configuration System](#5-configuration-system)
- [6. HTTP Layer](#6-http-layer)
- [7. WebSocket](#7-websocket)
- [8. SQLite and Auto-Migration](#8-sqlite-and-auto-migration)
- [9. Static Assets](#9-static-assets)
- [10. Single-File Delivery](#10-single-file-delivery)
- [11. CLI](#11-cli)
- [12. Observability](#12-observability)
- [13. Security](#13-security)
- [14. Test Strategy](#14-test-strategy)
- [15. Performance Strategy](#15-performance-strategy)
- [16. Compatibility and Versioning](#16-compatibility-and-versioning)
- [17. Milestones](#17-milestones)
- [18. Risks and Mitigations](#18-risks-and-mitigations)
- [19. Public API](#19-public-api)
- [20. Completion Criteria](#20-completion-criteria)

## 1. Scope and Deliverables

### 1.1 Deliverables

- `mubo` runtime package (TypeScript)
- `mubo` CLI: `init`, `dev`, `build`, `migrate`, `doctor`
- Minimal example project with HTTP, SQLite, static assets and WebSocket
- Documentation: README, configuration reference, API docs, migration strategy, deployment guide

### 1.2 Core Capabilities

1. **HTTP Service**
   - Based on `Bun.serve`
   - Routing, middleware, JSON/form parsing, request logging, unified error responses
   - Default health check endpoints `/healthz` and `/readyz`

2. **SQLite and Auto-Migration**
   - Based on `bun:sqlite`
   - Append-only migrations from declarative schema
   - Migration history traceable, idempotent on restart

3. **WebSocket**
   - Native WebSocket upgrade and connection context
   - Authorization hooks, room subscription, broadcast, heartbeat, disconnect cleanup

4. **Static Assets**
   - Serve from `public/` in development
   - From disk or embedded resources in production
   - Cache headers, ETag, directory index, SPA fallback

5. **Single-File Delivery**
   - Server entry, migrations and static assets compile into one executable
   - Runtime auto-creates data directory and database file
   - Data location configurable via `--data-dir` or `MUBO_DATA_DIR`

## 2. Design Principles

1. **Bun-first**: Use only Bun's built-in SQLite, `Bun.serve`, WebSocket, file APIs and test framework.
2. **SQL-focused**: No "magic ORM". Provide lightweight wrappers, type helpers and safe parameter binding.
3. **Default-safe**: Default bind to localhost only, default to append-only migrations, default to sensible caching.
4. **Observability built-in**: Structured logging, request IDs, slow query hints, basic health checks.
5. **Extensible but simple**: Core remains small and stable; complex capabilities via explicit configuration or middleware.

## 3. Repository Structure

```txt
mubo/
  src/
    cli/
      index.ts        # CLI entry and command dispatch
      args.ts         # Argument parsing utilities
      init.ts         # Project template generation
      build.ts        # Single-file build
      commands.ts     # dev/migrate/doctor commands
      project.ts      # Entry detection and shared project utilities
    core/
      app.ts          # App lifecycle, HTTP/WS integration
      config.ts       # Configuration merging, validation, data directory
      errors.ts       # MuboError and error codes
      logger.ts       # Structured logging
    db/
      database.ts     # SQLite connection, queries, transactions, migration entry
      migrations.ts   # schema validation, diff, migration planning and execution
      schema.ts       # Declarative schema types and defineSchema helper
    http/
      router.ts       # Route matching
      context.ts      # Request context and body parsing
      response.ts     # JSON/Text/HTML/error response helpers
    static/
      assets.ts       # Disk and embedded static assets
    ws/
      hub.ts          # WebSocket connection, room and broadcast
    utils/
      path.ts         # Path normalization and route compilation utilities
    index.ts          # Public exports
  examples/
    minimal/
  tests/
  README.md
  PLAN.md
  LICENSE
```

## 4. Runtime Architecture

### 4.1 Module Responsibilities

- `core/`: App lifecycle, configuration, logging, error handling
- `http/`: Routing, middleware, context, response helpers
- `ws/`: WebSocket routing, connection context, rooms and broadcast
- `db/`: SQLite connection, migrations, queries and transactions
- `static/`: Disk/embedded resource loading, caching and SPA fallback
- `cli/`: Project creation, development server, build, migrations, diagnostics

### 4.2 Startup Flow

1. Merge configuration (defaults, config file, environment variables, CLI arguments)
2. Initialize logger (level, format, base fields)
3. Parse data directory and database path
4. Open SQLite, set WAL, `busy_timeout`, foreign keys
5. Plan and execute migrations from schema
6. Register HTTP routes, middleware and WebSocket handlers
7. Initialize static asset service
8. Start `Bun.serve`
9. Register signal handlers and call `app.stop()` for graceful shutdown (close connections, stop server, close database)

### 4.3 App Lifecycle

- `createMuboApp(config, options)`: Load configuration, create App, Logger, Database, StaticAssets
- `app.start()`: Execute migrations and start service; duplicate calls return same server
- `app.stop()`: Stop heartbeats, close WebSocket connections, stop server, close database
- `app.serverInstance` and `app.port`: Query server state
- `app.started`: Boolean indicating if server is running

## 5. Configuration System

### 5.1 Sources and Priority

From highest to lowest priority:

1. CLI arguments
2. Environment variables (`MUBO_*`)
3. `mubo.config.ts` / `mubo.config.js` / `mubo.config.mjs`
4. Default values

When explicit config is passed, file loading is disabled by default; use `loadFile: true` to force it. CLI-generated entry files import config directly, so compiled applications don't depend on runtime config files.

### 5.2 Configuration Structure

```ts
export interface MuboConfig {
  app?: {
    name?: string;
    env?: "development" | "production" | "test";
  };

  dataDir?: string;
  schema?: MuboSchema;

  http?: {
    host?: string;          
    port?: number;         
    trustProxy?: boolean;
    cors?: false | {
      origin: string[] | "*";
      credentials?: boolean;
      maxAgeSeconds?: number;
    };
    bodyLimit?: number;
  };

  db?: {
    path?: string;          
    wal?: boolean;          
    busyTimeoutMs?: number; 
    foreignKeys?: boolean;  
    slowQueryMs?: number;   
    migrations?: {
      mode?: "apply" | "check" | "off";
      safeOnly?: boolean;   
      table?: string;       
      lock?: "file" | "sqlite";
    };
  };

  static?: {
    mode?: "embedded" | "disk" | "off";
    dir?: string;
    spaFallback?: boolean;
    assets?: EmbeddedAssets;
    cache?: {
      immutableExtensions?: string[];
      defaultMaxAgeSeconds?: number;
    };
  };

  ws?: {
    enabled?: boolean;
    maxPayloadBytes?: number;
    heartbeat?: { intervalMs?: number; timeoutMs?: number };
  };

  log?: {
    level?: LogLevel;
    json?: boolean;
  };
}
```

### 5.3 Validation and Normalization

- Boolean, string, enum and numeric fields validated at startup
- Ports constrained to `0..65535`
- Timeouts, cache times must be non-negative; WebSocket payload and heartbeat timeouts must be greater than 0
- App name sanitized and truncated to 64 characters
- Relative paths resolved from working directory
- Invalid config throws `CONFIG_ERROR`, never silently falls back

### 5.4 Data Directory Strategy

- Prioritize `--data-dir` or `MUBO_DATA_DIR`
- Default:
  - macOS/Linux: `$HOME/.mubo/<appName>/`
  - Windows: `%APPDATA%\Mubo\<appName>\\`
- Data directory typically contains `mubo.sqlite`; logs may extend to other files

## 6. HTTP Layer

### 6.1 Routing

Built on `Bun.serve({ fetch })`:

- `app.get/post/put/patch/delete/head(options)(path, handler)`
- Static paths: `/healthz`
- Parameter paths: `/users/:id`
- Trailing wildcards: `/assets/*`

Implementation notes:

- Route paths compiled to segments at registration to avoid re-parsing per request
- Matching prioritizes more specific paths: literal > parameter > wildcard
- Duplicate `method + path` registration overwrites old handler
- Unmatched path with allowed methods returns `405` with `Allow` header
- `HEAD` requests fall back to matching `GET` handler

### 6.2 Middleware

- `app.use(middleware)` uses an onion model
- Middleware can read/modify context and decide whether to call `next()`
- Calling `next()` more than once throws `INTERNAL_ERROR`
- Built-ins: request ID, access logging, error boundary, body parsing, CORS (optional)

### 6.3 Request Context

Core fields and methods:

- `ctx.req`, `ctx.url`, `ctx.method`
- `ctx.params`, `ctx.query`, `ctx.requestId`
- `ctx.state`, `ctx.set/get`
- `ctx.db`, `ctx.log`, `ctx.app`
- `ctx.body()`, `ctx.text()`, `ctx.formData()`/`ctx.form()`
- `ctx.json()`, `ctx.textResponse()`, `ctx.ok()`, `ctx.fail()`

Body parsing by Content-Type:

- `application/json` / `+json`: JSON
- `application/x-www-form-urlencoded`: object
- `text/*`: text
- Other: byte array

Body read once and cached; exceeds `bodyLimit` returns `PAYLOAD_TOO_LARGE`.

### 6.4 Responses and Errors

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "..."
  },
  "requestId": "..."
}
```

- `MuboError` converted to JSON response
- Production hides internal error details
- Response header includes `x-request-id`
- `ctx.ok(data)` and `ctx.json(data)` equivalent; `ctx.fail` for business errors

### 6.5 CORS and Proxy

- `http.cors` supports `"*"` or array of origins
- With credentials, origin cannot be `*`
- Pre-flight requests auto-responded with `Vary: Origin`
- `http.trustProxy` enables `x-forwarded-for` and `x-real-ip` for logging and WebSocket `ctx.ip`

## 7. WebSocket

### 7.1 Route Registration

```ts
app.ws(path, { authorize, onConnect, onMessage, onClose, onError });
```

- Path normalized at registration
- Non-WebSocket upgrade returns `426`, unless HTTP route exists at same path
- `ws.enabled=false` rejects upgrades
- `authorize` returning `null` or `false` rejects connection

### 7.2 Connection Context

- `ctx.id`: Connection ID
- `ctx.ws`: Underlying `ServerWebSocket`
- `ctx.ip`, `ctx.url`, `ctx.requestId`
- `ctx.user`: Authorization result
- `ctx.state`: Connection-level state
- `ctx.rooms`: Current subscriptions
- `ctx.send()`, `ctx.emit()`
- `ctx.publish()`, `ctx.broadcast()`
- `ctx.subscribe()`, `ctx.unsubscribe()`
- `ctx.close()`

### 7.3 Message Protocol

Recommended event structure for extensibility:

```json
{ "t": "event", "e": "crm.lead.created", "d": {}, "id": "optional" }
```

`send()` transmits strings, ArrayBuffers, TypedArrays, Blobs directly; other values JSON-serialized. Non-serializable values throw `VALIDATION_ERROR`.

### 7.4 Rooms and Broadcast

- Room names must contain non-whitespace
- Duplicate subscription is idempotent
- Connections automatically leave rooms on disconnect
- `publish()` and `broadcast()` return successful connection count
- Failed send connections are logged but not counted

### 7.5 Heartbeat and Disconnect

- `Bun.serve` enabled with `sendPings`
- `idleTimeout` calculated from `ws.heartbeat.timeoutMs` within bounds
- `ws.heartbeat.intervalMs > 0` triggers periodic ping to all connections
- Clean up rooms and context on disconnect

## 8. SQLite and Auto-Migration

### 8.1 Initialization Parameters

- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`
- `PRAGMA foreign_keys = ON`
- `PRAGMA busy_timeout = ...`

WAL-disabled filesystems or `:memory:` fall back safely.

### 8.2 Schema DSL

```ts
export const schema = defineSchema({
  tables: {
    users: {
      columns: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        email: { type: "text", notNull: true, unique: true },
        created_at: { type: "integer", notNull: true },
      },
      indexes: [{ name: "idx_users_created_at", columns: ["created_at"] }],
    },
  },
});
```

Column support:

- `type`
- `primaryKey` / `autoIncrement`
- `notNull` / `unique`
- `default` / `sqlDefault`
- `references` (table, column, `ON DELETE`, `ON UPDATE`)

Index support:

- `name`, `columns`
- `unique`
- `where` (partial index)

### 8.3 Migration Flow

1. **Validate schema**
   - Table names, column names, index names must be valid SQL identifiers
   - Index names unique within database
   - Primary keys, auto-increment, foreign keys and defaults must be valid

2. **Read current database structure**
   - `sqlite_master`: tables, indexes
   - `PRAGMA table_info`: column info
   - `PRAGMA index_list` / `PRAGMA index_info`: index info
   - `PRAGMA foreign_key_list`: foreign key info

3. **Generate migration plan**
   - New tables: `CREATE TABLE`, followed by index creation
   - New columns: `ALTER TABLE ADD COLUMN`
   - New indexes: `CREATE INDEX`
   - Migration ID from truncated SHA-256 of plan SQL
   - Empty plan means no migration needed

4. **Execute migration**
   - `BEGIN IMMEDIATE` acquires SQLite write lock
   - Recalculate plan in transaction to prevent duplicate on concurrent starts
   - Execute SQL, write migration history
   - Failure rolls back with context-rich `MIGRATION_ERROR`

5. **Migration History**
   - Default table: `_mubo_migrations`
   - Fields: `id`, `applied_at`, `checksum`, `meta`
   - Idempotent on restart

### 8.4 Safe Migration Rules

Allowed by default:

- Create new tables
- Add nullable columns
- Add columns with default values
- Create new indexes

Forbidden by default:

- Drop columns or tables
- Modify column types
- Modify primary keys, auto-increment, foreign keys or `UNIQUE` constraints
- Modify default values or nullability
- Existing index definitions differ

Destructive changes need manual SQL migrations or table rebuild.

### 8.5 Queries and Transactions

```ts
db.query(sql).all(...params)
db.query(sql).get(...params)
db.query(sql).run(...params)
db.query(sql).values(...params)
db.query(sql).iterate(...params)
db.exec(sql)
db.transaction((tx) => { ... })
```

- Prepared statements cached by SQL text; `iterate` uses independent statements
- Sync transaction execution returns immediately; async returns Promise
- Nested transactions use `SAVEPOINT`
- Concurrent transactions execute sequentially to avoid cross-commit
- Queries exceeding `slowQueryMs` log warnings

## 9. Static Assets

### 9.1 Asset Sources

- `embedded`: Resources packaged in binary, read from embedded manifest at runtime
- `disk`: Read from directory, suitable for development or external mounts
- `off`: No static serving

In `disk` mode, if embedded resources exist they match first, then fall back to disk; embedded SPA fallback doesn't shadow disk files.

### 9.2 Paths and Security

- Resource keys normalized to paths starting with `/`
- Directory paths append `index.html`
- Embedded resources registered with both original and decoded keys
- Disk mode rejects path traversal, NUL bytes and invalid percent-encoding
- Invalid paths return `400`, out-of-bounds paths return `403`

### 9.3 Caching Strategy

- `index.html` / `*.htm`: `no-cache`
- Content-hashed static assets: `public, max-age=31536000, immutable`
- Other resources: `public, max-age=<defaultMaxAgeSeconds>`
- Supports `ETag`, `If-None-Match`, weak ETags and `304`
- `HEAD` returns headers but not body

Hash detection based on filename token, e.g., `app.3f9a1c2d.js`. `immutableExtensions` case-insensitive, ignoring leading dots.

### 9.4 SPA Fallback

When request misses static file and `spaFallback=true`, return `index.html`. Works with React Router, Vue Router and other frontend routers.

## 10. Single-File Delivery

### 10.1 Build Output

A single executable containing:

```txt
Server entry
Static assets (optional)
Schema and migration logic
```

Database not bundled; writes to `<dataDir>/mubo.sqlite` at runtime.

### 10.2 Build Flow

1. Find entry file
2. Load project config and parse static assets directory
3. Collect static assets, generate base64 manifest
4. Generate `.mubo/embedded-assets.ts` and `.mubo/build-entry.ts`
5. Execute `bun build --compile` to output executable
6. Append `.exe` based on target or platform

### 10.3 Upgradeability

- Replace binary with new binary for upgrade
- Migrations auto-apply on startup
- Complex or destructive changes verified on backup first

## 11. CLI

CLI handles project creation, execution and diagnostics; runtime capabilities remain in framework.

### 11.1 Commands

- `mubo init <dir> [--force] [--install]`
  - Generate project template, config, schema, routes, WebSocket and minimal test

- `mubo dev`
  - Find entry and run with `bun --watch`
  - Forward port, host, data directory, database, static directory and log level parameters

- `mubo build`
  - Collect static assets and generate embedded manifest
  - Compile single file with Bun
  - Supports `--entry`, `--outfile`, `--static-dir`, `--target`, `--minify`, `--config`

- `mubo migrate`
  - Explicitly apply migrations
  - `--check` only check for pending migrations

- `mubo doctor`
  - Check Bun version, platform, config file, data directory, SQLite, port and schema
  - `--json` output machine-readable

### 11.2 Entry Detection

When no `--entry` specified:

```txt
src/server/index.ts
src/server/index.js
src/index.ts
src/index.js
server.ts
server.js
index.ts
index.js
```

## 12. Observability

### 12.1 Logging

- `info`: startup info, ports, data directory
- `http`: method, path, status, duration, requestId, IP
- `db`: slow query warnings
- `ws`: connection, disconnect, errors

Two output formats:

- Human-readable (development)
- JSON (production)

Newlines in log fields are escaped to prevent log injection. JSON serialization handles circular references and bigint.

### 12.2 Health Checks

- `/healthz`: Returns app name and uptime
- `/readyz`: Checks database availability, returns `503` on failure

## 13. Security

- Binds `127.0.0.1` by default; recommend reverse proxy for external access
- Request body limits and WebSocket max payload enforced by default
- Production error responses don't leak stack traces
- SQL parameters must be bound; no string concatenation helpers
- Migrations default to `safeOnly`, preventing destructive changes
- Static asset paths strictly validated, preventing directory traversal
- WebSocket should use `authorize` hook and limit message size

## 14. Test Strategy

### 14.1 Unit Tests

- Route matching, parameter decoding, 405 and HEAD fallback
- Middleware ordering and error boundaries
- Configuration merging, environment variable precedence and invalid value validation
- Schema validation, migration plans and idempotency
- Transactions, nested transactions, concurrent queueing
- Static asset cache headers, ETag, SPA fallback and path security
- WebSocket rooms, broadcast, authorization and error handling
- Log format and request context

### 14.2 Integration Tests

- Start services and call HTTP API
- Empty database startup → auto-migration → CRUD
- Schema change after restart → append migration, idempotent
- Multi-instance concurrent migration
- Single-file build validation for static assets, database, parameter precedence

## 15. Performance Strategy

- Routes pre-compiled at registration, not per request
- Prepared statement caching
- Static assets returned directly as bytes or `BunFile`, minimizing copies
- WAL + `busy_timeout` improves concurrent read/write experience
- Slow query hints aid performance debugging
- WebSocket rooms use indexed sets, broadcast iterates only target connections

## 16. Compatibility and Versioning

- Framework uses semantic versioning
- Migration mechanism must be backward compatible: old databases upgrade automatically on new version start
- Schema DSL breaking changes require migration tools or compatibility layer
- Config files and public exports maintained backward compatible

## 17. Milestones

Milestones define capability boundaries, not deadlines.

### A. Minimum Viable Loop

- App lifecycle, configuration, logging
- HTTP routing and middleware
- SQLite initialization and append-only auto-migration
- Static assets disk mode
- WebSocket basic example
- CLI: `init` and `dev`
- Example project runs

### B. Single-File Publishing

- Static assets embedded mode and manifest
- CLI: `build`
- Production cache headers, ETag, 304
- Data directory default strategy and configurability
- Deployment and upgrade documentation

### C. Reliability Enhancements

- Migration concurrency protection
- Migration check mode and `doctor`
- Slow query logging
- Graceful shutdown and resource cleanup

### D. Application Skeleton (Optional)

- Built-in auth/session (cookie + SQLite)
- Basic RBAC
- Audit logs and event streams

## 18. Risks and Mitigations

1. **Auto-Migration Complexity**
   - Default to append-only changes only
   - Complex changes use manual SQL or table rebuild

2. **SQLite Concurrency and Locks**
   - WAL + `busy_timeout`
   - Migrations use `BEGIN IMMEDIATE`, re-verify plan in transaction
   - `doctor` provides database and directory diagnostics

3. **Static Asset Cache Correctness**
   - Manifest-driven
   - ETag and cache headers have test coverage
   - Hash detection based on content-hash token in filename

4. **Windows Paths and Permissions**
   - Unified data directory resolution and creation
   - `doctor` checks directory writability
   - Builds append `.exe` for target platform

## 19. Public API

### 19.1 Creating an Application

```ts
const app = await createMuboApp(config, { cwd, env, argv });
await app.start();
await app.stop();
```

### 19.2 HTTP

```ts
app.use(middleware);
app.get(path, handler);
app.post(path, handler);
app.put(path, handler);
app.patch(path, handler);
app.delete(path, handler);
app.head(path, handler);
app.options(path, handler);
```

### 19.3 Database

```ts
app.db.exec(sql);
app.db.query(sql).get(...params);
app.db.query(sql).all(...params);
app.db.query(sql).run(...params);
app.db.transaction((tx) => { ... });
app.db.migrate(schema, options);
```

### 19.4 WebSocket

```ts
app.ws("/ws", { authorize, onConnect, onMessage, onClose, onError });
```

### 19.5 Static Assets

```ts
app.static({ mode: "embedded", spaFallback: true });
```

### 19.6 Schema

```ts
const schema = defineSchema({ tables: { ... } });
```

## 20. Completion Criteria

- `mubo init` followed by start and access to `/healthz`
- First start auto-creates table; schema change restart produces append migration, idempotent
- WebSocket: connect, send/receive messages, disconnect releases room resources
- Static assets: cache headers, ETag, SPA fallback
- Compiled single-file runs; database auto-materializes; only one binary to distribute