import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMuboApp, resolveConfig } from "../src/index.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mubo-bug-test-"));
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("configuration priority bugs", () => {
  test("CLI arguments should override --config file settings", async () => {
    const cwd = tempDir();
    tempDirs.push(cwd);
    
    // Create a config file with a custom port
    writeFileSync(
      join(cwd, "mubo.config.ts"),
      `export default { 
        app: { name: "config-file-app" }, 
        http: { port: 5000 },
        db: { path: ":memory:" },
        static: { mode: "off" }
      };`
    );
    
    const app = await createMuboApp(
      {},
      { cwd, argv: ["--config", "mubo.config.ts", "--port", "6000"], env: {} }
    );
    
    // CLI --port 6000 should override the config file's port 5000
    expect(app.config.http.port).toBe(6000);
    expect(app.config.app.name).toBe("config-file-app");
    
    await app.stop();
  });

  test("explicit --config should override inline config", async () => {
    const cwd = tempDir();
    tempDirs.push(cwd);
    
    writeFileSync(
      join(cwd, "custom.config.ts"),
      `export default { 
        app: { name: "from-explicit-file" }, 
        db: { path: ":memory:" },
        static: { mode: "off" }
      };`
    );
    
    const app = await createMuboApp(
      { app: { name: "from-inline" }, db: { path: ":memory:" }, static: { mode: "off" } },
      { cwd, argv: ["--config", "custom.config.ts"], env: {} }
    );
    
    expect(app.config.app.name).toBe("from-explicit-file");
    
    await app.stop();
  });
});
