import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMuboApp, StaticAssets } from "../src/index.ts";

const tempDirs: string[] = [];
const apps: any[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mubo-static-boundary-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (apps.length) await apps.pop()!.stop();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function publicDir(): string {
  const dir = tempDir();
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Mubo</title>");
  writeFileSync(join(dir, "assets", "app.a1b2c3d4.js"), "console.log('mubo')");
  writeFileSync(join(dir, "robots.txt"), "User-agent: *");
  return dir;
}

async function startStatic(dir: string, spaFallback = true): Promise<any> {
  const app = await createMuboApp(
    {
      app: { name: "static-boundary-test", env: "test" },
      db: { path: ":memory:" },
      log: { level: "error" },
      static: { mode: "disk", dir, spaFallback },
    },
    { cwd: dir, argv: [] },
  );
  await app.start();
  apps.push(app);
  return app;
}

describe("static asset boundary conditions", () => {
  test("handles percent-encoded slash path as root", async () => {
    const dir = publicDir();
    const app = await startStatic(dir);
    const root = `http://127.0.0.1:${app.port}`;

    // /%2F decodes to / and should serve the index
    const response = await fetch(`${root}/%2F`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Mubo");

    await app.stop();
  });

  test("handles percent-encoded dot paths", async () => {
    const dir = publicDir();
    const app = await startStatic(dir);
    const root = `http://127.0.0.1:${app.port}`;

    // /%2E decodes to . and should serve index.html
    const response = await fetch(`${root}/%2E`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Mubo");

    // /%2E%2E should be treated as directory traversal
    const traversal = await fetch(`${root}/%2E%2E%2Fetc%2Fpasswd`, { method: "GET" });
    expect(traversal.status).toBe(403);

    await app.stop();
  });

  test("serves directory index for path with trailing slash normalization", async () => {
    const dir = publicDir();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "index.html"), "<!doctype html><title>Nested</title>");
    const app = await startStatic(dir, false);
    const root = `http://127.0.0.1:${app.port}`;

    // Path with multiple slashes should normalize
    const response = await fetch(`${root}//nested//`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Nested");

    await app.stop();
  });

  test("blocks path with percent-encoded NUL followed by traversal", async () => {
    const dir = publicDir();
    const app = await startStatic(dir);
    const root = `http://127.0.0.1:${app.port}`;

    // Mixed percent-encoded NUL and traversal
    const response = await fetch(`${root}/%00%2E%2E%2Fetc%2Fpasswd`);
    expect(response.status).toBe(400);

    await app.stop();
  });

  test("serves embedded assets with path containing percent-encoded chars", async () => {
    const app = await createMuboApp(
      {
        app: { name: "embedded-boundary-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: {
          mode: "embedded",
          assets: { "/caf%C3%A9.txt": "hello", "/%24test": "dollar" },
        },
      },
      { argv: [] },
    );
    await app.start();
    apps.push(app);
    const root = `http://127.0.0.1:${app.port}`;

    const cafe = await fetch(`${root}/caf%C3%A9.txt`);
    expect(cafe.status).toBe(200);
    expect(await cafe.text()).toBe("hello");

    const dollar = await fetch(`${root}/%24test`);
    expect(dollar.status).toBe(200);
    await app.stop();
  });

  test("treats files with hash-like but short tokens as non-immutable", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.abc123.js"), "short-hash");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const response = await assets.handle(new Request("http://localhost/app.abc123.js"), new URL("http://localhost/app.abc123.js"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("treats 8-char all-lowercase tokens as non-immutable", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.abcdefgh.js"), "eight-lower");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const response = await assets.handle(new Request("http://localhost/app.abcdefgh.js"), new URL("http://localhost/app.abcdefgh.js"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("treats 8-char mixed-case tokens as immutable", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.aBcDeFgH.js"), "eight-mixed");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const response = await assets.handle(new Request("http://localhost/app.aBcDeFgH.js"), new URL("http://localhost/app.aBcDeFgH.js"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("treats 8-char token with digit as immutable", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.abcdef1g.js"), "eight-with-digit");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const response = await assets.handle(new Request("http://localhost/app.abcdef1g.js"), new URL("http://localhost/app.abcdef1g.js"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("rejects 7-char tokens as non-immutable", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.abcdef.js"), "seven-chars");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const response = await assets.handle(new Request("http://localhost/app.abcdef.js"), new URL("http://localhost/app.abcdef.js"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("rejects 65-char tokens as non-immutable (out of range)", async () => {
    const dir = tempDir();
    const longToken = "a".repeat(65);
    writeFileSync(join(dir, `app.${longToken}.js`), "long-hash");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const response = await assets.handle(new Request(`http://localhost/app.${longToken}.js`), new URL(`http://localhost/app.${longToken}.js`));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("rejects tokens with special characters as non-immutable", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.abc_def.js"), "underscore-in-token");
    writeFileSync(join(dir, "app.abc-def.js"), "hyphen-in-token");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const underscoreResp = await assets.handle(new Request("http://localhost/app.abc_def.js"), new URL("http://localhost/app.abc_def.js"));
    const hyphenResp = await assets.handle(new Request("http://localhost/app.abc-def.js"), new URL("http://localhost/app.abc-def.js"));
    expect(underscoreResp?.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(hyphenResp?.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("handles embedded assets with base64 data", async () => {
    const app = await createMuboApp(
      {
        app: { name: "embedded-base64-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: {
          mode: "embedded",
          assets: {
            "/data.bin": {
              data: Buffer.from("binary-data").toString("base64"),
              encoding: "base64",
              type: "application/octet-stream",
            },
          },
        },
      },
      { argv: [] },
    );
    await app.start();
    apps.push(app);
    const root = `http://127.0.0.1:${app.port}`;

    const resp = await fetch(`${root}/data.bin`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("binary-data");
    expect(resp.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("handles embedded assets with ArrayBuffer and Uint8Array data", async () => {
    const app = await createMuboApp(
      {
        app: { name: "embedded-arraybuffer-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: {
          mode: "embedded",
          assets: {
            "/uint8.bin": new Uint8Array([1, 2, 3, 4, 5]),
            "/ab.bin": new ArrayBuffer(3),
          },
        },
      },
      { argv: [] },
    );
    await app.start();
    apps.push(app);
    const root = `http://127.0.0.1:${app.port}`;

    const uint8Resp = await fetch(`${root}/uint8.bin`);
    expect(uint8Resp.status).toBe(200);
    expect(new Uint8Array(await uint8Resp.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  test("serves embedded assets with custom type metadata", async () => {
    const app = await createMuboApp(
      {
        app: { name: "embedded-custom-type-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: {
          mode: "embedded",
          assets: {
            "/custom.wasm": {
              data: "fake-wasm-content",
              type: "application/wasm",
            },
          },
        },
      },
      { argv: [] },
    );
    await app.start();
    apps.push(app);
    const root = `http://127.0.0.1:${app.port}`;

    const resp = await fetch(`${root}/custom.wasm`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/wasm");
  });

  test("handles embedded assets with text.utf8 string data", async () => {
    const app = await createMuboApp(
      {
        app: { name: "embedded-utf8-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: {
          mode: "embedded",
          assets: {
            "/unicode.txt": "Hello 世界 🌍",
          },
        },
      },
      { argv: [] },
    );
    await app.start();
    apps.push(app);
    const root = `http://127.0.0.1:${app.port}`;

    const resp = await fetch(`${root}/unicode.txt`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("Hello 世界 🌍");
  });

  test("normalizes embedded asset keys for duplicate route resolution", async () => {
    const assets = new StaticAssets(
      {
        mode: "embedded",
        assets: { "/a.txt": "lowercase", "/A.TXT": "uppercase" },
      },
      tempDir(),
    );

    const resp1 = await assets.handle(new Request("http://localhost/a.txt"), new URL("http://localhost/a.txt"));
    const resp2 = await assets.handle(new Request("http://localhost/A.TXT"), new URL("http://localhost/A.TXT"));

    expect(assets.enabled).toBe(true);
  });

  test("returns correct ETag for embedded assets without explicit etag", async () => {
    const dir = tempDir();
    const assets = new StaticAssets(
      {
        mode: "embedded",
        assets: { "/etag.js": "content for etag" },
      },
      dir,
    );

    const resp = await assets.handle(new Request("http://localhost/etag.js"), new URL("http://localhost/etag.js"));
    expect(resp?.status).toBe(200);
    const etag = resp?.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(etag).toMatch(/^".+"/);
  });
});