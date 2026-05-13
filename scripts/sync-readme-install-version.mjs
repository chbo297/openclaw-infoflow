#!/usr/bin/env node
/**
 * Rewrites README.md regions marked with <!-- sync:infoflow-plugin-version --> ... <!-- /sync:infoflow-plugin-version -->
 * so that install / release examples use the same version as package.json "version".
 *
 * Run after `npm version <x> --no-git-tag-version` and before committing the release.
 *
 * Do not paste those marker strings elsewhere in README.md, or this script will treat them as a region.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const readmePath = join(root, "README.md");

const readme = readFileSync(readmePath, "utf8");

const START = "<!-- sync:infoflow-plugin-version -->";
const END = "<!-- /sync:infoflow-plugin-version -->";

/** Apply version tokens inside one marked region (may include markdown + fenced bash). */
function applyVersionToRegion(region) {
  return region
    .replace(/(@chbo297\/infoflow@)([^\s`]+)/g, `$1${version}`)
    .replace(/(--version )([^\s`]+)/g, `$1${version}`)
    .replace(/^npm version [\w.-]+(?: --no-git-tag-version)?$/m, `npm version ${version} --no-git-tag-version`)
    .replace(/^git tag [\w.-]+$/m, `git tag ${version}`)
    .replace(/^git commit -m "[\w.-]+"$/m, `git commit -m "${version}"`)
    .replace(/^git push origin ([\w.-]+)$/gm, (full, branchOrTag) =>
      branchOrTag === "main" ? full : `git push origin ${version}`,
    );
}

let pos = 0;
let out = "";
let regions = 0;
while (true) {
  const i = readme.indexOf(START, pos);
  if (i === -1) {
    out += readme.slice(pos);
    break;
  }
  out += readme.slice(pos, i);
  const j = readme.indexOf(END, i + START.length);
  if (j === -1) {
    console.error(`README.md: found ${START} without matching ${END}`);
    process.exit(1);
  }
  const mid = readme.slice(i + START.length, j);
  regions++;
  out += START + applyVersionToRegion(mid) + END;
  pos = j + END.length;
}

writeFileSync(readmePath, out);
console.log(`README.md: synced ${regions} <!-- sync:infoflow-plugin-version --> region(s) to ${version}`);
