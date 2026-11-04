#!/usr/bin/env bun
import { errorMessage, MuboError } from "../core/errors.ts";
import { boolFlag, parseCliArgs, stringFlag } from "./args.ts";
import { buildProject } from "./build.ts";
import { devCommand, doctorCommand, migrateCommand } from "./commands.ts";
import { initProject } from "./init.ts";
import { frameworkPackage } from "./project.ts";

const HELP = `mubo - Bun-first hyper-monolith framework

Usage:
  mubo init <dir> [--force] [--install]
  mubo dev [--entry <file>] [--port <port>] [--host <host>] [--data-dir <dir>]
           [--db <path>] [--static-dir <dir>] [--log-level <level>] [--config <file>]
           [--request-timeout <ms>] [--no-static] [--no-ws]
  mubo build [--entry <file>] [--outfile <file>] [--static-dir <dir>] [--target <target>]
             [--minify] [--config <file>]
  mubo migrate [--check] [--config <file>] [--data-dir <dir>]
  mubo doctor [--json] [--config <file>]
  mubo --version

Environment:
  MUBO_HOST, MUBO_PORT, MUBO_DATA_DIR, MUBO_DB_PATH, MUBO_ENV, MUBO_APP_NAME
  MUBO_LOG_LEVEL, MUBO_LOG_JSON, MUBO_BODY_LIMIT, MUBO_REQUEST_TIMEOUT_MS
  MUBO_STATIC_MODE, MUBO_STATIC_DIR, MUBO_WS_ENABLED, MUBO_MIGRATIONS_MODE
`;

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (boolFlag(args, "version")) {
    const framework = await frameworkPackage();
    console.log(framework.version ?? "unknown");
    return;
  }
  if (!args.command || args.command === "help" || boolFlag(args, "help") || args.command === "--help") {
    console.log(HELP);
    return;
  }
  const cwd = process.cwd();

  switch (args.command) {
    case "init": {
      const target = args.positionals[0];
      if (!target) throw new MuboError("CONFIG_ERROR", "Usage: mubo init <dir>");
      const dir = await initProject(target, {
        cwd,
        force: boolFlag(args, "force"),
        install: boolFlag(args, "install"),
      });
      console.log(`[mubo] created ${dir}`);
      console.log("Next steps:");
      console.log(`  cd ${target}`);
      if (!boolFlag(args, "install")) console.log("  bun install");
      console.log("  bun run dev");
      break;
    }
    case "dev":
      await devCommand({ cwd, args });
      break;
    case "build": {
      const result = await buildProject({
        cwd,
        entry: stringFlag(args, "entry"),
        outfile: stringFlag(args, "outfile"),
        staticDir: stringFlag(args, "static-dir"),
        target: stringFlag(args, "target"),
        minify: boolFlag(args, "minify"),
        configFile: stringFlag(args, "config"),
      });
      console.log(`[mubo] built ${result.outfile}`);
      console.log(
        `[mubo] embedded ${result.assets} static asset(s)${result.staticDir ? ` from ${result.staticDir}` : ""}`,
      );
      break;
    }
    case "migrate":
      await migrateCommand({ cwd, args });
      break;
    case "doctor":
      await doctorCommand({ cwd, args });
      break;
    default:
      throw new MuboError("CONFIG_ERROR", `Unknown command: ${args.command}\n\n${HELP}`);
  }
}

main().catch((error) => {
  const message = errorMessage(error);
  console.error(`[mubo] ${message}`);
  if (!(error instanceof MuboError) && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});