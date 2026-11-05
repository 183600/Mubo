import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  BUILD_CONFIG_KEY,
  loadConfigFile,
  resolveConfig,
  sanitizeAppName,
  type MuboConfig,
} from "../core/config.ts";
import { MuboError } from "../core/errors.ts";
import { EMBEDDED_ASSETS_KEY, mimeTypeForExtension } from "../static/assets.ts";
import { findEntry } from "./project.ts";

export interface BuildOptions {
  cwd?: string;
  entry?: string;
  outfile?: string;
  staticDir?: string;
  target?: string;
  minify?: boolean;
  configFile?: string;
  env?: Record<string, string | undefined>;
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findStaticDir(
  cwd: string,
  config: MuboConfig,
  resolved: { mode: "embedded" | "disk" | "off"; dir: string },
  envDir: string | undefined,
  requested?: string,
): string | undefined {
  if (requested) {
    const absolute = resolve(cwd, requested);
    if (!isDirectory(absolute)) throw new MuboError("CONFIG_ERROR", `Static directory not found: ${absolute}`);
    return absolute;
  }
  if (resolved.mode === "off") return undefined;
  const configuredDir = envDir || config.static?.dir?.trim();
  const absolute = resolve(cwd, resolved.dir);
  if (isDirectory(absolute)) return absolute;
  if (configuredDir) {
    if (resolve(cwd, configuredDir) === resolve(cwd, "public")) {
      const fallback = resolve(cwd, "dist/client");
      if (isDirectory(fallback)) return fallback;
      return undefined;
    }
    throw new MuboError("CONFIG_ERROR", `Static directory not found: ${absolute}`);
  }
  const fallback = resolve(cwd, "dist/client");
  if (isDirectory(fallback)) return fallback;
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
      type: mimeTypeForExtension(ext) ?? "application/octet-stream",
    };
  }
  return assets;
}

function importPath(fromDir: string, toFile: string): string {
  let value = relative(fromDir, toFile).split(sep).join("/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

/**
 * Computes the path of the compiled executable.
 *
 * Windows builds use the `.exe` suffix, either because the target is a Windows
 * runtime or because the build runs on Windows itself.
 */
export function resolveBuildOutfile(
  cwd: string,
  options: { outfile?: string; target?: string; platform?: string } = {},
  name = "app",
): string {
  const platform = options.platform ?? process.platform;
  const outfile = options.outfile ? resolve(cwd, options.outfile) : join(cwd, "dist", name);
  const needsExe =
    options.target?.toLowerCase().includes("windows") || (!options.target && platform === "win32");
  if (needsExe && !outfile.toLowerCase().endsWith(".exe")) return `${outfile}.exe`;
  return outfile;
}

export async function buildProject(options: BuildOptions = {}): Promise<BuildResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const entry = findEntry(cwd, options.entry);
  const loaded = await loadConfigFile(cwd, options.configFile).catch((error: unknown) => {
    throw error instanceof MuboError
      ? error
      : new MuboError("CONFIG_ERROR", "Failed to load project config", { cause: error });
  });
  const config: MuboConfig = loaded.config;

  const env = options.env ?? process.env;
  const resolved = resolveConfig(
    options.staticDir === undefined ? {} : { static: { dir: options.staticDir } },
    { cwd, env, argv: [], fileConfig: config },
  );
  const envStaticDir = env.MUBO_STATIC_DIR?.trim() || undefined;
  const staticDir = findStaticDir(cwd, config, resolved.static, envStaticDir, options.staticDir);
  const assets = staticDir ? await collectAssets(staticDir) : {};
  const assetCount = Object.keys(assets).length;
  const generatedDir = join(cwd, ".mubo");
  mkdirSync(generatedDir, { recursive: true });

  const name = sanitizeAppName(
    env.MUBO_APP_NAME?.trim() || config.app?.name || (await packageName(cwd)) || basename(cwd),
  );
  const outfile = resolveBuildOutfile(cwd, options, name);
  if (outfile === entry) {
    throw new MuboError("CONFIG_ERROR", `Output path must not overwrite the entry: ${outfile}`);
  }
  const outputDir = dirname(outfile);
  if (existsSync(outputDir) && !isDirectory(outputDir)) {
    throw new MuboError("CONFIG_ERROR", `Output directory is not a directory: ${outputDir}`);
  }
  if (existsSync(outfile) && isDirectory(outfile)) {
    throw new MuboError("CONFIG_ERROR", `Output path is a directory: ${outfile}`);
  }
  mkdirSync(outputDir, { recursive: true });

  const manifestPath = join(generatedDir, "embedded-assets.ts");
  const buildConfigPath = join(generatedDir, "build-config.ts");
  const wrapperPath = join(generatedDir, "build-entry.ts");
  await Bun.write(
    manifestPath,
    `(globalThis as Record<string, unknown>)[${JSON.stringify(EMBEDDED_ASSETS_KEY)}] = ${JSON.stringify(assets)};\n`,
  );
  // The project configuration is baked into the binary so compiled apps keep
  // the settings they were built with instead of depending on a config file
  // in the working directory.
  await Bun.write(
    buildConfigPath,
    loaded.path
      ? `import config from ${JSON.stringify(importPath(generatedDir, loaded.path))};\n` +
        `(globalThis as Record<string, unknown>)[${JSON.stringify(BUILD_CONFIG_KEY)}] = config;\n`
      : `(globalThis as Record<string, unknown>)[${JSON.stringify(BUILD_CONFIG_KEY)}] = {};\n`,
  );
  const imports = [`import ${JSON.stringify(importPath(generatedDir, manifestPath))};`];
  imports.push(`import ${JSON.stringify(importPath(generatedDir, buildConfigPath))};`);
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