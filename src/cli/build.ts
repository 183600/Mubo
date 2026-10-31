import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { sanitizeAppName } from "../core/config.ts";
import { MuboError } from "../core/errors.ts";
import { loadConfigFile, type MuboConfig } from "../core/config.ts";
import { MIME_TYPES } from "../static/assets.ts";

export interface BuildOptions {
  cwd?: string;
  entry?: string;
  outfile?: string;
  staticDir?: string;
  target?: string;
  minify?: boolean;
  configFile?: string;
}

export interface BuildResult {
  outfile: string;
  entry: string;
  staticDir?: string;
  assets: number;
}

async function packageName(cwd: string): Promise<string | undefined> {
  try {
    const file = Bun.file(join(cwd, "package.json"));
    if (!(await file.exists())) return undefined;
    const pkg = (await file.json()) as { name?: unknown };
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

function findEntry(cwd: string, requested?: string): string {
  const candidates = requested
    ? [requested]
    : ["src/server/index.ts", "src/index.ts", "server.ts", "index.ts"];
  for (const candidate of candidates) {
    const absolute = resolve(cwd, candidate);
    if (existsSync(absolute)) return absolute;
  }
  throw new MuboError(
    "CONFIG_ERROR",
    `Cannot find app entry${requested ? `: ${requested}` : " (tried src/server/index.ts, src/index.ts, server.ts, index.ts)"}`,
  );
}

function findStaticDir(cwd: string, config: MuboConfig, requested?: string): string | undefined {
  if (requested) {
    const absolute = resolve(cwd, requested);
    if (!existsSync(absolute)) throw new MuboError("CONFIG_ERROR", `Static directory not found: ${absolute}`);
    return absolute;
  }
  if (config.static?.mode === "off") return undefined;
  if (config.static?.dir) {
    const absolute = resolve(cwd, config.static.dir);
    if (existsSync(absolute)) return absolute;
    if (config.static.dir === "public") {
      const fallback = resolve(cwd, "dist/client");
      if (existsSync(fallback)) return fallback;
    }
    return undefined;
  }
  for (const candidate of ["public", "dist/client"]) {
    const absolute = resolve(cwd, candidate);
    if (existsSync(absolute)) return absolute;
  }
  return undefined;
}

async function collectAssets(root: string): Promise<Record<string, { data: string; encoding: "base64"; type: string }>> {
  const files: string[] = [];
  const glob = new Bun.Glob("**/*");
  for await (const file of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
    files.push(file);
  }
  files.sort();
  const assets: Record<string, { data: string; encoding: "base64"; type: string }> = {};
  for (const file of files) {
    const path = join(root, file);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const key = `/${file.split(sep).join("/")}`;
    const ext = extname(file).slice(1).toLowerCase();
    assets[key] = {
      data: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
      type: MIME_TYPES[ext] ?? "application/octet-stream",
    };
  }
  return assets;
}

function importPath(fromDir: string, toFile: string): string {
  let value = relative(fromDir, toFile).split(sep).join("/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

export async function buildProject(options: BuildOptions = {}): Promise<BuildResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const entry = findEntry(cwd, options.entry);
  let config: MuboConfig = {};
  try {
    const loaded = await loadConfigFile(cwd, options.configFile);
    config = loaded.config;
  } catch (error) {
    throw error instanceof MuboError ? error : new MuboError("CONFIG_ERROR", "Failed to load project config", { cause: error });
  }

  const staticDir = findStaticDir(cwd, config, options.staticDir);
  const assets = staticDir ? await collectAssets(staticDir) : {};
  const assetCount = Object.keys(assets).length;
  const generatedDir = join(cwd, ".mubo");
  mkdirSync(generatedDir, { recursive: true });

  const name = sanitizeAppName(config.app?.name ?? (await packageName(cwd)) ?? basename(cwd));
  let outfile = options.outfile ? resolve(cwd, options.outfile) : join(cwd, "dist", name);
  const needsExe = options.target?.includes("windows") || (!options.target && process.platform === "win32");
  if (needsExe && !outfile.endsWith(".exe")) outfile += ".exe";
  mkdirSync(dirname(outfile), { recursive: true });

  const manifestPath = join(generatedDir, "embedded-assets.ts");
  const wrapperPath = join(generatedDir, "build-entry.ts");
  await Bun.write(
    manifestPath,
    `(globalThis as Record<string, unknown>).__MUBO_EMBEDDED_ASSETS__ = ${JSON.stringify(assets)};\n`,
  );
  const imports = [`import ${JSON.stringify(importPath(generatedDir, manifestPath))};`];
  imports.push(`import ${JSON.stringify(importPath(generatedDir, entry))};`);
  await Bun.write(wrapperPath, `${imports.join("\n")}\n`);

  rmSync(outfile, { force: true });
  const command = ["bun", "build", wrapperPath, "--compile", `--outfile=${outfile}`];
  if (options.target) command.push(`--target=${options.target}`);
  if (options.minify) command.push("--minify");
  const proc = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new MuboError("CONFIG_ERROR", `bun build failed with exit code ${exitCode}`);
  }
  if (!existsSync(outfile)) {
    throw new MuboError("CONFIG_ERROR", `Build finished without producing ${outfile}`);
  }
  return { outfile, entry, staticDir, assets: assetCount };
}
