import { expect, test } from "bun:test";
import { schema } from "./schema";

test("defines the notes table", () => {
  expect(schema.tables.notes).toBeDefined();
});