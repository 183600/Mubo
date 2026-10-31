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
});
