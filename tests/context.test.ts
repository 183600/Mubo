import { describe, expect, test } from "bun:test";
import { createRequestContext } from "../src/http/context.ts";
import { createLogger } from "../src/core/logger.ts";
import { MuboError } from "../src/core/errors.ts";

function contextFor(request: Request, bodyLimit = 1024) {
  return createRequestContext({
    req: request,
    url: new URL(request.url),
    params: {},
    requestId: "req-context",
    db: null as never,
    log: createLogger({ level: "error" }),
    app: null,
    bodyLimit,
  });
}

function postRequest(body: string | Uint8Array, contentType?: string): Request {
  const headers = contentType === undefined ? undefined : { "content-type": contentType };
  return new Request("http://localhost/test", { method: "POST", headers, body });
}

describe("request context bodies", () => {
  test("parses JSON, forms, text, binary and empty bodies once", async () => {
    const json = contextFor(postRequest('{"a":1}', "application/json; charset=utf-8"));
    expect(await json.body()).toEqual({ a: 1 });
    expect(await json.text()).toBe('{"a":1}');

    const form = contextFor(postRequest("a=1&b=two", "application/x-www-form-urlencoded"));
    expect(await form.body()).toEqual({ a: "1", b: "two" });

    const text = contextFor(postRequest("plain text"));
    expect(await text.body()).toBe("plain text");

    const bytes = new Uint8Array([0, 255, 7]);
    const binary = contextFor(postRequest(bytes, "application/octet-stream"));
    const parsed = await binary.body();
    expect(parsed).toBeInstanceOf(Uint8Array);
    expect([...(parsed as Uint8Array)]).toEqual([0, 255, 7]);

    const empty = contextFor(postRequest(new Uint8Array()));
    expect(await empty.body()).toBeNull();
    expect(await empty.text()).toBe("");
  });

  test("parses multipart form data through formData and form", async () => {
    const boundary = "----mubo-boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="title"',
      "",
      "hello",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const ctx = contextFor(postRequest(body, `multipart/form-data; boundary=${boundary}`));
    const form = await ctx.formData();
    expect(form.get("title")).toBe("hello");
    expect((await ctx.form()).get("title")).toBe("hello");

    const alias = contextFor(postRequest(body, `multipart/form-data; boundary=${boundary}`));
    expect((await alias.form()).get("title")).toBe("hello");
  });

  test("reports malformed form bodies as validation errors", async () => {
    const ctx = contextFor(postRequest("not a form", "multipart/form-data"));
    await expect(ctx.formData()).rejects.toThrow(/Invalid form data/);
  });

  test("provides JSON, text and failure response helpers", async () => {
    const ctx = contextFor(new Request("http://localhost/test"));
    const ok = ctx.ok({ ok: true }, { status: 201 });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ ok: true });

    const json = ctx.json({ value: 1 });
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual({ value: 1 });

    const text = ctx.textResponse("hello");
    expect(await text.text()).toBe("hello");

    const failure = ctx.fail("VALIDATION_ERROR", "bad input", 422, { field: "name" });
    expect(failure.status).toBe(422);
    expect(await failure.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "bad input", details: { field: "name" } },
      requestId: "req-context",
    });

    ctx.set("answer", 42);
    expect(ctx.get<number>("answer")).toBe(42);
    expect(ctx.get("missing")).toBeUndefined();
  });

  test("does not expose object prototype keys through request state", () => {
    const ctx = contextFor(new Request("http://localhost/test"));

    expect(ctx.get("toString")).toBeUndefined();
    expect(ctx.get("constructor")).toBeUndefined();

    ctx.set("__proto__", { polluted: true });
    expect(ctx.get("polluted")).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(ctx.get<{ polluted: boolean }>("__proto__")).toEqual({ polluted: true });

    ctx.set("constructor", "value");
    expect(ctx.get("constructor")).toBe("value");
  });

  test("copies route parameters without exposing inherited keys", () => {
    const request = new Request("http://localhost/test");
    const ctx = createRequestContext({
      req: request,
      url: new URL(request.url),
      params: JSON.parse('{"__proto__":"value","constructor":"own"}') as Record<string, string>,
      requestId: "req-params",
      db: null as never,
      log: createLogger({ level: "error" }),
      app: null,
      bodyLimit: 1024,
    });

    expect(ctx.params["__proto__"]).toBe("value");
    expect(ctx.params["constructor"]).toBe("own");
    expect((ctx.params as { toString?: unknown }).toString).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test("rejects streamed bodies that exceed the limit without a content-length header", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    });
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: stream,
    });
    const ctx = contextFor(request, 10);

    let caught: unknown;
    try {
      await ctx.body();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MuboError);
    expect((caught as MuboError).code).toBe("PAYLOAD_TOO_LARGE");
    await expect(ctx.body()).rejects.toThrow(/exceeds 10 bytes/);
  });

  test("rejects oversized declared bodies even when no stream is present", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-length": "2048" },
    });
    const ctx = contextFor(request, 10);

    await expect(ctx.body()).rejects.toThrow(/exceeds 10 bytes/);
  });

  test("handles text/* content type correctly", async () => {
    const ctx = contextFor(new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "hello world",
    }));
    expect(await ctx.body()).toBe("hello world");
    expect(await ctx.text()).toBe("hello world");
  });

  test("handles text/plain without charset", async () => {
    const ctx = contextFor(new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "plain",
    }));
    expect(await ctx.text()).toBe("plain");
  });

  test("handles text with additional charset info", async () => {
    const ctx = contextFor(new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "text/custom; charset=iso-8859-1" },
      body: "custom text",
    }));
    expect(await ctx.text()).toBe("custom text");
  });

  test("handles empty content type as text", async () => {
    const ctx = contextFor(new Request("http://localhost/test", {
      method: "POST",
      body: "raw bytes",
    }));
    expect(await ctx.text()).toBe("raw bytes");
  });

  test("caches body reading - multiple body calls return same result", async () => {
    const ctx = contextFor(new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"test":1}',
    }));
    const first = await ctx.body();
    const second = await ctx.body();
    expect(first).toBe(second);
  });

  test("json helper method creates proper JSON responses", async () => {
    const ctx = contextFor(new Request("http://localhost/test"));
    const response = ctx.json({ key: "value" }, { status: 201 });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ key: "value" });
  });

  test("textResponse helper creates proper text responses", async () => {
    const ctx = contextFor(new Request("http://localhost/test"));
    const response = ctx.textResponse("hello world", { status: 202 });
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("hello world");
  });

  test("ok helper creates JSON responses", async () => {
    const ctx = contextFor(new Request("http://localhost/test"));
    const response = ctx.ok({ success: true });
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ success: true });
  });
});
