import { extname, join, resolve, sep } from "node:path";
import type { EmbeddedAsset, EmbeddedAssets } from "../core/config.ts";
import { MuboError } from "../core/errors.ts";
import { textResponse } from "../http/response.ts";

const GLOBAL_ASSETS_KEY = "__MUBO_EMBEDDED_ASSETS__";

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  wasm: "application/wasm",
  map: "application/json; charset=utf-8",
};

export interface StaticAssetsOptions {
  mode?: "embedded" | "disk" | "off";
  dir?: string;
  spaFallback?: boolean;
  assets?: EmbeddedAssets;
  cache?: {
    immutableExtensions?: string[];
    defaultMaxAgeSeconds?: number;
  };
}

function normalizeKey(path: string): string {
  let key = path.startsWith("/") ? path : `/${path}`;
  key = key.replace(/\/+/g, "/");
  if (key.endsWith("/")) key += "index.html";
  return key;
}

function normalizeAssets(assets: EmbeddedAssets | undefined): Map<string, EmbeddedAsset | string | Uint8Array | ArrayBuffer> {
  const map = new Map<string, EmbeddedAsset | string | Uint8Array | ArrayBuffer>();
  if (!assets) return map;
  for (const [key, value] of Object.entries(assets)) {
    map.set(normalizeKey(key), value);
    const decoded = (() => {
      try {
        return normalizeKey(decodeURIComponent(key));
      } catch {
        return key;
      }
    })();
    map.set(decoded, value);
  }
  return map;
}

export function registerEmbeddedAssets(assets: EmbeddedAssets): void {
  (globalThis as Record<string, unknown>)[GLOBAL_ASSETS_KEY] = assets;
}

export function getEmbeddedAssets(): EmbeddedAssets | undefined {
  return (globalThis as Record<string, unknown>)[GLOBAL_ASSETS_KEY] as EmbeddedAssets | undefined;
}

function decodeAsset(asset: EmbeddedAsset | string | Uint8Array | ArrayBuffer): Uint8Array {
  if (asset instanceof Uint8Array) return asset;
  if (asset instanceof ArrayBuffer) return new Uint8Array(asset);
  if (typeof asset === "string") return new TextEncoder().encode(asset);
  if (asset.encoding === "base64" && typeof asset.data === "string") {
    return new Uint8Array(Buffer.from(asset.data, "base64"));
  }
  if (typeof asset.data === "string") return new TextEncoder().encode(asset.data);
  if (asset.data instanceof Uint8Array) return asset.data;
  return new Uint8Array(asset.data);
}

export function mimeTypeForExtension(extension: string): string | undefined {
  const ext = extension.toLowerCase();
  return Object.hasOwn(MIME_TYPES, ext) ? MIME_TYPES[ext] : undefined;
}

function contentTypeFor(path: string): string {
  return mimeTypeForExtension(extname(path).slice(1)) ?? "application/octet-stream";
}

