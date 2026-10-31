# Mubo

边缘计算级的“全栈单体”框架（The “Hyper-Monolith” Framework）

**一切只依赖 Bun 的内置能力**：内置 SQLite（Bun.Sqlite）关系数据库（带自动迁移）、高性能 WebSocket（Bun.serve）、静态资源处理与内嵌发布。最终可将**前端 + 后端 + 数据库初始化逻辑**打包成**单个二进制文件**，实现极低成本私有化部署：用户下载一个文件，双击运行，就是一个完整的 CRM / ERP / 内部工具。

---

## 为什么是 “Hyper‑Monolith”

当你只是想做一个小工具或私有化系统，常见方案往往需要：

- Docker / Compose
- Postgres / MySQL
- Redis
- S3 / 对象存储
- 反向代理、证书、配置管理……

Mubo 的目标是：**把这些“基础设施成本”压到接近 0**，让一个应用像“下载一个可执行文件”那样交付与部署。

---

## 特性

### 1) 内置数据库：Bun.Sqlite + 自动迁移
- 内置 SQLite（无额外服务）
- 启动时自动应用迁移（默认只追加：建表、加列、加索引）
- 破坏性变更通过手写迁移完成，自动迁移不会删除或改写已有列
- 迁移历史可追踪，重复启动幂等

### 2) 内置高性能服务：Bun.serve
- HTTP API
- 静态资源服务（支持 ETag / Cache-Control）
- WebSocket 通讯（适合实时看板、协同、通知）

### 3) 资源内嵌与单文件发布
- 前端构建产物可内嵌到二进制中
- 后端逻辑与迁移脚本内嵌
- 运行时自动选择数据目录，生成/打开本地数据库文件

### 4) 面向私有化部署的默认值
- 开箱即用的配置系统（环境变量/配置文件）
- 日志、健康检查、优雅退出
- 可选：内置用户/会话/权限骨架（适合 CRM/ERP）

---

## 非目标（Non‑Goals）

- 不追求取代 Kubernetes / 大规模微服务体系
- 不追求替代成熟 ORM 的全部能力（优先可靠、可控、可迁移）
- 不强制绑定某个前端框架（React/Vue/Svelte/纯静态均可）

---

## 快速开始

> 说明：以下命令已由仓库内 CLI 实现；可直接参考 `examples/minimal` 的完整示例。

### 安装（开发者）
```bash
curl -fsSL https://bun.sh/install | bash
bun --version
```

### 初始化项目
```bash
bunx mubo init my-app
cd my-app
bun install
```

### 开发运行
```bash
bun run dev
# 默认监听 http://localhost:3000
```

### 构建单文件二进制
```bash
bun run build
# 产物在 ./dist/my-app（或 ./dist/my-app.exe）
```

### 运行发布产物
```bash
./dist/my-app
# 指定数据目录（数据库会自动创建并迁移）
./dist/my-app --data-dir /var/lib/my-app
# 或 Windows 双击运行
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
CLI 参数优先级最高；缺失的开关值或非法日志级别会直接报错，而不是静默忽略。

---

## 项目结构（建议）

```txt
my-app/
  src/
    server/
      index.ts            # 启动入口：创建 app、加载配置、启动 HTTP/WS、连接 DB、跑迁移
      routes/             # HTTP 路由
      ws/                 # WebSocket 事件/房间/广播
      db/
        schema.ts         # 声明式 schema（表、字段、索引、约束）
        migrations.ts     # 迁移策略/生成/执行（由框架运行）
        queries/          # 预编译 SQL / 仓储层
    client/
      ...                 # 任意前端（可选）
  public/                 # 静态资源（可选，开发时直出；构建时内嵌）
  mubo.config.ts          # 可选：框架配置
  package.json
