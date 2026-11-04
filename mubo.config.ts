import { defineConfig } from "mubo";
import { schema } from "./src/server/schema.ts";

export default defineConfig({
  app: { name: "mubo" },
  http: {
    host: "127.0.0.1",
    port: 3000,
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