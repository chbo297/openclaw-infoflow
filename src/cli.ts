#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

type CliOptions = {
  version: string;
  registry: string;
  channelId: string;
  dryRun: boolean;
  sourceDir?: string;
};

const DEFAULT_REGISTRY = "http://registry.npm.baidu-int.com";

function printHelp(): void {
  console.log(`Usage:
  npx -y @chbo297/infoflow update [options]

Commands:
  update                 Download and install/update Infoflow plugin

Options:
  --version <version>    Package version (default: latest)
  --registry <url>       npm registry URL (default: npm_config_registry or ${DEFAULT_REGISTRY})
  --channel-id <id>      OpenClaw channel/plugin id (default: infoflow)
  --dry-run              Print commands without changing system
  --source-dir <path>    Internal use: deploy directly from local source directory
  -h, --help             Show help
`);
}

function runOrFail(command: string, args: string[], cwd: string, dryRun: boolean): void {
  const line = [command, ...args].join(" ");
  console.log(`$ (${cwd}) ${line}`);
  if (dryRun) return;
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runAndCollect(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

function parseArgs(argv: string[]): { command: string; options: CliOptions } {
  const args = [...argv];
  const command = args.shift() ?? "";
  const options: CliOptions = {
    version: "latest",
    registry: process.env.npm_config_registry || DEFAULT_REGISTRY,
    channelId: "infoflow",
    dryRun: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--version") options.version = args[++i] ?? options.version;
    else if (value === "--registry") options.registry = args[++i] ?? options.registry;
    else if (value === "--channel-id") options.channelId = args[++i] ?? options.channelId;
    else if (value === "--source-dir") options.sourceDir = args[++i];
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "-h" || value === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown option: ${value}`);
      printHelp();
      process.exit(1);
    }
  }

  return { command, options };
}

function installFromRegistry(options: CliOptions, packageName: string, pluginDir: string): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "infoflow-update-"));
  try {
    const spec = `${packageName}@${options.version}`;
    let tarball = "";
    if (options.dryRun) {
      console.log(`$ (${tempRoot}) npm pack ${spec} --registry ${options.registry} --json`);
      tarball = "<generated-by-npm-pack>.tgz";
    } else {
      const output = runAndCollect("npm", ["pack", spec, "--registry", options.registry, "--json"], tempRoot);
      const parsed = JSON.parse(output) as Array<{ filename?: string }>;
      tarball = parsed[0]?.filename ?? "";
      if (!tarball) {
        console.error("Unable to resolve packed tarball filename from npm pack output.");
        process.exit(1);
      }
    }
    runOrFail("tar", ["-xzf", tarball], tempRoot, options.dryRun);
    runOrFail("mkdir", ["-p", pluginDir], tempRoot, options.dryRun);
    runOrFail(
      "rsync",
      ["-av", "--delete", `${join(tempRoot, "package")}/`, `${pluginDir}/`, "--exclude", "node_modules", "--exclude", "dist"],
      tempRoot,
      options.dryRun,
    );
  } finally {
    if (!options.dryRun) rmSync(tempRoot, { recursive: true, force: true });
  }
}

function installFromSource(options: CliOptions, pluginDir: string): void {
  const sourceDir = resolve(options.sourceDir!);
  runOrFail("mkdir", ["-p", pluginDir], sourceDir, options.dryRun);
  runOrFail(
    "rsync",
    [
      "-av",
      "--delete",
      `${sourceDir}/`,
      `${pluginDir}/`,
      "--exclude",
      "node_modules",
      "--exclude",
      "dist",
      "--exclude",
      ".git",
    ],
    sourceDir,
    options.dryRun,
  );
}

function main(): void {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command) {
    printHelp();
    process.exit(0);
  }
  if (command !== "update") {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  const filePath = fileURLToPath(import.meta.url);
  const packageDir = resolve(dirname(filePath), "..", "..");
  const pkg = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as { name?: string };
  const packageName = pkg.name || "@chbo297/infoflow";
  const pluginDir = resolve(process.env.HOME || homedir(), ".openclaw", "extensions", options.channelId);

  if (options.sourceDir) {
    installFromSource(options, pluginDir);
  } else {
    installFromRegistry(options, packageName, pluginDir);
  }

  const commonScriptPath = join(pluginDir, "scripts", "lib", "deploy-common.sh");
  runOrFail(
    "bash",
    [
      commonScriptPath,
      "--plugin-dir",
      pluginDir,
      "--plugin-id",
      options.channelId,
      "--config-file",
      resolve(process.env.HOME || homedir(), ".openclaw", "openclaw.json"),
      "--baidu-registry",
      options.registry,
      ...(options.dryRun ? ["--dry-run"] : []),
    ],
    pluginDir,
    options.dryRun,
  );
}

main();