```

---

## 核心概念

### App
Mubo 应用的生命周期容器，负责：
- 读取配置
- 初始化数据库与迁移
- 注册 HTTP 路由与中间件
- 注册 WebSocket 事件处理
- 挂载静态资源
- 提供健康检查与关闭钩子

### Database（SQLite）
- 由 Mubo 管理连接与 WAL / busy_timeout 等参数
- 提供迁移与版本管理
- 提供轻量的数据访问层（推荐“SQL 优先”）

### Router / Middleware
- 基于 Bun 的 `fetch(req)` 模型实现路由与中间件栈
- 内置 JSON body 解析、错误处理、请求日志、CORS（可选）

### WebSocket
- 基于 Bun 原生 WebSocket
- 提供：
  - 连接鉴权
  - 房间（rooms）/ 主题（topics）
  - 广播（broadcast）
  - 心跳与断线处理

### Static Assets
- 开发时：直接从 `public/` 输出；需要代理前端 dev server 时可自行接入中间件
- 生产时：将 `dist/client`（或配置路径）内嵌到二进制中并由 Bun.serve 输出
- 支持目录索引（`/docs` 与 `/docs/` 都会尝试 `docs/index.html`）
- 支持 SPA fallback（例如 `/app/*` 返回 `index.html`）
- HTML 默认 `no-cache`；带内容哈希的静态资源默认一年 immutable；支持 `ETag` / `If-None-Match` / `304` 与 HEAD

---

## API 参考

### App

```ts
const app = await createMuboApp(config, { cwd, argv, env });
app.get("/path", handler);
app.post("/path", handler);
app.put("/path", handler);
app.patch("/path", handler);
app.delete("/path", handler);
app.head("/path", handler);
app.use(async (ctx, next) => {
  const response = await next();
  response.headers.set("x-demo", "1");
  return response;
});
app.ws("/ws", { authorize, onConnect, onMessage, onClose, onError });
app.static({ mode: "embedded", spaFallback: true });
await app.start();
await app.stop();
```

未传入显式配置时，`createMuboApp` 会加载当前目录的 `mubo.config.*`；传入任意显式配置项时默认不加载文件，也可用 `{ loadFile: true }` 强制加载。CLI 生成的入口会直接导入并传入配置，因此单文件二进制不依赖运行目录中的配置文件。

### HTTP Context

`ctx.req`、`ctx.url`、`ctx.method`、`ctx.params`、`ctx.query`、`ctx.requestId`、`ctx.state`、`ctx.db`、`ctx.log`、`ctx.set/get`、`ctx.body()`、`ctx.text()`、`ctx.formData()`（别名 `ctx.form()`）、`ctx.json()`、`ctx.ok()`、`ctx.fail()`。

请求体只会被读取一次并由上下文缓存；如果业务代码已经直接消费了 `ctx.req` 的流，再调用 `ctx.body()` / `ctx.text()` 会返回明确的 `BAD_REQUEST`，而不是底层流错误。

未捕获的 `MuboError` 会转换为统一 JSON：`{ error: { code, message }, requestId }`，响应头同时包含 `x-request-id`。

### Database

```ts
app.db.exec("CREATE TABLE ...; CREATE INDEX ...;");
app.db.query("SELECT * FROM users WHERE id = ?").get(id);
app.db.query("SELECT * FROM users").all();
app.db.query("INSERT INTO users (name) VALUES (?)").run("Ada");
app.db.query("SELECT id FROM users").values();
app.db.transaction((db) => {
  db.query("INSERT INTO users (name) VALUES (?)").run("Ada");
});
app.db.migrate(schema, { mode: "check" });
```

事务回调为同步时直接返回结果，为异步时返回 Promise；嵌套事务使用 SAVEPOINT。迁移默认只允许建表、加列和加索引，破坏性变更需手写迁移。查询会复用缓存的 prepared statement；迁移 SQL 执行失败会回滚并抛出带语句上下文的 `MIGRATION_ERROR`。

### WebSocket Context

`ctx.id`、`ctx.ip`、`ctx.url`、`ctx.user`、`ctx.state`、`ctx.rooms`、`ctx.send()`、`ctx.emit()`、`ctx.publish()`、`ctx.subscribe()`、`ctx.unsubscribe()`、`ctx.close()`。`emit()` 使用 `{ t: "event", e, d, id? }` 协议。

启用 `http.trustProxy` 后，HTTP 日志与 WebSocket 的 `ctx.ip` 会优先使用 `x-forwarded-for`（首个地址）或 `x-real-ip`；默认关闭以避免伪造来源。

---

## 示例：HTTP 路由（示意）

```ts
// src/server/routes/health.ts
export function registerHealthRoutes(app: any) {
  app.get("/healthz", () => Response.json({ ok: true }));
}
```

```ts
// src/server/index.ts
import { createMuboApp } from "mubo";
import { registerHealthRoutes } from "./routes/health";

const app = await createMuboApp({
  http: { port: 3000 },
  db: { path: "data/mubo.sqlite" },
  static: { dir: "public", spaFallback: true },
});

registerHealthRoutes(app);

await app.start();
```

> 详细设计见 `PLAN.md`；可运行示例见 `examples/minimal`。

---

## 示例：WebSocket（示意）

```ts
// src/server/ws/index.ts
export function registerWs(app: any) {
  app.ws("/ws", {
    onConnect(ctx: any) {
      // ctx.send / ctx.subscribe / ctx.user
    },
    onMessage(ctx: any, msg: any) {
      // 广播、房间、事件分发
    },
  });
}
```

---

## 数据库与迁移

Mubo 的迁移目标是让“私有化单文件应用”具备：
- **启动即升级**（用户不需要手动运行 migrate 命令）
- **可追踪**（默认表 `_mubo_migrations`，记录迁移 ID、校验和与执行时间）
- **尽量安全**（默认只做追加式变更：建表/加列/加索引；破坏性变更需显式开启）

建议：
- 将 schema 视为“产品的一部分”，随代码版本演进
- 避免在客户端手工改库；如需支持外部报表读取，提供只读副本或导出

---

## 配置

配置优先级：
1. CLI 参数（`--port`、`--host`、`--data-dir`、`--db`、`--static-dir` 等）
2. 环境变量（`MUBO_*`）
3. `mubo.config.ts` / `mubo.config.js`
4. 默认值

配置文件可用 `--config <file>` 指定；传入任意显式配置项时默认不读取文件。

常见环境变量：

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

数值型配置（端口、body limit、超时、心跳、缓存时间等）会在启动前校验；非法值会以 `CONFIG_ERROR` 失败。

---

## 部署

### 单机私有化
- 将编译出的单文件复制到目标机器
- 双击或以 service 方式运行
- 数据默认写入用户目录或应用目录（`--data-dir` / `MUBO_DATA_DIR` 可配置）
- 首次启动自动创建数据库并执行迁移，升级时替换二进制即可

### 边缘环境
- 适合部署到具备文件系统的边缘节点
- 可在弱网络下独立运行，后续再进行同步（同步机制可选扩展）

---

## 安全建议（最低限度）
- 生产默认绑定 `127.0.0.1`，由反向代理对外暴露（可配置）
- WebSocket 建议启用鉴权（token / session）
- 对外 API 建议启用速率限制（可选中间件）

---

## 兼容性与限制
- 依赖 Bun 运行时（开发/编译）
- SQLite 适合中小规模业务与边缘场景；极端并发写入场景需评估

---

## 贡献（Contributing）
- 讨论与设计请先开 Issue
- 新功能请带测试
- 保持“默认简单、可选强大”的原则：宁可少做，也不引入外部依赖链

---

## License
MIT（建议；以仓库实际为准）