function hasContentHash(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /[.-][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(name);
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((part) => part === "*" || part === etag);
}

function isHead(request: Request): boolean {
  return request.method.toUpperCase() === "HEAD";
}

export class StaticAssets {
  private mode: "embedded" | "disk" | "off";
  private root: string;
  private spaFallback: boolean;
  private assets: Map<string, EmbeddedAsset | string | Uint8Array | ArrayBuffer>;
  private immutableExtensions: Set<string>;
  private defaultMaxAgeSeconds: number;

  constructor(options: StaticAssetsOptions = {}, cwd = process.cwd()) {
    this.mode = options.mode ?? "disk";
    this.root = resolve(cwd, options.dir || "public");
    this.spaFallback = options.spaFallback ?? true;
    const globalAssets = getEmbeddedAssets();
    this.assets = normalizeAssets(options.assets ?? globalAssets);
    this.immutableExtensions = new Set(options.cache?.immutableExtensions ?? []);
    this.defaultMaxAgeSeconds = options.cache?.defaultMaxAgeSeconds ?? 3600;
  }

  configure(options: StaticAssetsOptions = {}, cwd = process.cwd()): this {
    if (options.mode !== undefined) this.mode = options.mode;
    if (options.dir !== undefined) this.root = resolve(cwd, options.dir || "public");
    if (options.spaFallback !== undefined) this.spaFallback = options.spaFallback;
    if (options.assets !== undefined) this.assets = normalizeAssets(options.assets);
    if (options.cache?.immutableExtensions !== undefined) {
      this.immutableExtensions = new Set(options.cache.immutableExtensions);
    }
    if (options.cache?.defaultMaxAgeSeconds !== undefined) {
      this.defaultMaxAgeSeconds = options.cache.defaultMaxAgeSeconds;
    }
    return this;
  }

  get enabled(): boolean {
    return this.mode !== "off";
  }

  private cacheControl(path: string): string {
    if (path.endsWith(".html")) return "no-cache";
    const ext = extname(path).slice(1).toLowerCase();
    if (this.immutableExtensions.has(ext) && hasContentHash(path)) {
      return "public, max-age=31536000, immutable";
    }
    return `public, max-age=${this.defaultMaxAgeSeconds}`;
  }

  private respond(
    request: Request,
    path: string,
    body: Uint8Array | Bun.BunFile,
    etag: string,
    contentType: string,
    size: number,
    extraHeaders?: Record<string, string> | Headers,
  ): Response {
    const headers = new Headers(extraHeaders as any);
    headers.set("etag", etag);
    headers.set("cache-control", this.cacheControl(path));
    headers.set("content-type", contentType);
    headers.set("content-length", String(size));
    if (etagMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    if (isHead(request)) return new Response(null, { status: 200, headers });
    return new Response(body, { status: 200, headers });
  }

  private findEmbedded(
    pathname: string,
    allowSpaFallback = true,
  ): { asset: EmbeddedAsset | string | Uint8Array | ArrayBuffer; path: string } | null {
    let key = normalizeKey(pathname);
    try {
      key = normalizeKey(decodeURIComponent(pathname));
    } catch {
      throw new MuboError("BAD_REQUEST", `Malformed percent-encoding in URL: ${pathname}`);
    }
    if (key.includes("\0")) {
      throw new MuboError("BAD_REQUEST", `Invalid NUL byte in URL: ${pathname}`);
    }
    const exact = this.assets.get(key);
    if (exact !== undefined) return { asset: exact, path: key };

    const directoryIndex = normalizeKey(`${key}/index.html`);
    const index = this.assets.get(directoryIndex);
    if (index !== undefined) return { asset: index, path: directoryIndex };

    if (allowSpaFallback && this.spaFallback) {
      const fallback = this.assets.get("/index.html");
      if (fallback !== undefined) return { asset: fallback, path: "/index.html" };
    }
    return null;
  }

  private async embeddedResponse(
    request: Request,
    pathname: string,
    allowSpaFallback = true,
  ): Promise<Response | null> {
    let found: ReturnType<StaticAssets["findEmbedded"]>;
    try {
      found = this.findEmbedded(pathname, allowSpaFallback);
    } catch {
      return textResponse("Bad Request", { status: 400 });
    }
    if (!found) return null;
    const { asset, path: finalPath } = found;

    const bytes = decodeAsset(asset);
    const type =
      typeof asset === "object" && !(asset instanceof Uint8Array) && !(asset instanceof ArrayBuffer)
        ? asset.type
        : undefined;
    const etag =
      typeof asset === "object" && !(asset instanceof Uint8Array) && !(asset instanceof ArrayBuffer) && asset.etag
        ? asset.etag
        : `"${new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 20)}"`;
    return this.respond(request, finalPath, bytes, etag, type ?? contentTypeFor(finalPath), bytes.byteLength);
  }

  private safeDiskPath(pathname: string): { path: string; directory: boolean; error?: Response } {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return { path: "", directory: false, error: textResponse("Bad Request", { status: 400 }) };
    }
    if (decoded.includes("\0")) {
      return { path: "", directory: false, error: textResponse("Bad Request", { status: 400 }) };
    }
    const relativePath = decoded.replace(/^\/+/, "").replace(/\\/g, "/");
    const directory = relativePath === "" || relativePath.endsWith("/");
    const target = resolve(this.root, relativePath || ".");
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) {
      return { path: "", directory: false, error: textResponse("Forbidden", { status: 403 }) };
    }
    return { path: target, directory };
  }

  private async diskResponse(request: Request, pathname: string): Promise<Response | null> {
    const resolved = this.safeDiskPath(pathname);
    if (resolved.error) return resolved.error;
    let target = resolved.directory ? join(resolved.path, "index.html") : resolved.path;
    let file = Bun.file(target);
    let exists = await file.exists();
    if (!exists && !resolved.directory) {
      const directoryIndex = join(resolved.path, "index.html");
      const candidate = Bun.file(directoryIndex);
      if (await candidate.exists()) {
        target = directoryIndex;
        file = candidate;
        exists = true;
      }
    }
    if (!exists) {
      if (!this.spaFallback) return null;
      const fallback = join(this.root, "index.html");
      const candidate = Bun.file(fallback);
      if (!(await candidate.exists())) return null;
      target = fallback;
      file = candidate;
    }
    const etag = `"${file.size.toString(16)}-${Math.round(file.lastModified).toString(16)}"`;
    const extensionType = mimeTypeForExtension(extname(target).slice(1));
    const contentType = extensionType ?? (file.type || "application/octet-stream");
    return this.respond(request, target, file, etag, contentType, file.size);
  }

  async handle(request: Request, url: URL): Promise<Response | null> {
    if (!this.enabled) return null;
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return null;
    if (this.assets.size > 0 && (this.mode === "embedded" || this.mode === "disk")) {
      const response = await this.embeddedResponse(request, url.pathname, this.mode === "embedded");
      if (response) return response;
      if (this.mode === "embedded") return null;
    }
    if (this.mode === "disk" || (this.mode === "embedded" && this.assets.size === 0)) {
      return this.diskResponse(request, url.pathname);
    }
    return null;
  }

  async hasFile(pathname: string): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.assets.size > 0) {
      try {
        const found = this.findEmbedded(pathname);
        if (found && found.path !== "/index.html") return true;
        if (found && normalizeKey(pathname) === "/index.html") return true;
      } catch {
        return false;
      }
    }
    if (this.mode !== "disk") return false;
    const resolved = this.safeDiskPath(pathname);
    if (resolved.error) return false;
    const target = resolved.directory ? join(resolved.path, "index.html") : resolved.path;
    if (await Bun.file(target).exists()) return true;
    return !resolved.directory && (await Bun.file(join(resolved.path, "index.html")).exists());
  }
}

export { MIME_TYPES, normalizeKey };
