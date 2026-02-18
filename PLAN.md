# Mubo 实现方案（完整计划）

> 目标：实现一个完全基于 Bun 内置能力的“全栈单体”框架：集成 SQLite（自动迁移）、HTTP + WebSocket、静态资源处理，并支持将应用编译为单一二进制文件交付。  
> 约束：不引入 Docker/外部数据库/Redis/S3 作为“必需组件”。允许可选插件，但核心必须零依赖外部服务。  
> 注意：本计划不包含“编译器实现代码”。只描述框架与应用侧的实现与集成方式。

---

## 1. 总体目标与范围

### 1.1 交付物
- `mubo` 框架包（TypeScript/JavaScript）
- `bunx mubo` CLI（脚手架/构建/诊断）
- 示例应用（最小：HTTP + SQLite + 静态 + WebSocket）
- 文档：README、配置说明、API 参考、迁移说明、部署指南

### 1.2 核心能力（MVP 必须有）
1. **HTTP 服务**
   - 基于 `Bun.serve`，提供路由与中间件
   - JSON body 解析、错误处理、请求日志
   - 健康检查端点（默认 `/healthz`）

2. **SQLite 数据库与自动迁移**
   - 基于 `bun:sqlite`（`Bun.Sqlite`）
   - 启动时自动执行迁移（可关闭/只检查）
   - 迁移历史记录与并发保护

3. **WebSocket**
   - 基于 `Bun.serve` 原生 WS
   - 提供消息分发、房间订阅、广播工具
   - 支持鉴权钩子与连接上下文

4. **静态资源处理**
   - 开发：可直接服务 `public/` 或代理前端 dev server（可选）
   - 生产：从内嵌资源（或磁盘）输出，支持缓存头与 SPA fallback

5. **单文件交付模式**
   - 支持将服务端代码与静态资源打包进一个可执行文件
   - 运行时自动创建数据目录与数据库文件
   - 支持 `--data-dir` / 环境变量配置数据位置

---

## 2. 设计原则

1. **Bun-first**：只使用 Bun 内置能力（SQLite、serve、WebSocket、文件 API、测试框架）。
2. **SQL 优先**：避免“魔法 ORM”。提供轻量封装、类型辅助与安全的参数绑定。
3. **默认安全**：默认绑定 localhost、默认只做追加式迁移、默认合理缓存策略。
4. **可观测性内建**：结构化日志、请求 ID、慢查询提示、基础指标（可选）。
5. **可插拔但不复杂**：核心保持小而稳，扩展通过插件接口接入。

---

## 3. 架构概览

### 3.1 运行时模块划分
- `core/`：App 生命周期、配置、日志、错误处理、工具
- `http/`：路由、middleware、请求解析、响应辅助
- `ws/`：WS 路由、连接上下文、房间与广播
- `db/`：SQLite 连接、迁移、查询执行与事务封装
- `static/`：静态资源加载器（磁盘/内嵌）、缓存与 SPA fallback
- `cli/`：init/dev/build/migrate/doctor（只调度，不耦合运行时）
- `plugins/`：插件协议（可选）

### 3.2 数据与控制流（启动流程）
1. 读取配置（env + config file + defaults）
2. 初始化日志（log level、格式、requestId）
3. 解析数据目录（data dir）
4. 初始化 SQLite（连接参数、WAL、busy_timeout）
5. 获取迁移锁并执行迁移
6. 注册路由（HTTP + WS）
7. 初始化静态资源服务
8. `Bun.serve` 启动
9. 捕获信号并优雅退出（关闭连接、释放锁）

---

## 4. 配置系统

### 4.1 配置来源与优先级
1. CLI 参数（优先级最高）
2. 环境变量（`MUBO_*`）
3. `mubo.config.ts` / `mubo.config.js`
4. 默认值

