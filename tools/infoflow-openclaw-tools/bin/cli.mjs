#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_PLUGIN_SPEC = "@chbo297/infoflow";
const DEFAULT_BAIDU_REGISTRY = "http://registry.npm.baidu-int.com";
const DEFAULT_PLUGIN_REGISTRY = "https://registry.npmjs.org";

function printHelp() {
  console.log(`Usage:
  npx -y @chbo297/infoflow-openclaw-tools update [options]

Commands:
  update                       Install/update plugin into OpenClaw extensions

Options:
  --version <version>          Plugin version (default: latest)
  --registry <url>             Registry for plugin package (default: npmjs)
  --baidu-registry <url>       Registry for baidu optional dependency
  --plugin-spec <spec>         Plugin package spec (default: ${DEFAULT_PLUGIN_SPEC})
  --channel-id <id>            Extension directory/channel id (default: infoflow)
  --dry-run                    Print actions without writing files
  -h, --help                   Show help
`);
}

function runOrFail(command, args, cwd, dryRun) {
  const line = [command, ...args].join(" ");
  console.log(`$ (${cwd}) ${line}`);
  if (dryRun) return;
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runAndCollect(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

function parseArgs(rawArgs) {
  const args = [...rawArgs];
  const cmd = args.shift();
  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    process.exit(0);
  }
  if (cmd !== "update") {
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
  }

  const opts = {
    version: "latest",
    registry: DEFAULT_PLUGIN_REGISTRY,
    baiduRegistry: process.env.npm_config_registry || DEFAULT_BAIDU_REGISTRY,
    pluginSpec: DEFAULT_PLUGIN_SPEC,
    channelId: "infoflow",
    dryRun: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const val = args[i];
    if (val === "--version") opts.version = args[++i] ?? opts.version;
    else if (val === "--registry") opts.registry = args[++i] ?? opts.registry;
    else if (val === "--baidu-registry") opts.baiduRegistry = args[++i] ?? opts.baiduRegistry;
    else if (val === "--plugin-spec") opts.pluginSpec = args[++i] ?? opts.pluginSpec;
    else if (val === "--channel-id") opts.channelId = args[++i] ?? opts.channelId;
    else if (val === "--dry-run") opts.dryRun = true;
    else {
      console.error(`Unknown option: ${val}`);
      printHelp();
      process.exit(1);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pluginDir = resolve(homedir(), ".openclaw", "extensions", opts.channelId);
  const configFile = resolve(homedir(), ".openclaw", "openclaw.json");

  const tempRoot = mkdtempSync(join(tmpdir(), "infoflow-tools-update-"));
  try {
    const spec = `${opts.pluginSpec}@${opts.version}`;
    let tarball = "<generated-by-npm-pack>.tgz";
    if (opts.dryRun) {
      console.log(`$ (${tempRoot}) npm pack ${spec} --registry ${opts.registry} --json`);
    } else {
      const output = runAndCollect("npm", ["pack", spec, "--registry", opts.registry, "--json"], tempRoot);
      const parsed = JSON.parse(output);
      tarball = parsed?.[0]?.filename;
      if (!tarball) {
        console.error("Unable to parse tarball filename from npm pack output.");
        process.exit(1);
      }
    }

    runOrFail("tar", ["-xzf", tarball], tempRoot, opts.dryRun);
    runOrFail("mkdir", ["-p", pluginDir], tempRoot, opts.dryRun);
    runOrFail(
      "rsync",
      ["-av", "--delete", `${join(tempRoot, "package")}/`, `${pluginDir}/`, "--exclude", "node_modules"],
      tempRoot,
      opts.dryRun,
    );

    const commonScriptPath = join(pluginDir, "scripts", "lib", "deploy-common.sh");
    runOrFail(
      "bash",
      [
        commonScriptPath,
        "--plugin-dir",
        pluginDir,
        "--plugin-id",
        opts.channelId,
        "--config-file",
        configFile,
        "--baidu-registry",
        opts.baiduRegistry,
        ...(opts.dryRun ? ["--dry-run"] : []),
      ],
      pluginDir,
      opts.dryRun,
    );
  } finally {
    if (!opts.dryRun) rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
