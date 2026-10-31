import { statSync } from "node:fs";
import { resolve } from "node:path";
import { MuboError } from "../core/errors.ts";

export const ENTRY_CANDIDATES = [
  "src/server/index.ts",
  "src/server/index.js",
  "src/index.ts",
  "src/index.js",
  "server.ts",
  "server.js",
  "index.ts",
  "index.js",
];

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findEntry(cwd: string, requested?: string): string {
  const candidates = requested ? [requested] : ENTRY_CANDIDATES;
  for (const candidate of candidates) {
    const absolute = resolve(cwd, candidate);
    if (isFile(absolute)) return absolute;
  }
  throw new MuboError(
    "CONFIG_ERROR",
    `Cannot find app entry${requested ? `: ${requested}` : ` (tried ${ENTRY_CANDIDATES.join(", ")})`}`,
  );
}
