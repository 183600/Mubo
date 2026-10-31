import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMuboApp, type MuboApp, StaticAssets } from "../src/index.ts";

const tempDirs: string[] = [];
const apps: MuboApp[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mubo-static-"));
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

async function startStatic(dir: string, spaFallback = true): Promise<MuboApp> {
  const app = await createMuboApp(
    {
      app: { name: "static-test", env: "test" },
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

describe("static assets", () => {
  test("serves files with ETag, cache headers, 304 and SPA fallback", async () => {
    const dir = publicDir();
    const app = await startStatic(dir);
    const root = `http://127.0.0.1:${app.port}`;

    const index = await fetch(`${root}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("Mubo");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(index.headers.get("content-type")).toContain("text/html");
    const etag = index.headers.get("etag");
    expect(etag).toBeTruthy();

    const cached = await fetch(`${root}/`, { headers: { "if-none-match": etag! } });
    expect(cached.status).toBe(304);

    const asset = await fetch(`${root}/assets/app.a1b2c3d4.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.get("content-type")).toContain("javascript");

    const spa = await fetch(`${root}/dashboard/settings`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("Mubo");

    const head = await fetch(`${root}/robots.txt`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe("13");

    const notFound = await fetch(`${root}/robots.txt`, { method: "POST" });
    expect(notFound.status).toBe(404);
  });

  test("serves directory index files when SPA fallback is disabled", async () => {
    const dir = publicDir();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "index.html"), "<!doctype html><title>Nested</title>");
    const app = await startStatic(dir, false);
    const root = `http://127.0.0.1:${app.port}`;

    const index = await fetch(`${root}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("Mubo");

    const nested = await fetch(`${root}/nested/`);
    expect(nested.status).toBe(200);
    expect(await nested.text()).toContain("Nested");

    const nestedWithoutSlash = await fetch(`${root}/nested`);
    expect(nestedWithoutSlash.status).toBe(200);
    expect(await nestedWithoutSlash.text()).toContain("Nested");

    const missing = await fetch(`${root}/missing`);
    expect(missing.status).toBe(404);
  });

  test("resolves disk and embedded paths when checking for files", async () => {
    const dir = publicDir();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "index.html"), "<!doctype html><title>Nested</title>");

    const disk = new StaticAssets({ mode: "disk", dir }, dir);
    expect(await disk.hasFile("/")).toBe(true);
    expect(await disk.hasFile("/nested/")).toBe(true);
    expect(await disk.hasFile("/nested")).toBe(true);
    expect(await disk.hasFile("/assets%2Fapp.a1b2c3d4.js")).toBe(true);
    expect(await disk.hasFile("/missing")).toBe(false);
    expect(await disk.hasFile("/%2e%2e%2fetc/passwd")).toBe(false);

    const embedded = new StaticAssets(
      { mode: "embedded", assets: { "/café.txt": "hello", "/index.html": "home" } },
      dir,
    );
    expect(await embedded.hasFile("/caf%C3%A9.txt")).toBe(true);
    expect(await embedded.hasFile("/café.txt")).toBe(true);
    expect(await embedded.hasFile("/missing")).toBe(false);

    const off = new StaticAssets({ mode: "off", dir }, dir);
    expect(await off.hasFile("/")).toBe(false);
  });

  test("blocks path traversal attempts", async () => {
    const dir = publicDir();
    const assets = new StaticAssets({ mode: "disk", dir }, dir);
    const malicious = "http://localhost/%2e%2e%2f%2e%2e%2fetc/passwd";
    const response = await assets.handle(new Request(malicious), new URL(malicious));
    expect(response?.status).toBe(403);
    expect(await response!.text()).not.toContain("root:");
  });

  test("app.static configures static serving after creation", async () => {
    const app = await createMuboApp(
      {
        app: { name: "static-configure-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
      },
      { argv: [] },
    );
    expect(app.static({ mode: "embedded", spaFallback: false, assets: { "/hello.txt": "hello" } })).toBe(app);
    await app.start();
    apps.push(app);
    const root = `http://127.0.0.1:${app.port}`;
    expect(await (await fetch(`${root}/hello.txt`)).text()).toBe("hello");
    expect((await fetch(`${root}/missing`)).status).toBe(404);
  });

  test("serves embedded assets without touching disk", async () => {
    const app = await createMuboApp(
      {
        app: { name: "embedded-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: {
          mode: "embedded",
          dir: "/definitely/not/here",
          assets: {
            "/index.html": { data: "<h1>embedded</h1>", type: "text/html; charset=utf-8" },
            "/app.js": {
              data: Buffer.from("embedded-js").toString("base64"),
              encoding: "base64",
              etag: '"custom-etag"',
            },
          },
        },
      },
      { argv: [] },
    );
    await app.start();
    apps.push(app);
    const root = `http://127.0.0.1:${app.port}`;
    const index = await fetch(`${root}/`);
    expect(await index.text()).toBe("<h1>embedded</h1>");
    const route = await fetch(`${root}/client/side/route`);
    expect(await route.text()).toBe("<h1>embedded</h1>");
    const script = await fetch(`${root}/app.js`);
    expect(await script.text()).toBe("embedded-js");
    expect(script.headers.get("etag")).toBe('"custom-etag"');

    const cached = await fetch(`${root}/app.js`, { headers: { "if-none-match": '"custom-etag"' } });
    expect(cached.status).toBe(304);

    const head = await fetch(`${root}/app.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe("11");
  });
});
