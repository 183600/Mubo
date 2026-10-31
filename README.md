# Mubo

边缘计算级的“全栈单体”框架（The “Hyper-Monolith” Framework）。

Mubo 只依赖 Bun 的内置能力：HTTP/WebSocket（`Bun.serve`）、SQLite（`bun:sqlite`）、静态资源与单文件编译。它把前端资源、后端逻辑和数据库迁移收进一个可执行文件，适合私有化部署的内部工具、CRM/ERP、边缘节点和小型 SaaS。

> 设计细节与实现约束见 [PLAN.md](./PLAN.md)；可运行示例见 [`examples/minimal`](./examples/minimal)。

## 目录

- [为什么是 Hyper-Monolith](#为什么是-hyper-monolith)
- [核心能力](#核心能力)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [基础用法](#基础用法)
- [配置](#配置)
- [部署](#部署)
- [安全与限制](#安全与限制)
- [开发与测试](#开发与测试)
- [License](#license)

## 为什么是 Hyper-Monolith

一个普通的小型内部系统，往往要先准备这些基础设施：

- Docker/Compose
- PostgreSQL/MySQL
- Redis
- S3/对象存储
- 反向代理、证书和配置管理

Mubo 的目标是把这些“基础设施成本”尽量压到零：应用以单个可执行文件交付，首次启动自动创建数据库并执行迁移，升级时替换二进制即可。

它不追求取代 Kubernetes、大型微服务体系或完整的 ORM。Mubo 优先保证**可靠、可控、可迁移**，并允许前端使用 React、Vue、Svelte 或纯静态页面。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| HTTP 服务 | 基于 `Bun.serve` 的路由、中间件、JSON/表单解析、统一错误响应 |
| SQLite | 内置数据库连接、WAL、busy timeout、prepared statement 缓存与事务封装 |
| 自动迁移 | 根据声明式 schema 生成追加式迁移；迁移历史可追踪、重复启动幂等 |
| WebSocket | 原生 WebSocket、鉴权钩子、房间订阅、广播、心跳与连接清理 |
| 静态资源 | 磁盘/内嵌资源、ETag、缓存策略、目录索引、SPA fallback |
| 单文件发布 | 前端资源、后端入口与迁移逻辑一起编译为单个可执行文件 |
| 可观测性 | 结构化日志、请求 ID、慢查询提示、`/healthz` 与 `/readyz` |

## 快速开始

### 环境要求

- Bun >= 1.2
- macOS、Linux 或 Windows

```bash
curl -fsSL https://bun.sh/install | bash
bun --version
```

### 创建项目

```bash
bunx mubo init my-app
cd my-app
bun install
bun run dev
# 默认监听 http://localhost:3000
```

在本仓库内开发时，也可以直接运行 CLI：

```bash
bun run src/cli/index.ts init /tmp/my-app
```

`mubo init` 会生成 `package.json`、`tsconfig.json`、`mubo.config.ts`、示例 schema、路由、WebSocket 处理器和一个最小测试。使用 `--force` 覆盖非空目录，使用 `--install` 在创建后立即安装依赖。

### 运行示例项目

```bash
cd examples/minimal
bun install
bun run dev
```

示例提供：

- `GET /api/notes` 与 `POST /api/notes`
- WebSocket `/ws` 的 `ping`、`echo` 与房间广播
- 静态首页与 `notes` 表迁移

### 构建与运行单文件

```bash
bun run build
# 产物默认位于 ./dist/<app-name>（Windows 为 .exe）

./dist/my-app
# 指定数据目录（数据库会自动创建并迁移）
./dist/my-app --data-dir /var/lib/my-app
```

### 诊断与迁移

```bash
bunx mubo doctor          # Bun/SQLite/数据目录/端口检查
bunx mubo doctor --json   # 机器可读的诊断输出
bunx mubo migrate --check # 只检查是否有待执行的迁移
bunx mubo migrate         # 显式执行迁移（应用启动时也会自动执行）
```

### CLI 参数

```bash
mubo init <dir> [--force] [--install]
mubo dev [--entry <file>] [--port <port>] [--host <host>] [--data-dir <dir>]
mubo build [--entry <file>] [--outfile <file>] [--static-dir <dir>] [--target <target>] [--minify] [--config <file>]
mubo migrate [--check] [--config <file>] [--data-dir <dir>]
mubo doctor [--json] [--config <file>]
```

CLI 参数优先级最高。缺失的开关值、非法布尔值或非法日志级别会直接报错，而不是静默忽略。`mubo build` 同样遵循配置优先级：`MUBO_APP_NAME`、`MUBO_STATIC_MODE`、`MUBO_STATIC_DIR` 会影响产物名称和嵌入的静态资源，`--static-dir` 优先级最高。

## 项目结构

```txt
my-app/
  src/
    server/
      index.ts            # 入口：创建 app、注册路由/WS、启动服务
      schema.ts           # 声明式 schema
      routes/             # HTTP 路由（按项目需要拆分）
      ws/                 # WebSocket 事件/房间/广播
      db/queries/         # SQL 查询与仓储层
    client/               # 任意前端（可选）
  public/                 # 静态资源（开发时直出，构建时内嵌）
  mubo.config.ts          # 可选：框架配置
  package.json
```

## 基础用法

### 创建应用

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

`createMuboApp` 未传入显式配置时会加载当前目录的 `mubo.config.*`；传入任意显式配置项时默认不加载文件，也可以用 `{ loadFile: true }` 强制加载。显式传入 `--config <file>` 或 `{ configFile }` 时始终加载该文件，并用它覆盖代码内联配置（环境变量与其余 CLI 参数仍优先）。CLI 生成的入口会直接导入并传入配置，因此单文件二进制不依赖运行目录中的配置文件。

### 路由与中间件

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

路由支持静态路径、参数路径（`/users/:id`）和末尾通配符（`/assets/*`）。`HEAD` 请求会自动回退到匹配的 `GET` 路由。

### 请求上下文

`ctx.req`、`ctx.url`、`ctx.method`、`ctx.params`、`ctx.query`、`ctx.requestId`、`ctx.state`、`ctx.db`、`ctx.log`、`ctx.set/get`、`ctx.body()`、`ctx.text()`、`ctx.formData()`（别名 `ctx.form()`）、`ctx.json()`、`ctx.textResponse()`、`ctx.ok()`、`ctx.fail()`。

请求体只会被读取一次并由上下文缓存。如果业务代码已经直接消费了 `ctx.req` 的流，再调用 `ctx.body()` / `ctx.text()` 会返回明确的 `BAD_REQUEST`，而不是底层流错误。未捕获的 `MuboError` 会转换为统一 JSON：

```json
{
  "error": { "code": "VALIDATION_ERROR", "message": "..." },
  "requestId": "..."
}
```

响应头同时包含 `x-request-id`。

### 数据库

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

事务回调为同步时直接返回结果，为异步时返回 Promise；嵌套事务使用 `SAVEPOINT`。迁移默认只允许建表、加列和加索引，破坏性变更需手写 SQL。查询会复用缓存的 prepared statement；迁移 SQL 执行失败会回滚并抛出带语句上下文的 `MIGRATION_ERROR`。

### WebSocket

```ts
app.ws("/ws", {
  authorize(request) {
    const token = new URL(request.url).searchParams.get("token");
    return token ? { token } : null; // null / false 拒绝连接
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

WebSocket 上下文包含 `ctx.id`、`ctx.ip`、`ctx.url`、`ctx.user`、`ctx.state`、`ctx.rooms`、`ctx.send()`、`ctx.emit()`、`ctx.publish()`、`ctx.broadcast()`、`ctx.subscribe()`、`ctx.unsubscribe()`、`ctx.close()`。`emit()` 使用 `{ t: "event", e, d, id? }` 协议。

房间名必须是至少包含一个非空白字符的字符串；重复订阅同一房间是幂等的。`publish()` / `broadcast()` 返回成功发送的连接数，序列化或发送失败的连接会被记录日志且不计入返回值。启用 `http.trustProxy` 后，HTTP 日志与 WebSocket 的 `ctx.ip` 会优先使用 `x-forwarded-for`（首个地址）或 `x-real-ip`。

### 静态资源

```ts
app.static({
  mode: "embedded",       // "embedded" | "disk" | "off"
  dir: "public",
  spaFallback: true,
  cache: { immutableExtensions: ["js", "css", "woff2"] },
});
```

- 开发时可直接从 `public/` 输出；需要代理前端 dev server 时可自行接入中间件。
- 生产时可将前端构建产物内嵌到二进制中，或继续使用 `disk` 模式。
- `/docs` 与 `/docs/` 都会尝试 `docs/index.html`。
- HTML 默认 `no-cache`；带内容哈希的静态资源默认一年 `immutable`。
- 支持 `ETag` / `If-None-Match` / `304` 与 `HEAD`。
- 哈希识别基于文件名（如 `app.3f9a1c2d.js`），不会因目录名或普通单词误判；`immutableExtensions` 不区分大小写并忽略前导点。

## 配置

配置优先级从高到低：

1. CLI 参数（`--port`、`--host`、`--data-dir`、`--db`、`--static-dir` 等）
2. 环境变量（`MUBO_*`）
3. `mubo.config.ts` / `mubo.config.js` / `mubo.config.mjs`
4. 默认值

配置文件可用 `--config <file>` 指定。常见环境变量：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `MUBO_APP_NAME` | 应用名（会清洗为安全目录名） | `mubo-app` |
| `MUBO_ENV` | 运行环境（`development` / `production` / `test`） | `development` |
| `MUBO_HOST` | 监听地址 | `127.0.0.1` |
| `MUBO_PORT` | 监听端口 | `3000` |
| `MUBO_BODY_LIMIT` | 请求体最大字节数 | `1048576` |
| `MUBO_DATA_DIR` | 数据目录（DB、日志等） | 用户目录下的 `.mubo/<appName>` |
| `MUBO_DB_PATH` | SQLite 文件路径 | `<dataDir>/mubo.sqlite` |
| `MUBO_BUSY_TIMEOUT_MS` | SQLite busy timeout | `5000` |
| `MUBO_MIGRATIONS_MODE` | `apply` / `check` / `off` | `apply` |
| `MUBO_MIGRATIONS_SAFE_ONLY` | 仅允许追加式自动迁移 | `true` |
| `MUBO_MIGRATIONS_TABLE` | 迁移历史表名 | `_mubo_migrations` |
| `MUBO_STATIC_MODE` | `embedded` / `disk` / `off` | `disk` |
| `MUBO_STATIC_DIR` | 静态资源目录 | `public` |
| `MUBO_STATIC_SPA_FALLBACK` | 未命中静态资源时返回 `index.html` | `true` |
| `MUBO_WS_ENABLED` | 启用 WebSocket | `true` |
| `MUBO_WS_MAX_PAYLOAD` | WebSocket 最大消息字节数 | `1048576` |
| `MUBO_LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `MUBO_LOG_JSON` | JSON 结构化日志 | 生产环境为 `true` |

数据目录默认值：

- macOS/Linux：`$HOME/.mubo/<appName>`
- Windows：`%APPDATA%\Mubo\<appName>`

数值型配置（端口、body limit、超时、心跳、缓存时间等）会在启动前校验；非法值会以 `CONFIG_ERROR` 失败。超时类配置必须是非负整数；应用名会清洗并截断到 64 字符；非空的非法 `MUBO_ENV` 会直接报错，而非法 `NODE_ENV` 会被忽略并回退到 `development`。

## 部署

### 单机私有化

- 将编译出的单文件复制到目标机器。
- 双击运行，或注册为系统服务。
- 数据默认写入用户目录或应用目录，可用 `--data-dir` / `MUBO_DATA_DIR` 配置。
- 首次启动自动创建数据库并执行迁移；升级时替换二进制即可。

### 边缘环境

- 适合具备文件系统的边缘节点。
- 可在弱网络下独立运行，后续再按需扩展同步机制。

## 安全与限制

- 生产环境默认绑定 `127.0.0.1`，推荐通过反向代理对外暴露。
- WebSocket 建议启用鉴权（token / session）。
- 对外 API 建议按需加入速率限制。
- SQLite 适合中小规模业务与边缘场景；极端并发写入场景需单独评估。
- 依赖 Bun 运行时（开发与编译）。

## 开发与测试

```bash
bun install
bun run check     # tsc --noEmit + bun test
bun test
```

新增功能请同时补充测试，并保持“默认简单、可选强大”的原则：宁可少做，也不引入外部依赖链。

## License

MIT，详见 [LICENSE](./LICENSE)。
