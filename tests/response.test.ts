import { describe, expect, test } from "bun:test";
import {
  errorPayload,
  errorResponse,
  htmlResponse,
  isMuboError,
  jsonResponse,
  MuboError,
  textResponse,
} from "../src/index.ts";

describe("error payloads", () => {
  test("derive status and exposure from MuboError defaults", () => {
    const error = new MuboError("NOT_FOUND", "missing");
    expect(isMuboError(error)).toBe(true);
    expect(error.status).toBe(404);
    expect(error.expose).toBe(true);
    expect(errorPayload("req-1", error, true)).toEqual({
      error: { code: "NOT_FOUND", message: "missing" },
      requestId: "req-1",
    });

    const custom = new MuboError("CUSTOM", "failed");
    expect(custom.status).toBe(500);
    expect(custom.expose).toBe(false);

    for (const code of ["constructor", "toString", "__proto__"]) {
      const prototypeCode = new MuboError(code, "failed");
      expect(prototypeCode.status).toBe(500);
      expect(errorResponse("req-prototype", prototypeCode).status).toBe(500);
    }
  });

  test("hide unexpected and explicitly private errors in production", () => {
    const unexpected = new Error("database password leaked");
    expect(errorPayload("req-2", unexpected, true)).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      requestId: "req-2",
    });
    expect(errorPayload("req-2", unexpected, false).error.message).toBe("database password leaked");

    const privateError = new MuboError("FORBIDDEN", "internal reason", {
      expose: false,
      details: { secret: true },
    });
    const payload = errorPayload("req-3", privateError, false);
    expect(payload.error).toEqual({ code: "FORBIDDEN", message: "Internal server error" });
  });

  test("include MuboError details only when exposed", () => {
    const error = new MuboError("VALIDATION_ERROR", "bad input", { details: { field: "name" } });
    expect(errorPayload("req-4", error).error.details).toEqual({ field: "name" });

    const hidden = new MuboError("VALIDATION_ERROR", "bad input", {
      expose: false,
      details: { field: "name" },
    });
    expect(errorPayload("req-5", hidden).error.details).toBeUndefined();
  });
});

describe("response helpers", () => {
  test("set default content types while honoring overrides", async () => {
    const json = jsonResponse({ ok: true }, { status: 201, headers: { "x-test": "1" } });
    expect(json.status).toBe(201);
    expect(json.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(json.headers.get("x-test")).toBe("1");
    expect(await json.json()).toEqual({ ok: true });

    const text = textResponse("hello", { headers: { "content-type": "text/custom" } });
    expect(text.headers.get("content-type")).toBe("text/custom");
    expect(await text.text()).toBe("hello");

    const html = htmlResponse("<h1>hello</h1>");
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await html.text()).toBe("<h1>hello</h1>");
  });

  test("fall back safely for unserializable details and invalid statuses", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const details of [circular, { value: 1n }]) {
      const response = errorResponse(
        "req-safe",
        new MuboError("VALIDATION_ERROR", "bad input", { details }),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: { code: "VALIDATION_ERROR", message: "bad input" },
        requestId: "req-safe",
      });
    }

    const invalidError = new MuboError("BAD_REQUEST", "bad", { status: 204 });
    expect(invalidError.expose).toBe(false);
    const invalidStatus = errorResponse("req-status", invalidError, true);
    expect(invalidStatus.status).toBe(500);
    expect((await invalidStatus.json() as { error: unknown }).error).toEqual({
      code: "BAD_REQUEST",
      message: "Internal server error",
    });
  });

  test("turn errors into tagged JSON responses", async () => {
    const response = errorResponse("req-6", new MuboError("BAD_REQUEST", "bad"));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "bad" },
      requestId: "req-6",
    });
  });
});
