import { MuboError } from "../core/errors.ts";

export interface CliArgs {
  command?: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["force", "install", "check", "json", "minify", "no-static", "no-ws", "help"]);

export function parseCliArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    const name = equal === -1 ? token.slice(2) : token.slice(2, equal);
    if (equal !== -1) {
      flags.set(name, token.slice(equal + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags.set(name, next);
      index++;
    } else {
      flags.set(name, true);
    }
  }
  return { command: positionals.shift(), positionals, flags };
}

export function stringFlag(args: CliArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  throw new MuboError("CONFIG_ERROR", `Missing value for --${name}`);
}

export function boolFlag(args: CliArgs, name: string): boolean {
  const value = args.flags.get(name);
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (value.length === 0) throw new MuboError("CONFIG_ERROR", `Missing value for --${name}`);
  throw new MuboError("CONFIG_ERROR", `Invalid boolean value for --${name}: ${value}`);
}
