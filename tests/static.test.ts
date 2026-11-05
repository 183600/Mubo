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
  test("accepts a filesystem root as the static directory", () => {
    if (process.platform === "win32") return;
    const assets = new StaticAssets({ mode: "disk", dir: "/" });
    const resolved = (
      assets as unknown as {
        safeDiskPath(path: string): { path: string; error?: Response };
      }
    ).safeDiskPath("/etc/hosts");
    expect(resolved.error).toBeUndefined();
    expect(resolved.path).toBe("/etc/hosts");
  });

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

    const weakCached = await fetch(`${root}/`, { headers: { "if-none-match": `W/${etag}` } });
    expect(weakCached.status).toBe(304);

    const starCached = await fetch(`${root}/`, { headers: { "if-none-match": "*" } });
    expect(starCached.status).toBe(304);

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

  test("rejects malformed and NUL paths", async () => {
    const dir = publicDir();
    const disk = new StaticAssets({ mode: "disk", dir, spaFallback: true }, dir);
    for (const path of ["/%E0%A4%A", "/%00"]) {
      const url = `http://localhost${path}`;
      const response = await disk.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(400);
    }

    const embedded = new StaticAssets(
      { mode: "embedded", spaFallback: true, assets: { "/index.html": "home" } },
      dir,
    );
    for (const path of ["/%E0%A4%A", "/%00"]) {
      const url = `http://localhost${path}`;
      const response = await embedded.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(400);
    }
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
      {
        mode: "embedded",
        assets: { "/café.txt": "hello", "/docs/index.html": "docs", "/index.html": "home" },
      },
      dir,
    );
    expect(await embedded.hasFile("/caf%C3%A9.txt")).toBe(true);
    expect(await embedded.hasFile("/café.txt")).toBe(true);
    expect(await embedded.hasFile("/docs")).toBe(true);
    expect(await embedded.hasFile("/docs/index.html")).toBe(true);
    expect(await embedded.hasFile("/missing")).toBe(false);

    const mixed = new StaticAssets(
      {
        mode: "disk",
        dir,
        assets: { "/index.html": "home", "/embedded.txt": "embedded" },
      },
      dir,
    );
    expect(await mixed.hasFile("/robots.txt")).toBe(true);
    expect(await mixed.hasFile("/embedded.txt")).toBe(true);
    expect(await mixed.hasFile("/missing")).toBe(false);

    const emptyEmbedded = new StaticAssets({ mode: "embedded", dir }, dir);
    expect(await emptyEmbedded.hasFile("/robots.txt")).toBe(true);
    expect(await emptyEmbedded.hasFile("/missing")).toBe(false);

    const off = new StaticAssets({ mode: "off", dir }, dir);
    expect(await off.hasFile("/")).toBe(false);
  });

  test("hasFile reflects mode changes via configure", async () => {
    const dir = publicDir();
    writeFileSync(join(dir, "disk-only.txt"), "from disk");

    const assets = new StaticAssets({ mode: "disk", dir }, dir);
    expect(await assets.hasFile("/disk-only.txt")).toBe(true);
    expect(await assets.hasFile("/missing")).toBe(false);

    assets.configure({ mode: "embedded", assets: { "/embedded-only.txt": "from embedded" } });
    expect(await assets.hasFile("/disk-only.txt")).toBe(false);
    expect(await assets.hasFile("/embedded-only.txt")).toBe(true);

    assets.configure({ mode: "off" });
    expect(await assets.hasFile("/embedded-only.txt")).toBe(false);
    expect(await assets.hasFile("/disk-only.txt")).toBe(false);
  });

  test("prefers exact embedded asset keys over decoded aliases", async () => {
    const assets = new StaticAssets({
      mode: "embedded",
      spaFallback: false,
      assets: {
        "/a%20b.txt": "encoded",
        "/a b.txt": "exact",
      },
    });

    const exactUrl = "http://localhost/a%20b.txt";
    const exact = await assets.handle(new Request(exactUrl), new URL(exactUrl));
    expect(await exact!.text()).toBe("exact");

    const encodedUrl = "http://localhost/a%2520b.txt";
    const encoded = await assets.handle(new Request(encodedUrl), new URL(encodedUrl));
    expect(await encoded!.text()).toBe("encoded");
  });

  test("does not let embedded SPA fallback shadow disk files in disk mode", async () => {
    const dir = publicDir();
    writeFileSync(join(dir, "only-disk.txt"), "disk-only");
    const assets = new StaticAssets(
      {
        mode: "disk",
        dir,
        spaFallback: true,
        assets: { "/index.html": "embedded-home", "/embedded.txt": "embedded-only" },
      },
      dir,
    );
    const request = async (path: string) => {
      const url = `http://localhost${path}`;
      return assets.handle(new Request(url), new URL(url));
    };

    const diskFile = await request("/only-disk.txt");
    expect(diskFile?.status).toBe(200);
    expect(await diskFile!.text()).toBe("disk-only");

    const missing = await request("/missing");
    expect(missing?.status).toBe(200);
    expect(await missing!.text()).toContain("Mubo");

    const embedded = await request("/embedded.txt");
    expect(await embedded!.text()).toBe("embedded-only");
  });

  test("serves the embedded SPA shell in disk mode when the disk has nothing to serve", async () => {
    const dir = tempDir();
    const assets = new StaticAssets(
      {
        mode: "disk",
        dir,
        spaFallback: true,
        assets: { "/index.html": "embedded-home", "/embedded.txt": "embedded-only" },
      },
      dir,
    );
    const request = async (path: string) => {
      const url = `http://localhost${path}`;
      return assets.handle(new Request(url), new URL(url));
    };

    const index = await request("/");
    expect(index?.status).toBe(200);
    expect(await index!.text()).toBe("embedded-home");

    const fallback = await request("/client/route");
    expect(fallback?.status).toBe(200);
    expect(await fallback!.text()).toBe("embedded-home");

    const embedded = await request("/embedded.txt");
    expect(await embedded!.text()).toBe("embedded-only");
  });

  test("falls back to public when configured with an empty directory", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "hello.txt"), "from public");
    writeFileSync(join(dir, "secret.txt"), "from cwd");

    const assets = new StaticAssets({ mode: "disk", dir: "" }, dir);
    const helloUrl = "http://localhost/hello.txt";
    const hello = await assets.handle(new Request(helloUrl), new URL(helloUrl));
    expect(await hello!.text()).toBe("from public");

    const secretUrl = "http://localhost/secret.txt";
    expect(await assets.handle(new Request(secretUrl), new URL(secretUrl))).toBeNull();
  });

  test("falls back to a binary content type for prototype-like extensions", async () => {
    const dir = publicDir();
    writeFileSync(join(dir, "asset.constructor"), "binary");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);
    const diskUrl = "http://localhost/asset.constructor";
    const disk = await assets.handle(new Request(diskUrl), new URL(diskUrl));
    expect(disk?.headers.get("content-type")).toBe("application/octet-stream");

    const embedded = new StaticAssets(
      { mode: "embedded", assets: { "/asset.toString": "binary" } },
      dir,
    );
    const url = "http://localhost/asset.toString";
    const response = await embedded.handle(new Request(url), new URL(url));
    expect(response?.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("blocks path traversal attempts", async () => {
    const dir = publicDir();
    const assets = new StaticAssets({ mode: "disk", dir }, dir);
    const malicious = "http://localhost/%2e%2e%2f%2e%2e%2fetc/passwd";
    const response = await assets.handle(new Request(malicious), new URL(malicious));
    expect(response?.status).toBe(403);
    expect(await response!.text()).not.toContain("root:");
  });

  test("rejects malformed and NUL paths", async () => {
    const dir = publicDir();
    const disk = new StaticAssets({ mode: "disk", dir, spaFallback: true }, dir);
    for (const path of ["/%E0%A4%A", "/%00"]) {
      const url = `http://localhost${path}`;
      const response = await disk.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(400);
    }

    const embedded = new StaticAssets(
      { mode: "embedded", spaFallback: true, assets: { "/index.html": "home" } },
      dir,
    );
    for (const path of ["/%E0%A4%A", "/%00"]) {
      const url = `http://localhost${path}`;
      const response = await embedded.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(400);
    }
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

  test("serves embedded directory indexes before falling back to the SPA shell", async () => {
    const app = await createMuboApp(
      {
        app: { name: "embedded-index-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: {
          mode: "embedded",
          spaFallback: true,
          assets: {
            "/index.html": "<h1>home</h1>",
            "/docs/index.html": "<h1>docs</h1>",
          },
        },
      },
      { argv: [] },
    );
    await app.start();
    apps.push(app);
    const root = `http://127.0.0.1:${app.port}`;

    for (const path of ["/docs", "/docs/"]) {
      const response = await fetch(`${root}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<h1>docs</h1>");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("content-type")).toContain("text/html");
    }

    const fallback = await fetch(`${root}/client/route`);
    expect(await fallback.text()).toBe("<h1>home</h1>");
  });

  test("keeps every HTML extension uncached regardless of case", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.htm"), "<h1>legacy</h1>");
    writeFileSync(join(dir, "page.HTML"), "<h1>upper</h1>");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    for (const path of ["/index.htm", "/page.HTML"]) {
      const url = `http://localhost${path}`;
      const response = await assets.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(200);
      expect(response?.headers.get("cache-control")).toBe("no-cache");
      expect(response?.headers.get("content-type")).toContain("text/html");
    }
  });

  test("treats hashed assets with extra suffix extensions as immutable", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.a1b2c3d4.min.js"), "console.log('min')");
    writeFileSync(join(dir, "vendor.12345678.chunk.css"), "body{}");
    const assets = new StaticAssets(
      { mode: "disk", dir, cache: { immutableExtensions: ["js", "css"] } },
      dir,
    );

    for (const path of ["/app.a1b2c3d4.min.js", "/vendor.12345678.chunk.css"]) {
      const url = `http://localhost${path}`;
      const response = await assets.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(200);
      expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    }
  });

  test("applies default immutable extensions when constructed directly", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.a1b2c3d4.js"), "hashed");
    writeFileSync(join(dir, "plain.js"), "plain");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const hashedUrl = "http://localhost/app.a1b2c3d4.js";
    const hashed = await assets.handle(new Request(hashedUrl), new URL(hashedUrl));
    expect(hashed?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const plainUrl = "http://localhost/plain.js";
    const plain = await assets.handle(new Request(plainUrl), new URL(plainUrl));
    expect(plain?.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("normalizes immutable extension settings and ignores human-readable names", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.a1b2c3d4.js"), "hashed");
    writeFileSync(join(dir, "vendor.12345678.chunk.css"), "hashed");
    writeFileSync(join(dir, "apple-touch-icon.png"), "icon");
    writeFileSync(join(dir, "hero-image-large.png"), "hero");
    writeFileSync(join(dir, "main.abcdefgh.js"), "lowercase");
    const assets = new StaticAssets(
      {
        mode: "disk",
        dir,
        cache: { immutableExtensions: [".JS", " CSS ", "png"] },
      },
      dir,
    );

    const cacheFor = async (path: string) => {
      const url = `http://localhost${path}`;
      const response = await assets.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(200);
      return response?.headers.get("cache-control");
    };

    expect(await cacheFor("/app.a1b2c3d4.js")).toBe("public, max-age=31536000, immutable");
    expect(await cacheFor("/vendor.12345678.chunk.css")).toBe("public, max-age=31536000, immutable");
    expect(await cacheFor("/apple-touch-icon.png")).toBe("public, max-age=3600");
    expect(await cacheFor("/hero-image-large.png")).toBe("public, max-age=3600");
    expect(await cacheFor("/main.abcdefgh.js")).toBe("public, max-age=3600");
  });

  test("respects defaultMaxAgeSeconds of 0 for no caching", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "plain.js"), "plain");
    const assets = new StaticAssets(
      { mode: "disk", dir, cache: { defaultMaxAgeSeconds: 0 } },
      dir,
    );

    const response = await assets.handle(new Request("http://localhost/plain.js"), new URL("http://localhost/plain.js"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=0");
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

  test("uses weak comparison for weak ETags on either side", async () => {
    const dir = tempDir();
    const assets = new StaticAssets(
      {
        mode: "embedded",
        assets: { "/weak.js": { data: "weak", etag: 'W/"weak-etag"' } },
      },
      dir,
    );

    for (const header of ['"weak-etag"', 'W/"weak-etag"', `"other", W/"weak-etag"`]) {
      const url = "http://localhost/weak.js";
      const response = await assets.handle(
        new Request(url, { headers: { "if-none-match": header } }),
        new URL(url),
      );
      expect(response?.status).toBe(304);
      expect(response?.headers.get("etag")).toBe('W/"weak-etag"');
    }
  });

  test("does not split commas inside quoted ETags", async () => {
    const dir = tempDir();
    const assets = new StaticAssets(
      {
        mode: "embedded",
        assets: { "/quoted.js": { data: "quoted", etag: '"quoted,comma"' } },
      },
      dir,
    );
    const url = "http://localhost/quoted.js";
    for (const header of ['"quoted,comma"', `"other", "quoted,comma"`]) {
      const response = await assets.handle(
        new Request(url, { headers: { "if-none-match": header } }),
        new URL(url),
      );
      expect(response?.status).toBe(304);
      expect(response?.headers.get("etag")).toBe('"quoted,comma"');
    }
  });

  test("handles escaped quotes inside quoted ETags per RFC 7230", async () => {
    const dir = tempDir();
    const escapedEtag = '"escaped\\",quote"';
    const assets = new StaticAssets(
      {
        mode: "embedded",
        assets: { "/escaped.js": { data: "escaped", etag: escapedEtag } },
      },
      dir,
    );
    const url = "http://localhost/escaped.js";
    for (const header of [escapedEtag, `"other", ${escapedEtag}`]) {
      const response = await assets.handle(
        new Request(url, { headers: { "if-none-match": header } }),
        new URL(url),
      );
      expect(response?.status).toBe(304);
      expect(response?.headers.get("etag")).toBe(escapedEtag);
    }
  });

  test("serves files with leading slash in path", async () => {
    const dir = publicDir();
    writeFileSync(join(dir, "a.txt"), "hello");
    const app = await startStatic(dir);
    const root = `http://127.0.0.1:${app.port}`;
    const file = await fetch(`${root}/a.txt`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("hello");
    await app.stop();
  });

  test("blocks path traversal with double NUL bytes", async () => {
    const dir = publicDir();
    const app = await startStatic(dir);
    const root = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${root}/%00%00etc/passwd`, { method: "GET" });
    expect(response.status).toBe(400);
    await app.stop();
  });

  test("rejects malformed percent-encoding with odd number of hex digits", async () => {
    const dir = publicDir();
    const app = await startStatic(dir);
    const root = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${root}/%FF`, { method: "GET" });
    expect(response.status).toBe(400);
    await app.stop();
  });

  test("serves directory index when path ends with slash", async () => {
    const dir = publicDir();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "index.html"), "<!doctype html><title>Nested</title>");
    const app = await startStatic(dir, true);
    const root = `http://127.0.0.1:${app.port}`;
    const nested = await fetch(`${root}/nested/`);
    expect(nested.status).toBe(200);
    expect(await nested.text()).toContain("Nested");
    await app.stop();
  });

  test("falls back to SPA shell for non-existent paths when spaFallback is enabled", async () => {
    const dir = publicDir();
    const app = await startStatic(dir, true);
    const root = `http://127.0.0.1:${app.port}`;
    const spa = await fetch(`${root}/client/route`);
    expect(spa.status).toBe(200);
    await app.stop();
  });

  test("returns 404 for POST requests to static files", async () => {
    const dir = publicDir();
    const app = await startStatic(dir, true);
    const root = `http://127.0.0.1:${app.port}`;
    const notFound = await fetch(`${root}/index.html`, { method: "POST" });
    expect(notFound.status).toBe(404);
    await app.stop();
  });

  test("returns 416 over HTTP for unsatisfiable range requests", async () => {
    const dir = publicDir();
    writeFileSync(join(dir, "range.txt"), "0123456789");
    const app = await startStatic(dir, true);
    const root = `http://127.0.0.1:${app.port}`;

    const partial = await fetch(`${root}/range.txt`, { headers: { range: "bytes=0-4" } });
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("01234");

    const unsatisfiable = await fetch(`${root}/range.txt`, { headers: { range: "bytes=10-" } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");
    expect(await unsatisfiable.text()).toBe("");

    const ignored = await fetch(`${root}/range.txt`, { headers: { range: "bytes=5-0" } });
    expect(ignored.status).toBe(200);
    expect(await ignored.text()).toBe("0123456789");
    await app.stop();
  });

  test("serves embedded assets in disk mode when embedded not found", async () => {
    const dir = publicDir();
    writeFileSync(join(dir, "embedded.txt"), "from disk");
    const app = await startStatic(dir, true);
    const root = `http://127.0.0.1:${app.port}`;
    const diskFile = await fetch(`${root}/embedded.txt`);
    expect(diskFile?.status).toBe(200);
    expect(await diskFile!.text()).toBe("from disk");
    await app.stop();
  });

  test("applies default immutable extensions when constructed directly", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.a1b2c3d4.js"), "hashed");
    writeFileSync(join(dir, "plain.js"), "plain");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const hashedUrl = "http://localhost/app.a1b2c3d4.js";
    const hashed = await assets.handle(new Request(hashedUrl), new URL(hashedUrl));
    expect(hashed?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const plainUrl = "http://localhost/plain.js";
    const plain = await assets.handle(new Request(plainUrl), new URL(plainUrl));
    expect(plain?.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("normalizes immutable extension settings and ignores human-readable names", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.a1b2c3d4.js"), "hashed");
    writeFileSync(join(dir, "vendor.12345678.chunk.css"), "hashed");
    writeFileSync(join(dir, "apple-touch-icon.png"), "icon");
    writeFileSync(join(dir, "hero-image-large.png"), "hero");
    writeFileSync(join(dir, "main.abcdefgh.js"), "lowercase");
    const assets = new StaticAssets(
      {
        mode: "disk",
        dir,
        cache: { immutableExtensions: [".JS", " CSS ", "png"] },
      },
      dir,
    );

    const cacheFor = async (path: string) => {
      const url = `http://localhost${path}`;
      const response = await assets.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(200);
      return response?.headers.get("cache-control");
    };

    expect(await cacheFor("/app.a1b2c3d4.js")).toBe("public, max-age=31536000, immutable");
    expect(await cacheFor("/vendor.12345678.chunk.css")).toBe("public, max-age=31536000, immutable");
    expect(await cacheFor("/apple-touch-icon.png")).toBe("public, max-age=3600");
    expect(await cacheFor("/hero-image-large.png")).toBe("public, max-age=3600");
    expect(await cacheFor("/main.abcdefgh.js")).toBe("public, max-age=3600");
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

    await app.stop();
  });

  test("uses weak comparison for weak ETags on either side", async () => {
    const dir = publicDir();
    const assets = new StaticAssets(
      {
        mode: "embedded",
        assets: { "/weak.js": { data: "weak", etag: 'W/"weak-etag"' } },
      },
      dir,
    );

    for (const header of ['"weak-etag"', 'W/"weak-etag"', `"other", W/"weak-etag"`]) {
      const url = "http://localhost/weak.js";
      const response = await assets.handle(
        new Request(url, { headers: { "if-none-match": header } }),
        new URL(url),
      );
      expect(response?.status).toBe(304);
      expect(response?.headers.get("etag")).toBe('W/"weak-etag"');
    }
  });

  test("does not split commas inside quoted ETags", async () => {
    const dir = publicDir();
    const assets = new StaticAssets(
      {
        mode: "embedded",
        assets: { "/quoted.js": { data: "quoted", etag: '"quoted,comma"' } },
      },
      dir,
    );

    const url = "http://localhost/quoted.js";
    for (const header of ['"quoted,comma"', `"other", "quoted,comma"`]) {
      const response = await assets.handle(
        new Request(url, { headers: { "if-none-match": header } }),
        new URL(url),
      );
      expect(response?.status).toBe(304);
      expect(response?.headers.get("etag")).toBe('"quoted,comma"');
    }
  });

  test("blocks path traversal attempts", async () => {
    const dir = publicDir();
    const assets = new StaticAssets({ mode: "disk", dir }, dir);
    const malicious = "http://localhost/%2e%2e%2f%2e%2e%2fetc/passwd";
    const response = await assets.handle(new Request(malicious), new URL(malicious));
    expect(response?.status).toBe(403);
    expect(await response!.text()).not.toContain("root:");
  });

  test("rejects malformed and NUL paths", async () => {
    const dir = publicDir();
    const disk = new StaticAssets({ mode: "disk", dir, spaFallback: true }, dir);
    for (const path of ["/%E0%A4%A", "/%00"]) {
      const url = `http://localhost${path}`;
      const response = await disk.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(400);
    }

    const embedded = new StaticAssets(
      { mode: "embedded", spaFallback: true, assets: { "/index.html": "home" } },
      dir,
    );
    for (const path of ["/%E0%A4%A", "/%00"]) {
      const url = `http://localhost${path}`;
      const response = await embedded.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(400);
    }
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

  test("serves embedded directory indexes before falling back to the SPA shell", async () => {
    const app = await createMuboApp(
      {
        app: { name: "embedded-index-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: {
          mode: "embedded",
          spaFallback: true,
          assets: {
            "/index.html": "<h1>home</h1>",
            "/docs/index.html": "<h1>docs</h1>",
          },
        },
      },
      { argv: [] },
    );
    await app.start();
    apps.push(app);
    const root = `http://127.0.0.1:${app.port}`;

    for (const path of ["/docs", "/docs/"]) {
      const response = await fetch(`${root}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<h1>docs</h1>");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("content-type")).toContain("text/html");
    }

    const fallback = await fetch(`${root}/client/route`);
    expect(await fallback.text()).toBe("<h1>home</h1>");
  });

  test("keeps every HTML extension uncached regardless of case", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.htm"), "<h1>legacy</h1>");
    writeFileSync(join(dir, "page.HTML"), "<h1>upper</h1>");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    for (const path of ["/index.htm", "/page.HTML"]) {
      const url = `http://localhost${path}`;
      const response = await assets.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(200);
      expect(response?.headers.get("cache-control")).toBe("no-cache");
      expect(response?.headers.get("content-type")).toContain("text/html");
    }
  });

  test("treats hashed assets with extra suffix extensions as immutable", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.a1b2c3d4.min.js"), "console.log('min')");
    writeFileSync(join(dir, "vendor.12345678.chunk.css"), "body{}");
    const assets = new StaticAssets(
      { mode: "disk", dir, cache: { immutableExtensions: ["js", "css"] } },
      dir,
    );

    for (const path of ["/app.a1b2c3d4.min.js", "/vendor.12345678.chunk.css"]) {
      const url = `http://localhost${path}`;
      const response = await assets.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(200);
      expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    }
  });

  test("handles files with multiple hash-like tokens in filename", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.abc1234567890def.abc1234567890ef.js"), "multiple-hashes");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const response = await assets.handle(new Request("http://localhost/app.abc1234567890def.abc1234567890ef.js"), new URL("http://localhost/app.abc1234567890def.abc1234567890ef.js"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("treats files with hash-like but short tokens as non-immutable", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.abc123.js"), "short-hash");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const response = await assets.handle(new Request("http://localhost/app.abc123.js"), new URL("http://localhost/app.abc123.js"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("serves files with double extensions correctly", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "file.min.js"), "content");
    writeFileSync(join(dir, "app.a1B2c3d4.min.js"), "hashed-min");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const regularJs = await assets.handle(new Request("http://localhost/file.min.js"), new URL("http://localhost/file.min.js"));
    expect(regularJs?.status).toBe(200);
    expect(regularJs?.headers.get("cache-control")).toBe("public, max-age=3600");

    const hashedMin = await assets.handle(new Request("http://localhost/app.a1B2c3d4.min.js"), new URL("http://localhost/app.a1B2c3d4.min.js"));
    expect(hashedMin?.status).toBe(200);
    expect(hashedMin?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("handles very long file names", async () => {
    const dir = tempDir();
    const longName = "app." + "a".repeat(200) + ".js";
    writeFileSync(join(dir, longName), "long name");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const response = await assets.handle(new Request(`http://localhost/${longName}`), new URL(`http://localhost/${longName}`));
    expect(response?.status).toBe(200);
  });

  test("blocks backslash path traversal", async () => {
    const dir = publicDir();
    const assets = new StaticAssets({ mode: "disk", dir }, dir);
    const response = await assets.handle(
      new Request("http://localhost/%5C%5C%5C..%5C%5C%5C..%5C%5C%5Cetc%5Cpasswd"),
      new URL("http://localhost/%5C%5C%5C..%5C%5C%5C..%5C%5C%5Cetc%5Cpasswd"),
    );
    expect(response?.status).toBe(403);
    expect(await response!.text()).not.toContain("root:");
  });

  test("handles empty static directory", async () => {
    const dir = tempDir();
    const assets = new StaticAssets({ mode: "disk", dir }, dir);
    const response = await assets.handle(
      new Request("http://localhost/anything"),
      new URL("http://localhost/anything"),
    );
    expect(response).toBeNull();
  });

  test("serves embedded assets with unicode-friendly names", async () => {
    const assets = new StaticAssets({
      mode: "embedded",
      assets: {
        "/résumé.txt": "funny",
        "/naïve.js": "fancy",
      },
    });
    const url = "http://localhost/résumé.txt";
    const response = await assets.handle(new Request(url), new URL(url));
    expect(await response!.text()).toBe("funny");

    const url2 = "http://localhost/naïve.js";
    const response2 = await assets.handle(new Request(url2), new URL(url2));
    expect(await response2!.text()).toBe("fancy");
  });

  test("embedding assets with duplicate decoded keys resolves correctly", async () => {
    const assets = new StaticAssets({
      mode: "embedded",
      assets: {
        "/%70aram.txt": "param-value",
        "/param.txt": "exact-value",
      },
    });
    const exactUrl = "http://localhost/param.txt";
    const exact = await assets.handle(new Request(exactUrl), new URL(exactUrl));
    expect(await exact!.text()).toBeDefined();

    const decodedUrl = "http://localhost/%70aram.txt";
    const decoded = await assets.handle(new Request(decodedUrl), new URL(decodedUrl));
    expect(await decoded!.text()).toBeDefined();
  });

  test("disk mode serves assets from disk when embedded not found", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "hello.txt"), "from-disk");
    const assets = new StaticAssets({
      mode: "disk",
      dir,
    });
    const url = "http://localhost/hello.txt";
    const response = await assets.handle(new Request(url), new URL(url));
    expect(await response!.text()).toBe("from-disk");
  });

  test("handles path with trailing multiple slashes", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "file.txt"), "content");
    const assets = new StaticAssets({ mode: "disk", dir }, dir);
    for (const path of ["//file.txt", "///file.txt"]) {
      const url = `http://localhost${path}`;
      const response = await assets.handle(new Request(url), new URL(url));
      expect(response?.status).toBe(200);
      expect(await response!.text()).toBe("content");
    }
  });

  test("embedded mode serves assets when disk directory has same name", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.html"), "disk-index");
    const assets = new StaticAssets({
      mode: "embedded",
      dir,
    });
    const url = "http://localhost/index.html";
    const response = await assets.handle(new Request(url), new URL(url));
    expect(await response!.text()).toBe("disk-index");
  });

  test("disk mode with empty string dir falls back to cwd public", async () => {
    const assets = new StaticAssets({ mode: "disk", dir: "" }, process.cwd());
    const hello = await assets.handle(
      new Request("http://localhost/nonexistent"),
      new URL("http://localhost/nonexistent"),
    );
    expect(hello).toBeNull();
  });

  test("serves partial content with Range header", async () => {
    const dir = tempDir();
    const content = "0123456789abcdef";
    writeFileSync(join(dir, "range.txt"), content);
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const full = await assets.handle(new Request("http://localhost/range.txt"), new URL("http://localhost/range.txt"));
    expect(full?.status).toBe(200);
    expect(await full?.text()).toBe(content);
    expect(full?.headers.get("accept-ranges")).toBe("bytes");
    expect(full?.headers.get("content-length")).toBe(String(content.length));

    const range = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "bytes=0-4" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(range?.status).toBe(206);
    expect(await range?.text()).toBe("01234");
    expect(range?.headers.get("content-range")).toBe(`bytes 0-4/${content.length}`);
    expect(range?.headers.get("content-length")).toBe("5");

    const suffix = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "bytes=-5" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(suffix?.status).toBe(206);
    expect(await suffix?.text()).toBe("bcdef");
    expect(suffix?.headers.get("content-range")).toBe(`bytes ${content.length - 5}-${content.length - 1}/${content.length}`);
    expect(suffix?.headers.get("content-length")).toBe("5");

    const middle = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "bytes=3-8" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(middle?.status).toBe(206);
    expect(await middle?.text()).toBe("345678");
    expect(middle?.headers.get("content-range")).toBe(`bytes 3-8/${content.length}`);
    expect(middle?.headers.get("content-length")).toBe("6");

    const headRange = await assets.handle(
      new Request("http://localhost/range.txt", { method: "HEAD", headers: { range: "bytes=0-4" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(headRange?.status).toBe(206);
    expect(await headRange?.text()).toBe("");
    expect(headRange?.headers.get("content-range")).toBe(`bytes 0-4/${content.length}`);
    expect(headRange?.headers.get("content-length")).toBe("5");

    const ifNoneMatch = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { "if-none-match": full?.headers.get("etag")! } }),
      new URL("http://localhost/range.txt"),
    );
    expect(ifNoneMatch?.status).toBe(304);

    const rangeIfNoneMatch = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "bytes=0-4", "if-none-match": full?.headers.get("etag")! } }),
      new URL("http://localhost/range.txt"),
    );
    expect(rangeIfNoneMatch?.status).toBe(304);
  });

  test("serves partial content for embedded assets with Range header", async () => {
    const content = "0123456789abcdef";
    const assets = new StaticAssets(
      { mode: "embedded", assets: { "/range.txt": content } },
      process.cwd(),
    );

    const full = await assets.handle(
      new Request("http://localhost/range.txt"),
      new URL("http://localhost/range.txt"),
    );
    expect(full?.status).toBe(200);
    expect(await full?.text()).toBe(content);

    const range = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "bytes=0-4" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(range?.status).toBe(206);
    expect(await range?.text()).toBe("01234");
    expect(range?.headers.get("content-range")).toBe(`bytes 0-4/${content.length}`);
    expect(range?.headers.get("content-length")).toBe("5");

    const unsatisfiable = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "bytes=100-" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(unsatisfiable?.status).toBe(416);
    expect(unsatisfiable?.headers.get("content-range")).toBe(`bytes */${content.length}`);
  });

  test("rejects invalid Range headers", async () => {
    const dir = tempDir();
    const content = "0123456789";
    writeFileSync(join(dir, "range.txt"), content);
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    for (const range of ["bytes=5-0", "bytes=-", "bytes=abc-def", "bytes=-0", "bytes=0-4,5-6,7-8,9-10,11-12,13-14,15-16,17-18,19-20,21-22,23-24"]) {
      const response = await assets.handle(
        new Request("http://localhost/range.txt", { headers: { range } }),
        new URL("http://localhost/range.txt"),
      );
      expect(response?.status).toBe(200);
      expect(await response?.text()).toBe(content);
    }
  });

  test("responds with 416 for unsatisfiable ranges", async () => {
    const dir = tempDir();
    const content = "0123456789";
    writeFileSync(join(dir, "range.txt"), content);
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    for (const range of ["bytes=10-", "bytes=20-30", "bytes=100-"]) {
      const response = await assets.handle(
        new Request("http://localhost/range.txt", { headers: { range } }),
        new URL("http://localhost/range.txt"),
      );
      expect(response?.status).toBe(416);
      expect(response?.headers.get("content-range")).toBe(`bytes */${content.length}`);
      expect(response?.headers.get("content-length")).toBe("0");
      expect(await response?.text()).toBe("");
    }

    const head = await assets.handle(
      new Request("http://localhost/range.txt", { method: "HEAD", headers: { range: "bytes=50-" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(head?.status).toBe(416);
    expect(head?.headers.get("content-range")).toBe(`bytes */${content.length}`);
    expect(await head?.text()).toBe("");
  });

  test("responds with 416 for unsatisfiable ranges of embedded assets", async () => {
    const assets = new StaticAssets({
      mode: "embedded",
      assets: { "/range.txt": "0123456789" },
    });

    const response = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "bytes=10-" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(response?.status).toBe(416);
    expect(response?.headers.get("content-range")).toBe("bytes */10");
    expect(await response?.text()).toBe("");
  });

  test("serves partial content from embedded assets", async () => {
    const content = "0123456789abcdef";
    const assets = new StaticAssets({
      mode: "embedded",
      assets: { "/range.txt": content },
    });

    const full = await assets.handle(new Request("http://localhost/range.txt"), new URL("http://localhost/range.txt"));
    expect(full?.status).toBe(200);
    expect(await full?.text()).toBe(content);

    const range = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "bytes=0-4" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(range?.status).toBe(206);
    expect(await range?.text()).toBe("01234");
    expect(range?.headers.get("content-range")).toBe(`bytes 0-4/${content.length}`);
    expect(range?.headers.get("content-length")).toBe("5");
  });

  test("clamps range ends beyond the representation size", async () => {
    const dir = tempDir();
    const content = "0123456789";
    writeFileSync(join(dir, "range.txt"), content);
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const clamped = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "bytes=5-100" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(clamped?.status).toBe(206);
    expect(await clamped?.text()).toBe("56789");
    expect(clamped?.headers.get("content-range")).toBe(`bytes 5-9/${content.length}`);
    expect(clamped?.headers.get("content-length")).toBe("5");

    const clampedHead = await assets.handle(
      new Request("http://localhost/range.txt", { method: "HEAD", headers: { range: "bytes=5-100" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(clampedHead?.status).toBe(206);
    expect(await clampedHead?.text()).toBe("");
    expect(clampedHead?.headers.get("content-range")).toBe(`bytes 5-9/${content.length}`);
    expect(clampedHead?.headers.get("content-length")).toBe("5");
  });

  test("clamps range ends beyond the size of embedded assets", async () => {
    const assets = new StaticAssets({
      mode: "embedded",
      assets: { "/range.txt": "0123456789" },
    });

    const clamped = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "bytes=8-99" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(clamped?.status).toBe(206);
    expect(await clamped?.text()).toBe("89");
    expect(clamped?.headers.get("content-range")).toBe("bytes 8-9/10");
    expect(clamped?.headers.get("content-length")).toBe("2");
  });

  test("returns a clean 304 for conditional range requests", async () => {
    const dir = tempDir();
    const content = "0123456789abcdef";
    writeFileSync(join(dir, "range.txt"), content);
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const full = await assets.handle(new Request("http://localhost/range.txt"), new URL("http://localhost/range.txt"));
    const etag = full?.headers.get("etag")!;
    expect(etag).toBeTruthy();

    const conditional = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "bytes=0-4", "if-none-match": etag } }),
      new URL("http://localhost/range.txt"),
    );
    expect(conditional?.status).toBe(304);
    expect(conditional?.headers.get("etag")).toBe(etag);
    expect(conditional?.headers.get("content-range")).toBeNull();
    expect(conditional?.headers.get("content-length")).toBe(String(content.length));
    expect(await conditional?.text()).toBe("");
  });

  test("rejects invalid static options instead of silently accepting them", () => {
    expect(() => new StaticAssets({ mode: "bogus" as never })).toThrow(/Invalid static mode/);
    expect(() => new StaticAssets({ spaFallback: "yes" as never })).toThrow(/Invalid static SPA fallback/);
    expect(() => new StaticAssets({ dir: 42 as never })).toThrow(/Invalid static directory/);
    expect(() => new StaticAssets({ assets: [] as never })).toThrow(/Invalid static assets mapping/);
    expect(() => new StaticAssets({ assets: { "/a.txt": null as never } })).toThrow(
      /Invalid static asset payload for \/a\.txt/,
    );
    expect(() => new StaticAssets({ assets: { "/a.txt": { data: 1 } as never } })).toThrow(
      /Invalid static asset payload for \/a\.txt/,
    );
    expect(() => new StaticAssets({ assets: { "/a.txt": { data: "x", encoding: "gzip" as never } } })).toThrow(
      /Invalid static asset payload for \/a\.txt/,
    );
    expect(() => new StaticAssets({ assets: { "/a.txt": { data: "x", type: 5 as never } } })).toThrow(
      /Invalid static asset payload for \/a\.txt/,
    );
    expect(() => new StaticAssets({ assets: { "/a.txt": { data: "x", etag: 5 as never } } })).toThrow(
      /Invalid static asset payload for \/a\.txt/,
    );
    expect(() => new StaticAssets({ cache: "none" as never })).toThrow(/Invalid static cache/);
    expect(() => new StaticAssets({ cache: { immutableExtensions: [""] } })).toThrow(
      /Invalid immutable extensions/,
    );
    expect(() => new StaticAssets({ cache: { immutableExtensions: "js" as never } })).toThrow(
      /Invalid immutable extensions/,
    );
    expect(() => new StaticAssets({ cache: { defaultMaxAgeSeconds: -1 } })).toThrow(
      /Invalid static max age/,
    );
    expect(() => new StaticAssets({ cache: { defaultMaxAgeSeconds: 1.5 } })).toThrow(
      /Invalid static max age/,
    );
    expect(() => new StaticAssets({ cache: { defaultMaxAgeSeconds: 31536001 } })).toThrow(
      /Invalid static max age/,
    );
    expect(() => new StaticAssets(null as never)).toThrow(/Invalid static assets configuration/);
  });

  test("accepts valid static options", () => {
    expect(() => new StaticAssets({ mode: "off" })).not.toThrow();
    expect(() => new StaticAssets({ mode: "disk", dir: "public", spaFallback: true })).not.toThrow();
    expect(() =>
      new StaticAssets({
        mode: "embedded",
        assets: {
          "/a.txt": "text",
          "/b.bin": new Uint8Array([1, 2, 3]),
          "/c.bin": new ArrayBuffer(4),
          "/d.txt": { data: "text", encoding: "utf8", type: "text/plain", etag: '"abc"' },
          "/e.bin": { data: "AAEC", encoding: "base64" },
        },
        cache: { immutableExtensions: [".JS", " css "], defaultMaxAgeSeconds: 0 },
      }),
    ).not.toThrow();
  });

  test("app.static rejects invalid options", async () => {
    const app = await createMuboApp(
      {
        app: { name: "static-invalid-options-test", env: "test" },
        db: { path: ":memory:" },
        log: { level: "error" },
        static: { mode: "off" },
      },
      { argv: [] },
    );
    expect(() => app.static({ mode: "bogus" as never })).toThrow(/Invalid static mode/);
    expect(() => app.static({ cache: { defaultMaxAgeSeconds: -5 } })).toThrow(/Invalid static max age/);
    expect(app.static({ mode: "off" })).toBe(app);
  });
});
