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

/** Minimum Bun runtime supported by the framework (mirrors package.json engines). */
export const MINIMUM_BUN_VERSION = "1.2.0";

function versionParts(value: string): number[] {
  const parts: number[] = [];
  for (const part of value.trim().split(/[.+-]/)) {
    if (!/^\d+$/.test(part)) break;
    parts.push(Number(part));
  }
  return parts;
}

/** Compare two dotted versions numerically; returns -1, 0 or 1. */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** Whether the given Bun version satisfies the minimum supported runtime. */
export function satisfiesMinimumBunVersion(
  version: string,
  minimum: string = MINIMUM_BUN_VERSION,
): boolean {
  return compareVersions(version, minimum) >= 0;
}

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