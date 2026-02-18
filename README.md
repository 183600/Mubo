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
- 启动时自动应用迁移（可配置为只追加、或允许破坏性变更）
- 迁移历史可追踪，可回滚（可选）

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

> 说明：以下命令与脚手架在 `PLAN.md` 中定义；README 展示最终期望用法。

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
# 或 Windows 双击运行
```

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
- 开发时：直接从 `public/` 或前端 dev server 代理
- 生产时：将 `dist/client`（或配置路径）内嵌到二进制中并由 Bun.serve 输出
- 支持 SPA fallback（例如 `/app/*` 返回 `index.html`）

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

> 注：具体 API 以最终实现为准；详细设计见 `PLAN.md`。

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
- **可追踪**（表 `mubo_migrations` 或 `PRAGMA user_version`）
- **尽量安全**（默认只做追加式变更：建表/加列/加索引；破坏性变更需显式开启）

建议：
- 将 schema 视为“产品的一部分”，随代码版本演进
- 避免在客户端手工改库；如需支持外部报表读取，提供只读副本或导出

---

## 配置

配置优先级（建议）：
1. 环境变量
2. `mubo.config.ts`
3. 默认值

常见配置项：
- `MUBO_PORT`：监听端口
- `MUBO_HOST`：监听地址
- `MUBO_DATA_DIR`：数据目录（DB、日志等）
- `MUBO_LOG_LEVEL`：日志级别

---

## 部署

### 单机私有化
- 将编译出的单文件复制到目标机器
- 双击或以 service 方式运行
- 数据默认写入用户目录或应用目录（可配置）

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
