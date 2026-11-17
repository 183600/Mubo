import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticAssets } from "../src/index.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mubo-range-unit-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Range header units", () => {
  test("treats the bytes range unit case-insensitively for disk assets", async () => {
    const dir = tempDir();
    const content = "0123456789";
    writeFileSync(join(dir, "range.txt"), content);
    const assets = new StaticAssets({ mode: "disk", dir }, dir);
    const url = new URL("http://localhost/range.txt");

    for (const range of ["Bytes=0-4", "BYTES=0-4", "bYtEs=0-4"]) {
      const response = await assets.handle(
        new Request("http://localhost/range.txt", { headers: { range } }),
        url,
      );
      expect(response?.status).toBe(206);
      expect(await response?.text()).toBe("01234");
      expect(response?.headers.get("content-range")).toBe(`bytes 0-4/${content.length}`);
      expect(response?.headers.get("content-length")).toBe("5");
    }
  });

  test("treats the bytes range unit case-insensitively for embedded assets", async () => {
    const content = "0123456789abcdef";
    const assets = new StaticAssets(
      { mode: "embedded", assets: { "/range.txt": content } },
      process.cwd(),
    );
    const url = new URL("http://localhost/range.txt");

    const response = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "BYTES=8-" } }),
      url,
    );
    expect(response?.status).toBe(206);
    expect(await response?.text()).toBe("89abcdef");
    expect(response?.headers.get("content-range")).toBe(`bytes 8-15/${content.length}`);
  });

  test("still ignores unsupported range units", async () => {
    const dir = tempDir();
    const content = "0123456789";
    writeFileSync(join(dir, "range.txt"), content);
    const assets = new StaticAssets({ mode: "disk", dir }, dir);

    const response = await assets.handle(
      new Request("http://localhost/range.txt", { headers: { range: "items=0-4" } }),
      new URL("http://localhost/range.txt"),
    );
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe(content);
  });
});
