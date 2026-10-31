import { afterEach, describe, expect, test } from "bun:test";
import { createLogger } from "../src/index.ts";

const originalLog = console.log;

afterEach(() => {
  console.log = originalLog;
});

function captureLogs(run: () => void): string[] {
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  run();
  return lines;
}

describe("logger", () => {
  test("serializes bigint and circular fields in JSON mode", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const shared = { value: 1 };
    const logger = createLogger({ level: "debug", json: true });

    const lines = captureLogs(() => {
      logger.info("payload", {
        big: 10n,
        circular,
        first: shared,
        second: shared,
      });
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("payload");
    expect(entry.big).toBe("10");
    expect(entry.circular.self).toBe("[Circular]");
    expect(entry.first).toEqual({ value: 1 });
    expect(entry.second).toEqual({ value: 1 });
  });

  test("falls back to a serializable log entry when a field cannot be converted", () => {
    const logger = createLogger({ level: "debug", json: true });
    const bad = {
      toJSON() {
        throw new Error("nope");
      },
    };

    const lines = captureLogs(() => {
      logger.info("bad payload", { bad });
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("bad payload");
    expect(entry.loggingError).toBe("Log fields could not be serialized");
  });
});
