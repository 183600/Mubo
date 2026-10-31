import { defineConfig } from "mubo";
import { schema } from "./src/server/schema.ts";

export default defineConfig({
  app: { name: "mubo-example-minimal" },
  http: {
    host: process.env.MUBO_HOST ?? "127.0.0.1",
    port: Number(process.env.MUBO_PORT ?? 3000),
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
