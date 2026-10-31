import { defineSchema } from "mubo";

export const schema = defineSchema({
  tables: {
    notes: {
      columns: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        title: { type: "text", notNull: true },
        body: { type: "text", notNull: true, default: "" },
        created_at: { type: "integer", notNull: true },
      },
      indexes: [{ name: "idx_notes_created_at", columns: ["created_at"] }],
    },
  },
});