### 4.2 配置结构（建议）
```ts
export interface MuboConfig {
  app?: {
    name?: string;
    env?: "development" | "production" | "test";
  };

  http?: {
    host?: string;      // 默认 127.0.0.1
    port?: number;      // 默认 3000
    trustProxy?: boolean;
    cors?: false | { origin: string[] | "*" };
    bodyLimit?: number; // JSON body 最大字节数
  };

  db?: {
    path?: string;      // 默认: <dataDir>/mubo.sqlite
    wal?: boolean;      // 默认 true
    busyTimeoutMs?: number; // 默认 5000
    foreignKeys?: boolean;  // 默认 true
    migrations?: {
      mode?: "apply" | "check" | "off";
      safeOnly?: boolean; // 默认 true：仅追加式变更
      table?: string;     // 默认 "_mubo_migrations"
      lock?: "file" | "sqlite"; // 默认 sqlite
    };
  };

  static?: {
    mode?: "embedded" | "disk" | "off";
    dir?: string;            // disk 模式目录
    spaFallback?: boolean;   // 默认 true
    cache?: {
      immutableExtensions?: string[];
      defaultMaxAgeSeconds?: number;
    };
  };

  ws?: {
    enabled?: boolean;
    maxPayloadBytes?: number;
    heartbeat?: { intervalMs: number; timeoutMs: number };
  };

  log?: {
    level?: "debug" | "info" | "warn" | "error";
    json?: boolean;
  };
}
```

### 4.3 数据目录策略
- 优先使用 `--data-dir` / `MUBO_DATA_DIR`
- 默认选择：
  - macOS/Linux：`$HOME/.mubo/<appName>/`
  - Windows：`%APPDATA%\\Mubo\\<appName>\\`
- 数据目录包含：
  - `mubo.sqlite`
  - `logs/`（可选）
  - `tmp/`（可选）

---

## 5. HTTP 层设计

### 5.1 路由器
基于 `Bun.serve({ fetch(req) {} })` 实现轻量路由：

- `app.get(path, handler)`
- `app.post(path, handler)`
- `app.put/patch/delete(...)`
- 路径匹配：
  - 静态路径：`/healthz`
  - 参数路径：`/users/:id`
  - 可选通配：`/assets/*`（用于静态与 SPA）

实现要点：
- 预编译路由表，按 method 分组
- 简单高效的 path matcher（避免引入外部依赖）
- `ctx` 上下文对象：
  - `ctx.req`, `ctx.url`, `ctx.params`, `ctx.query`
  - `ctx.json()`, `ctx.text()`, `ctx.form()`（按需）
  - `ctx.db`（SQLite 连接/封装）
  - `ctx.log`（带 requestId）

### 5.2 中间件（middleware）
- `app.use(middleware)`：洋葱模型
- 内置中间件（默认启用）：
  - requestId
  - 结构化访问日志
  - 错误边界（异常转 JSON）
  - JSON body 解析（按 Content-Type）
- 可选中间件：
  - CORS
  - rate limit（内存令牌桶；边缘场景够用）
  - auth（session/token 骨架）

