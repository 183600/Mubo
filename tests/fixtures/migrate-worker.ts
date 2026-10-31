import { MuboDatabase } from "../../src/db/database.ts";
import { defineSchema } from "../../src/db/schema.ts";

const path = process.argv[2];
if (!path) throw new Error("database path is required");

const db = new MuboDatabase({ path, busyTimeoutMs: 15_000, wal: true });
const result = await db.migrate(
  defineSchema({
    tables: {
      jobs: {
        columns: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          name: { type: "text", notNull: true },
          payload: { type: "text", notNull: true, default: "{}" },
        },
        indexes: [{ name: "idx_jobs_name", columns: ["name"] }],
      },
    },
  }),
);
console.log(JSON.stringify({ status: result.status, id: result.id }));
db.close();
