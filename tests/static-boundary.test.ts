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
});