### 5.3 响应辅助
- `Response.json(data, { status, headers })`
- `ctx.ok(data)` / `ctx.fail(code, message)`
- 统一错误格式：
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "..."
  },
  "requestId": "..."
}
```

---

## 6. WebSocket 设计

### 6.1 WS 路由注册
- `app.ws(path, handlers)`
  - `onConnect(ctx)`
  - `onMessage(ctx, message)`
  - `onClose(ctx, code, reason)`
  - `onError(ctx, err)`

### 6.2 连接上下文
- `ctx.id`：连接 ID
- `ctx.ip`：客户端 IP（考虑 proxy）
- `ctx.user`：鉴权后的用户对象（可选）
- `ctx.send(data)`：自动 JSON 序列化（可配置）
- `ctx.subscribe(room)` / `ctx.unsubscribe(room)`
- `ctx.publish(room, data)`

### 6.3 消息协议（建议）
使用事件包结构，便于扩展：
```json
{ "t": "event", "e": "crm.lead.created", "d": { ... }, "id": "optional" }
```

### 6.4 心跳与断线
- 服务端定时 ping（若 Bun 提供可用机制则使用；否则应用层心跳）
- 超时自动断开，释放订阅与资源

### 6.5 鉴权策略（最小实现）
- 允许从以下位置提取 token：
  - `Sec-WebSocket-Protocol`
  - URL query：`?token=...`
  - Cookie（若前置 HTTP 已设置）
- 提供 `authorize(ctx): user | null` 钩子

---

## 7. SQLite 与自动迁移设计（重点）

### 7.1 DB 初始化参数
- `PRAGMA journal_mode=WAL;`（默认）
- `PRAGMA foreign_keys=ON;`（默认）
- `PRAGMA busy_timeout=...;`
- 可选：`synchronous=NORMAL`（权衡性能/安全）

### 7.2 迁移元数据与锁
需要解决：**同一数据目录多进程启动**导致同时迁移。

方案 A（推荐）：SQLite 锁表
- 创建 `_mubo_migration_lock` 表（单行）
- 使用事务 `BEGIN IMMEDIATE` 获取写锁
- 在持锁事务中执行迁移并提交
- 优点：跨平台、无需文件锁 API
- 缺点：需要谨慎处理异常退出（SQLite 会回滚释放锁）

迁移历史表：
- `_mubo_migrations(id TEXT PRIMARY KEY, applied_at INTEGER, checksum TEXT, meta TEXT)`
- 每个迁移一个稳定 ID（例如内容 hash 或自定义名称）

### 7.3 Schema 表达方式（声明式）
提供一个极简 DSL（TypeScript 对象）来描述 schema，避免引入 ORM：

```ts
export const schema = {
  tables: {
    users: {
      columns: {
        id: { type: "text", primaryKey: true },
        email: { type: "text", unique: true, notNull: true },
        created_at: { type: "integer", notNull: true }
      },
      indexes: [{ name: "idx_users_created_at", columns: ["created_at"] }]
    }
  }
} as const;
```

类型系统目标：
- schema 对象尽量可推导（`as const`）
- 查询层可选提供泛型辅助（非必须）

### 7.4 自动迁移策略（安全优先）
Mubo 的“自动迁移”定义为：在应用启动时，框架根据 schema 变化自动生成并应用迁移，默认 **仅追加式变更**：

安全变更（默认允许）：
- `CREATE TABLE`（新表）
- `CREATE INDEX`（新索引）
- `ALTER TABLE ADD COLUMN`（新增列，且必须允许 NULL 或提供默认值）
- 添加不影响已有数据的约束（谨慎；SQLite 支持有限）

不安全变更（默认禁止，需显式开启 `safeOnly=false` 或使用手写迁移）：
- 删除列、改类型
- 重命名列/表（通常需要重建表）
- 改主键/外键策略
- 大规模数据重写

### 7.5 自动迁移实现路径（推荐方案）
实现一个“schema diff → migration plan → apply”的流程：

1. **读取当前数据库结构（introspection）**
   - `sqlite_master` 获取表/索引
   - `PRAGMA table_info(table)` 获取列信息
   - `PRAGMA index_list(table)` + `PRAGMA index_info(index)` 获取索引

2. **与声明式 schema 比对**
   - 表是否存在
   - 列是否存在（类型/默认值/nullable）
   - 索引是否存在

3. **生成变更计划（migration plan）**
   - 生成一组 SQL 语句（按安全顺序）
   - 对每次启动生成 deterministic 的迁移 ID（例如对“计划 JSON”做 hash）
   - 若该 ID 已存在于 `_mubo_migrations`，跳过（幂等）

4. **执行迁移**
   - `BEGIN IMMEDIATE`
   - 逐条执行 SQL
   - 写入 `_mubo_migrations`
   - `COMMIT`

5. **校验**
   - 可选：迁移后再次 introspection，确保结构满足 schema

### 7.6 手写迁移（可选增强）
提供接口允许应用显式提供迁移列表，适用于复杂变更：

```ts
app.db.migrations.define([
  {
    id: "202x_add_orders",
    up(db) { db.exec("CREATE TABLE ..."); },
    down(db) { db.exec("DROP TABLE ..."); }
  }
]);
```

> MVP 可先实现“自动迁移 + 追加式”，手写迁移作为后续增强。

### 7.7 查询执行与事务封装
- 提供 `db.query(sql).all(params)` / `.get(params)` / `.run(params)`
- 自动使用 prepared statements（缓存语句对象）
- 事务封装：
  - `db.transaction(fn)`：内部 `BEGIN`/`COMMIT`/`ROLLBACK`

---

## 8. 静态资源设计

### 8.1 资源来源模式
- `embedded`：资源打包进二进制；运行时通过内置 manifest 读取
- `disk`：从磁盘目录读取（适合开发或不内嵌模式）
- `off`：不提供静态服务（纯 API）

### 8.2 Manifest 与缓存策略
生成一个资源清单（manifest）：
- `path -> { bytes | loaderKey, contentType, etag, size, mtime? }`

缓存建议：
- 对带 hash 的文件（如 `app.8c3f1.js`）：
  - `Cache-Control: public, max-age=31536000, immutable`
- 对 `index.html`：
  - `Cache-Control: no-cache`
- 支持 `If-None-Match` → `304`

### 8.3 Content-Type 推断
- 内置扩展名映射（js/css/html/svg/png/jpg/webp/woff2/json等）
- 允许用户覆盖

### 8.4 SPA fallback
当请求路径不匹配任何静态文件且 `spaFallback=true`：
- 返回 `index.html`
- 适用于前端路由（React Router / Vue Router）

---

## 9. 单文件交付（不涉及编译器实现代码）

### 9.1 目标形态
- 一个可执行文件，包含：
  - 服务端入口
  - 静态资源（可选）
  - 迁移逻辑与 schema
- 数据库存储：
  - 运行时落地到 `dataDir/mubo.sqlite`
  - 首次运行自动创建并迁移到最新版本

### 9.2 资源内嵌策略（框架侧）
- 构建阶段由 CLI 生成 `embedded-manifest.json`（或 TS 模块）并纳入打包
- 运行时静态服务从 manifest 提供字节流或从打包资源读取

### 9.3 可升级性
- 新二进制替换旧二进制
- 启动即执行迁移升级数据库
- 保留备份策略（可选）：
  - 在执行非安全迁移前自动复制 DB 文件

---

## 10. CLI 设计（bunx mubo）

> CLI 只做“项目创建/调度/生成”，运行时能力放在框架包中。

### 10.1 命令清单
- `mubo init <dir>`
  - 生成项目模板（server + 可选 client）
  - 生成 `mubo.config.ts`
  - 生成示例 schema、示例路由、示例 WS

- `mubo dev`
  - 以开发模式启动（watch）
  - 可选：代理前端 dev server（例如读取用户配置 `clientDevProxy`）

- `mubo build`
  - 构建前端（若存在配置）
  - 生成静态资源 manifest（用于 embedded 模式）
  - 调用 Bun 的构建能力输出可执行文件（仅调用/编排，不实现编译器）

- `mubo migrate`
  - 显式执行迁移（用于 CI 或排错）
  - 支持 `--check`：只检查是否需要迁移

- `mubo doctor`
  - 输出环境诊断：Bun 版本、可写目录、端口占用、SQLite 可用性等

### 10.2 模板
提供最小模板与“CRM/ERP 骨架模板（可选）”：
- 最小模板：health + users 表 + ws echo + 静态主页
- 骨架模板（可选）：登录/会话/角色权限/审计日志

---

## 11. 安全与合规（内建最低标准）

### 11.1 默认绑定策略
- 生产环境默认 `127.0.0.1`，提示用户通过反向代理暴露
- 明确文档说明如何绑定 `0.0.0.0`

### 11.2 输入与错误
- 默认 JSON body 限制
- 默认错误不泄露堆栈（生产）
- 统一错误码枚举（便于前端处理）

### 11.3 SQLite 安全建议
- 默认开启外键
- SQL 参数必须绑定（禁止字符串拼接的 helper）
- 迁移默认 safeOnly，避免误删数据

### 11.4 WebSocket 安全
- 限制 `maxPayloadBytes`
- 可选简单 rate limit（每连接/每 IP）
- 鉴权钩子建议默认开启（模板提供）

---

## 12. 可观测性

### 12.1 日志
- `info`：启动信息、端口、数据目录
- `http`：method/path/status/duration/requestId
- `db`：慢查询警告（超过阈值）
- `ws`：连接/断开/异常

支持两种输出：
- 人类可读（开发）
- JSON（生产）

### 12.2 指标（可选）
- `GET /metrics`（Prometheus 文本格式，可选）
- 或最小化：`/healthz` + `/readyz`

---

## 13. 测试策略

### 13.1 单元测试（bun test）
- 路由匹配与中间件顺序
- schema diff 生成的迁移计划
- 静态资源缓存头、ETag、SPA fallback
- WS 事件分发（可模拟）

### 13.2 集成测试
- 启动服务，调用 HTTP API
- 初始化空 DB → 自动迁移 → CRUD
- 升级 schema → 再次启动 → 验证迁移幂等
- 并发启动迁移锁测试（两个进程/两个实例模拟）

---

## 14. 性能策略（边缘友好）

- 路由与静态资源尽量避免额外分配
- prepared statement 缓存
- 静态资源使用 `Response` 流/byte array，尽量减少拷贝
- 默认开启 WAL，提升并发读写体验
- 为慢查询提供提示（explain 可选）

---

## 15. 版本化与兼容性策略

- 框架自身语义化版本（semver）
- 迁移机制必须向后兼容：旧 DB 在新版本可自动升级
- 对 schema DSL 的破坏性变更需要提供迁移工具或兼容层

---

## 16. 里程碑（不含日期）

### Milestone A — MVP（可用最小闭环）
- App 生命周期 + 配置 + 日志
- HTTP 路由 + middleware
- SQLite 初始化 + 自动迁移（追加式）
- 静态资源 disk 模式
- WS 基础 echo 示例
- CLI：init / dev
- 示例项目跑通

### Milestone B — 单文件发布闭环
- 静态资源 embedded 模式 + manifest
- CLI：build（编排构建、生成 manifest）
- 生产缓存策略、ETag、304
- 数据目录默认策略与可配置
- 文档：部署与升级说明

### Milestone C — 可靠性增强
- 迁移锁（sqlite 方案）与并发启动测试
- 迁移 check 模式、诊断命令 doctor
- 慢查询日志
- 优雅退出与资源清理

### Milestone D — 应用骨架能力（可选增强）
- 内置 auth/session（cookie + sqlite）
- RBAC（基础角色权限）
- 审计日志表与事件流（可选）

---

## 17. 风险与应对

1. **“自动迁移”复杂度**  
   - 应对：默认只做追加式变更；复杂变更走手写迁移（后续增强）。

2. **SQLite 并发与锁**  
   - 应对：WAL + busy_timeout；迁移使用 `BEGIN IMMEDIATE`；提供诊断输出。

3. **静态资源内嵌与缓存正确性**  
   - 应对：manifest 驱动、ETag 校验、测试覆盖 304/缓存头。

4. **Windows 路径与权限问题**  
   - 应对：统一 dataDir 解析与目录创建；doctor 命令检测可写性。

---

## 18. 代码组织建议（框架仓库）

```txt
mubo/
  packages/
    mubo/                 # 运行时框架包
      src/
        core/
        http/
        ws/
        db/
        static/
        index.ts
    create-mubo/          # bunx mubo init 模板与逻辑
    mubo-cli/             # bunx mubo 命令实现（调度/生成）
  examples/
    minimal/
  docs/
  LICENSE
  README.md
  PLAN.md
```

---

## 19. 对外 API 草案（便于实现对齐）

### 19.1 createMuboApp
```ts
const app = await createMuboApp(config);
await app.start();
await app.stop();
```

### 19.2 HTTP
```ts
app.use(mw);
app.get(path, handler);
app.post(path, handler);
```

### 19.3 DB
```ts
app.db.exec(sql);
app.db.query(sql).get(params);
app.db.transaction((tx) => { ... });
app.db.migrate(); // 启动时自动调用
```

### 19.4 WS
```ts
app.ws("/ws", { onConnect, onMessage, onClose });
```

### 19.5 Static
```ts
app.static({ mode: "embedded", spaFallback: true });
```

---

## 20. 完成标准（Definition of Done）

- 新建项目：`mubo init` 后可 `dev` 启动并访问 `/healthz`
- SQLite：首次启动自动建表；修改 schema 后重启可自动追加迁移且幂等
- WebSocket：可连接、收发消息、断线释放资源
- 静态资源：生产模式支持缓存头与 ETag；SPA fallback 可用
- 单文件：构建后仅分发一个可执行文件即可运行（DB 自动落地到 dataDir）
- 文档：README + 部署 + 迁移策略说明齐全
- 测试：核心模块单测与至少一条集成测试通过
