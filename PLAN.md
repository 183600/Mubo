# Mubo 实现方案

> 目标：构建一个只依赖 Bun 内置能力的“全栈单体”框架，集成 HTTP、WebSocket、SQLite 自动迁移、静态资源与单文件编译。
>
> 约束：Docker、外部数据库、Redis、S3 等都不能成为核心运行的必需组件。
>
> 说明：本文描述框架的设计边界、模块职责与实现路径，不包含 Bun 编译器本身的实现。

## 目录

- [1. 范围与交付物](#1-范围与交付物)
- [2. 设计原则](#2-设计原则)
- [3. 仓库结构](#3-仓库结构)
- [4. 运行时架构](#4-运行时架构)
- [5. 配置系统](#5-配置系统)
- [6. HTTP 层](#6-http-层)
- [7. WebSocket](#7-websocket)
- [8. SQLite 与自动迁移](#8-sqlite-与自动迁移)
- [9. 静态资源](#9-静态资源)
- [10. 单文件交付](#10-单文件交付)
- [11. CLI](#11-cli)
- [12. 可观测性](#12-可观测性)
- [13. 安全](#13-安全)
- [14. 测试策略](#14-测试策略)
- [15. 性能策略](#15-性能策略)
- [16. 兼容性与版本化](#16-兼容性与版本化)
- [17. 里程碑](#17-里程碑)
- [18. 风险与应对](#18-风险与应对)
- [19. 对外 API](#19-对外-api)
- [20. 完成标准](#20-完成标准)

## 1. 范围与交付物

### 1.1 交付物

- `mubo` 运行时包（TypeScript）
- `mubo` CLI：`init` / `dev` / `build` / `migrate` / `doctor`
- 最小示例项目（HTTP + SQLite + 静态资源 + WebSocket）
- 文档：README、配置参考、API 说明、迁移策略、部署方式

### 1.2 核心能力

1. **HTTP 服务**
   - 基于 `Bun.serve`
   - 路由、中间件、JSON/表单解析、请求日志与统一错误响应
   - 默认健康检查端点 `/healthz` 与 `/readyz`

2. **SQLite 与自动迁移**
   - 基于 `bun:sqlite`
   - 启动时按 schema 自动执行追加式迁移
   - 迁移历史可追踪、重复启动幂等

3. **WebSocket**
   - 原生 WebSocket 升级与连接上下文
   - 鉴权钩子、房间订阅、广播、心跳与断线清理

4. **静态资源**
   - 开发时直接服务 `public/`
   - 生产时从磁盘或内嵌资源输出
   - 缓存头、ETag、目录索引与 SPA fallback

5. **单文件交付**
   - 服务端入口、迁移逻辑和静态资源一起编译
   - 运行时自动创建数据目录与数据库文件
   - `--data-dir` / `MUBO_DATA_DIR` 可配置数据位置

## 2. 设计原则

1. **Bun-first**：只使用 Bun 内置的 SQLite、`Bun.serve`、WebSocket、文件 API 和测试框架。
2. **SQL 优先**：不实现“魔法 ORM”，提供轻量封装、类型辅助与安全的参数绑定。
3. **默认安全**：默认绑定 localhost、默认只做追加式迁移、默认合理缓存策略。
4. **可观测性内建**：结构化日志、请求 ID、慢查询提示和基础健康检查。
5. **可扩展但不复杂**：核心保持小而稳，复杂能力通过显式配置或中间件接入。

## 3. 仓库结构

```txt
mubo/
  src/
    cli/
      index.ts        # CLI 入口与命令分发
      args.ts         # 参数解析
      init.ts         # 项目模板
      build.ts        # 单文件构建
      commands.ts     # dev/migrate/doctor
      project.ts      # 入口探测等共享项目工具
    core/
      app.ts          # App 生命周期、HTTP/WS 装配
      config.ts       # 配置合并、校验与数据目录解析
      errors.ts       # MuboError 与错误码
      logger.ts       # 结构化日志
    db/
      database.ts     # SQLite 连接、查询、事务与迁移入口
      migrations.ts   # schema 校验、diff、迁移计划与执行
      schema.ts       # 声明式 schema 类型
    http/
      router.ts       # 路由匹配
      context.ts      # 请求上下文与 body 解析
      response.ts     # JSON/文本/HTML/错误响应
    static/
      assets.ts       # 磁盘与内嵌静态资源
    ws/
      hub.ts          # WebSocket 连接、房间与广播
    utils/
      path.ts         # 路径规范化与解码工具
    index.ts          # 公共导出
  examples/
    minimal/
  tests/
  README.md
  PLAN.md
  LICENSE
```

## 4. 运行时架构

### 4.1 模块职责

- `core/`：App 生命周期、配置、日志、错误处理。
- `http/`：路由、中间件、上下文、响应辅助。
- `ws/`：WebSocket 路由、连接上下文、房间与广播。
- `db/`：SQLite 连接、迁移、查询与事务。
- `static/`：磁盘/内嵌资源加载、缓存与 SPA fallback。
- `cli/`：项目创建、开发启动、构建、迁移和诊断，只负责调度。

### 4.2 启动流程

1. 合并配置（默认值、配置文件、环境变量、CLI 参数）。
2. 初始化日志（级别、格式、基础字段）。
3. 解析数据目录与数据库路径。
4. 打开 SQLite，设置 WAL、`busy_timeout`、外键等参数。
5. 根据 schema 规划并执行迁移。
6. 注册 HTTP 路由、中间件和 WebSocket 处理器。
7. 初始化静态资源服务。
8. 启动 `Bun.serve`。
9. 应用注册信号处理并调用 `app.stop()` 优雅退出（关闭连接、停止服务、关闭数据库）。

### 4.3 App 生命周期

- `createMuboApp(config, options)`：加载配置并创建 App、Logger、Database 和 StaticAssets。
- `app.start()`：执行迁移并启动服务；重复调用返回同一个 server。
- `app.stop()`：停止心跳、关闭 WebSocket、停止 server、关闭数据库。
- `app.serverInstance` / `app.port` / `app.started`：运行时状态查询。

## 5. 配置系统

### 5.1 来源与优先级

从高到低：

1. CLI 参数
2. 环境变量（`MUBO_*`）
3. `mubo.config.ts` / `mubo.config.js` / `mubo.config.mjs`
4. 默认值

传入任意显式配置项时默认不读取配置文件；`loadFile: true` 可强制读取。CLI 生成的入口直接导入配置，因此编译后的应用不依赖运行目录中的配置文件。

### 5.2 配置结构

```ts
export interface MuboConfig {
  app?: {
    name?: string;
    env?: "development" | "production" | "test";
  };

  dataDir?: string;
  schema?: MuboSchema;

  http?: {
    host?: string;          // 默认 127.0.0.1
    port?: number;          // 默认 3000
    trustProxy?: boolean;
    cors?: false | {
      origin: string[] | "*";
      credentials?: boolean;
      maxAgeSeconds?: number;
    };
    bodyLimit?: number;
  };

  db?: {
    path?: string;          // 默认 <dataDir>/mubo.sqlite
    wal?: boolean;          // 默认 true
    busyTimeoutMs?: number; // 默认 5000
    foreignKeys?: boolean;  // 默认 true
    slowQueryMs?: number;   // 默认 200
    migrations?: {
      mode?: "apply" | "check" | "off";
      safeOnly?: boolean;   // 默认 true
      table?: string;       // 默认 _mubo_migrations
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
    level?: "debug" | "info" | "warn" | "error";
    json?: boolean;
  };
}
```

### 5.3 校验与规范化

- 布尔、字符串、枚举和数值字段在启动前校验。
- 端口限制在 `0..65535`。
- 超时、缓存时间等非负；WebSocket payload 与心跳超时必须大于 0。
- 应用名清洗并截断到 64 字符。
- 相对路径以工作目录为基准解析。
- 非法配置抛出 `CONFIG_ERROR`，不会静默回退。

### 5.4 数据目录策略

- 优先使用 `--data-dir` / `MUBO_DATA_DIR`。
- 默认：
  - macOS/Linux：`$HOME/.mubo/<appName>/`
  - Windows：`%APPDATA%\Mubo\<appName>\`
- 数据目录通常包含 `mubo.sqlite`；日志等文件可按需扩展。

## 6. HTTP 层

### 6.1 路由

基于 `Bun.serve({ fetch })` 实现轻量路由：

- `app.get/post/put/patch/delete/head/options(path, handler)`
- 静态路径：`/healthz`
- 参数路径：`/users/:id`
- 末尾通配符：`/assets/*`

实现要点：

- 路由路径在注册时编译为 segment，避免每次请求重新解析。
- 匹配时优先更具体的路径：字面量 > 参数 > 通配符。
- 同一 `method + path` 重复注册时覆盖旧处理器。
- 未匹配到 method 但路径存在时返回 `405`，并设置 `Allow`。
- `HEAD` 未显式注册时回退到 `GET`。

### 6.2 中间件

- `app.use(middleware)` 使用洋葱模型。
- 中间件可以读取/修改上下文，并决定是否调用 `next()`。
- `next()` 被重复调用时抛出 `INTERNAL_ERROR`。
- 内置行为：请求 ID、访问日志、错误边界、body 解析、CORS（可选）。

### 6.3 请求上下文

核心字段与方法：

- `ctx.req`、`ctx.url`、`ctx.method`
- `ctx.params`、`ctx.query`、`ctx.requestId`
- `ctx.state`、`ctx.set/get`
- `ctx.db`、`ctx.log`、`ctx.app`
- `ctx.body()`、`ctx.text()`、`ctx.formData()` / `ctx.form()`
- `ctx.json()`、`ctx.textResponse()`、`ctx.ok()`、`ctx.fail()`

请求体按 Content-Type 解析：

- `application/json` / `+json`：JSON
- `application/x-www-form-urlencoded`：对象
- `text/*`：文本
- 其他：字节数组

body 只读取一次并缓存；超过 `bodyLimit` 返回 `PAYLOAD_TOO_LARGE`。

### 6.4 响应与错误

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "..."
  },
  "requestId": "..."
}
```

- `MuboError` 统一转换为 JSON 响应。
- 生产环境隐藏非预期错误的内部信息。
- 响应头包含 `x-request-id`。
- `ctx.ok(data)` 与 `ctx.json(data)` 等价；`ctx.fail` 用于业务错误。

### 6.5 CORS 与代理

- `http.cors` 支持 `"*"` 或白名单数组。
- 启用 credentials 时不能把 `Access-Control-Allow-Origin` 设为 `*`。
- 自动响应预检请求并设置 `Vary: Origin`。
- `http.trustProxy` 开启后，日志与 WebSocket `ctx.ip` 优先使用 `x-forwarded-for` 或 `x-real-ip`。

## 7. WebSocket

### 7.1 路由注册

```ts
app.ws(path, {
  authorize(request, { path }),
  onConnect(ctx),
  onMessage(ctx, message),
  onClose(ctx, code, reason),
  onError(ctx, error),
});
```

- 路径在注册时规范化。
- 非 WebSocket 升级请求返回 `426`，除非同一路径存在普通 HTTP 路由。
- `ws.enabled=false` 时拒绝升级。
- `authorize` 返回 `null` / `false` 时拒绝连接。

### 7.2 连接上下文

- `ctx.id`：连接 ID
- `ctx.ws`：底层 `ServerWebSocket`
- `ctx.ip`、`ctx.url`、`ctx.requestId`
- `ctx.user`：鉴权结果
- `ctx.state`：连接级状态
- `ctx.rooms`：当前订阅房间
- `ctx.send()`、`ctx.emit()`
- `ctx.publish()`、`ctx.broadcast()`
- `ctx.subscribe()`、`ctx.unsubscribe()`
- `ctx.close()`

### 7.3 消息协议

推荐事件包结构，便于扩展：

```json
{ "t": "event", "e": "crm.lead.created", "d": {}, "id": "optional" }
```

`send()` 对字符串、ArrayBuffer、TypedArray、Blob 原样发送；其他值序列化为 JSON。不可序列化的值会抛出 `VALIDATION_ERROR`。

### 7.4 房间与广播

- 房间名必须包含非空白字符。
- 重复订阅是幂等的。
- 连接断开时自动退出所有房间。
- `publish()` / `broadcast()` 返回成功发送的连接数。
- 发送失败的连接会记录日志但不计入返回值。

### 7.5 心跳与断线

- `Bun.serve` 开启 `sendPings`。
- `idleTimeout` 根据 `ws.heartbeat.timeoutMs` 计算，并限制在合理范围内。
- `ws.heartbeat.intervalMs > 0` 时定时向所有连接发送 ping。
- 关闭连接时清理房间与上下文。

## 8. SQLite 与自动迁移

### 8.1 初始化参数

- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`
- `PRAGMA foreign_keys = ON`
- `PRAGMA busy_timeout = ...`

不支持 WAL 的文件系统（或 `:memory:`）会安全回退。

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

列支持：

- `type`
- `primaryKey` / `autoIncrement`
- `notNull` / `unique`
- `default` / `sqlDefault`
- `references`（表、列、`ON DELETE`、`ON UPDATE`）

索引支持：

- `name`、`columns`
- `unique`
- `where`（部分索引）

### 8.3 迁移流程

1. **校验 schema**
   - 表名、列名、索引名必须是合法 SQL 标识符。
   - 索引名在数据库内全局唯一。
   - 主键、自增、外键和默认值必须合法。

2. **读取当前数据库结构**
   - `sqlite_master`：表、索引定义。
   - `PRAGMA table_info`：列信息。
   - `PRAGMA index_list` / `PRAGMA index_info`：索引信息。
   - `PRAGMA foreign_key_list`：外键信息。

3. **生成迁移计划**
   - 新表：`CREATE TABLE`，随后创建索引。
   - 已有表新增列：`ALTER TABLE ADD COLUMN`。
   - 新增索引：`CREATE INDEX`。
   - 迁移 ID 由计划 SQL 的 SHA-256 截断生成。
   - 计划为空时视为无需迁移。

4. **执行迁移**
   - 使用 `BEGIN IMMEDIATE` 获取 SQLite 写锁。
   - 在事务内重新计算计划，避免并发启动时重复执行。
   - 逐条执行 SQL，写入迁移历史。
   - 失败时回滚并抛出带语句上下文的 `MIGRATION_ERROR`。

5. **迁移历史**
   - 默认表：`_mubo_migrations`
   - 字段：`id`、`applied_at`、`checksum`、`meta`
   - 重复启动幂等。

### 8.4 安全迁移规则

默认允许：

- 新建表
- 新增可空列
- 新增带默认值的 `NOT NULL` 列
- 新增索引

默认拒绝：

- 删除列或表
- 修改列类型
- 修改主键、自增策略、外键或 `UNIQUE` 约束
- 修改默认值或可空性
- 已存在索引定义不一致

破坏性变更需要手写 SQL 迁移或重建表，不应依赖自动迁移。

### 8.5 查询与事务

```ts
db.query(sql).all(...params)
db.query(sql).get(...params)
db.query(sql).run(...params)
db.query(sql).values(...params)
db.query(sql).iterate(...params)
db.exec(sql)
db.transaction((tx) => { ... })
```

- prepared statement 按 SQL 文本缓存；`iterate` 使用独立语句。
- `transaction` 同步执行时同步返回，异步执行时返回 Promise。
- 嵌套事务使用 `SAVEPOINT`。
- 并发事务排队执行，避免同一连接上交叉提交。
- 慢查询超过 `slowQueryMs` 时记录警告。

## 9. 静态资源

### 9.1 资源来源

- `embedded`：资源打包进二进制，运行时从内嵌 manifest 读取。
- `disk`：从磁盘目录读取，适合开发或外部挂载。
- `off`：不提供静态服务。

在 `disk` 模式下，如果同时提供了内嵌资源，会优先匹配内嵌资源，再回退到磁盘；内嵌 SPA fallback 不会遮蔽磁盘文件。

### 9.2 路径与安全

- 资源键统一为以 `/` 开头的路径。
- 目录路径补 `index.html`。
- 嵌入资源同时注册原始键与解码后的键。
- 磁盘模式拒绝路径穿越、NUL 字节和非法百分号编码。
- 非法路径返回 `400`，越界路径返回 `403`。

### 9.3 缓存策略

- `index.html` / `*.htm`：`no-cache`
- 带内容哈希的静态资源：`public, max-age=31536000, immutable`
- 其他资源：`public, max-age=<defaultMaxAgeSeconds>`
- 支持 `ETag`、`If-None-Match`、弱 ETag 与 `304`
- `HEAD` 返回响应头但不返回 body

哈希识别基于文件名中的 token，例如 `app.3f9a1c2d.js`。`immutableExtensions` 不区分大小写，并忽略前导点。

### 9.4 SPA fallback

当请求未命中静态文件且 `spaFallback=true` 时，返回 `index.html`。这适用于 React Router、Vue Router 等前端路由。

## 10. 单文件交付

### 10.1 构建产物

```txt
一个可执行文件
├── 服务端入口
├── 静态资源（可选）
└── schema 与迁移逻辑
```

数据库不打包进二进制，而是在运行时写入 `<dataDir>/mubo.sqlite`。

### 10.2 构建流程

1. 查找入口文件。
2. 加载项目配置并解析静态资源目录。
3. 收集静态资源，生成 base64 manifest。
4. 生成 `.mubo/embedded-assets.ts` 与 `.mubo/build-entry.ts`。
5. 调用 `bun build --compile` 输出可执行文件。
6. 根据 target 或平台决定是否追加 `.exe`。

### 10.3 可升级性

- 新二进制替换旧二进制即可升级。
- 启动时自动执行迁移。
- 复杂或破坏性变更应先在备份副本上验证。

## 11. CLI

CLI 只负责项目创建、调度与诊断，运行时能力仍由框架包提供。

### 11.1 命令

- `mubo init <dir> [--force] [--install]`
  - 生成项目模板、配置、示例 schema、路由、WebSocket 和最小测试。

- `mubo dev`
  - 查找入口并以 `bun --watch` 启动。
  - 转发端口、主机、数据目录、数据库、静态目录和日志级别等参数。

- `mubo build`
  - 收集静态资源并生成内嵌 manifest。
  - 调用 Bun 编译单文件。
  - 支持 `--entry`、`--outfile`、`--static-dir`、`--target`、`--minify`、`--config`。

- `mubo migrate`
  - 显式执行迁移。
  - `--check` 只检查是否有待执行迁移。

- `mubo doctor`
  - 检查 Bun 版本、平台、配置文件、数据目录、SQLite、端口和 schema。
  - `--json` 输出机器可读结果。

### 11.2 入口探测

未指定 `--entry` 时，按顺序查找：

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

## 12. 可观测性

### 12.1 日志

- `info`：启动信息、端口、数据目录。
- `http`：method、path、status、duration、requestId、ip。
- `db`：慢查询警告。
- `ws`：连接、断开和异常。

支持两种输出：

- 人类可读（开发）
- JSON（生产）

日志字段中的换行会被转义，避免日志注入。JSON 序列化支持循环引用和 bigint 兜底。

### 12.2 健康检查

- `/healthz`：返回应用名与 uptime。
- `/readyz`：检查数据库可用性，异常时返回 `503`。

## 13. 安全

- 默认绑定 `127.0.0.1`，生产环境建议置于反向代理之后。
- 默认限制请求体大小与 WebSocket 最大 payload。
- 生产环境错误响应不泄露堆栈。
- SQL 参数必须绑定，不提供字符串拼接辅助。
- 迁移默认 `safeOnly`，避免误删数据。
- 静态资源严格校验路径，阻止目录穿越。
- WebSocket 建议使用 `authorize` 钩子并限制消息大小。

## 14. 测试策略

### 14.1 单元测试

- 路由匹配、参数解码、405 与 HEAD 回退。
- 中间件顺序与错误边界。
- 配置合并、环境变量优先级与非法值校验。
- schema 校验、迁移计划与幂等性。
- 事务、嵌套事务与并发排队。
- 静态资源缓存头、ETag、SPA fallback 与路径安全。
- WebSocket 房间、广播、鉴权和错误处理。
- 日志格式与请求上下文。

### 14.2 集成测试

- 启动服务并调用 HTTP API。
- 空数据库启动 → 自动迁移 → CRUD。
- 修改 schema 后重启 → 追加迁移且幂等。
- 多实例并发迁移。
- 单文件构建后运行，并验证静态资源、数据库和参数优先级。

## 15. 性能策略

- 路由在注册时预编译，避免请求期重复解析。
- prepared statement 缓存。
- 静态资源直接返回字节或 `BunFile`，减少拷贝。
- WAL + `busy_timeout` 提升并发读写体验。
- 慢查询提示便于定位性能问题。
- WebSocket 房间使用集合索引，广播只遍历目标连接。

## 16. 兼容性与版本化

- 框架自身使用语义化版本。
- 迁移机制必须向后兼容：旧数据库在新版本启动时可自动升级。
- schema DSL 的破坏性变更需要提供迁移工具或兼容层。
- 配置文件与公共导出变更应尽量保持向后兼容。

## 17. 里程碑

里程碑用于划分能力边界，不绑定具体日期。

### A. 最小可用闭环

- App 生命周期、配置、日志
- HTTP 路由与中间件
- SQLite 初始化与追加式自动迁移
- 静态资源 disk 模式
- WebSocket 基础示例
- CLI：`init` / `dev`
- 示例项目可运行

### B. 单文件发布

- 静态资源 embedded 模式与 manifest
- CLI：`build`
- 生产缓存策略、ETag、304
- 数据目录默认策略与可配置
- 部署与升级文档

### C. 可靠性增强

- 迁移并发保护
- 迁移 check 模式与 `doctor`
- 慢查询日志
- 优雅退出与资源清理

### D. 应用骨架（可选）

- 内置 auth/session（cookie + SQLite）
- 基础 RBAC
- 审计日志与事件流

## 18. 风险与应对

1. **自动迁移复杂度**
   - 默认只做追加式变更。
   - 复杂变更使用手写 SQL 或重建表流程。

2. **SQLite 并发与锁**
   - WAL + `busy_timeout`。
   - 迁移使用 `BEGIN IMMEDIATE`，并在事务内复核计划。
   - `doctor` 提供数据库与目录诊断。

3. **静态资源缓存正确性**
   - manifest 驱动。
   - ETag 与缓存头有测试覆盖。
   - 哈希识别只依赖文件名中的内容哈希 token。

4. **Windows 路径与权限**
   - 统一数据目录解析与目录创建。
   - `doctor` 检查目录可写性。
   - 构建时根据目标平台补充 `.exe`。

## 19. 对外 API

### 19.1 创建应用

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

### 19.3 数据库

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

### 19.5 静态资源

```ts
app.static({ mode: "embedded", spaFallback: true });
```

### 19.6 Schema

```ts
const schema = defineSchema({ tables: { ... } });
```

## 20. 完成标准

- `mubo init` 后可启动并访问 `/healthz`。
- 首次启动自动建表；schema 变更后重启可追加迁移且幂等。
- WebSocket 可连接、收发消息，断线后释放房间资源。
- 静态资源支持缓存头、ETag 与 SPA fallback。
- 构建后仅分发一个可执行文件即可运行，数据库自动落地。
- 核心模块单测与至少一条集成测试通过。
- README、配置说明、迁移策略和部署说明齐全。