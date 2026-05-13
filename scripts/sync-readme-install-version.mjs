#!/usr/bin/env node
/**
 * Rewrites README.md regions marked with sync:infoflow-plugin-version[:<stream>] tags
 * so that install / release examples display correct versions for each release stream.
 *
 * Marker streams:
 *  - <!-- sync:infoflow-plugin-version --> ... <!-- /sync:infoflow-plugin-version -->
 *      "current" stream. Always synced to the current package.json "version".
 *      Use this for the release-flow section where the version being released right
 *      now is what should appear in the commands.
 *
 *  - <!-- sync:infoflow-plugin-version:latest --> ... <!-- /sync:infoflow-plugin-version:latest -->
 *      "latest" stream. Synced to npm's dist-tags.latest fetched from the registry.
 *      Special case: when package.json itself is on a stable (non-prerelease) version
 *      we use package.json (because that's about to be the new latest after `npm publish`).
 *      On network failure we leave the region untouched, so the README does not regress.
 *
 *  - <!-- sync:infoflow-plugin-version:beta --> ... <!-- /sync:infoflow-plugin-version:beta -->
 *      "beta" stream. Synced to npm's dist-tags.beta from the registry. When package.json
 *      is on a prerelease version (e.g. "...-beta.1"), we use package.json (about to be
 *      published as the new beta). On network failure the region is left as-is.
 *
 * Each release flow:
 *  - `npm version <X> --no-git-tag-version`     → set the new version
 *  - `npm run sync-readme-install-version`      → update markers (the "current" stream and
 *                                                  whichever of :latest/:beta matches X's
 *                                                  prerelease shape; the other stream is
 *                                                  refreshed from the registry)
 *  - commit / tag / push / npm publish [--tag beta]
 *
 * Markers must always come in matched pairs and may not nest. Do not paste them elsewhere.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const pkgName = pkg.name;
const readmePath = join(root, "README.md");

const isPrerelease = /-/u.test(version);

const NPM_REGISTRY = (process.env.NPM_REGISTRY?.trim() || "https://registry.npmjs.org").replace(
  /\/$/,
  "",
);
const FETCH_TIMEOUT_MS = 5_000;

/** Fetch dist-tags from the npm registry. Returns the JSON object or null on any failure. */
async function fetchDistTags() {
  const url = `${NPM_REGISTRY}/-/package/${encodeURIComponent(pkgName)}/dist-tags`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const distTags = await fetchDistTags();
if (!distTags) {
  console.warn(
    `README sync: unable to fetch dist-tags from ${NPM_REGISTRY} for ${pkgName}; ` +
      `:latest / :beta regions whose stream does not match the current package.json version will be left unchanged.`,
  );
}

/** Resolve which version a given marker stream should display. May return undefined. */
function versionForStream(stream) {
  if (stream === "latest") {
    if (!isPrerelease) return version;
    return distTags?.latest;
  }
  if (stream === "beta") {
    if (isPrerelease) return version;
    return distTags?.beta;
  }
  // bare → current
  return version;
}

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Apply version tokens inside one marked region. If target is undefined, region is untouched. */
function applyVersionToRegion(region, target) {
  if (!target) return region;
  return region
    .replace(new RegExp(`(${escapeForRegex(pkgName)}@)([^\\s\`]+)`, "g"), `$1${target}`)
    .replace(/(--version )([^\s`]+)/g, `$1${target}`)
    .replace(
      /^npm version [\w.-]+(?: --no-git-tag-version)?$/m,
      `npm version ${target} --no-git-tag-version`,
    )
    .replace(/^git tag [\w.-]+$/m, `git tag ${target}`)
    .replace(/^git commit -m "[\w.-]+"$/m, `git commit -m "${target}"`)
    .replace(/^git push origin ([\w.-]+)$/gm, (full, branchOrTag) =>
      branchOrTag === "main" ? full : `git push origin ${target}`,
    );
}

function replaceRegions(text, start, end, transform, counts, label) {
  let pos = 0;
  let out = "";
  while (true) {
    const i = text.indexOf(start, pos);
    if (i === -1) {
      out += text.slice(pos);
      break;
    }
    out += text.slice(pos, i);
    const j = text.indexOf(end, i + start.length);
    if (j === -1) {
      console.error(`README.md: found ${start} without matching ${end}`);
      process.exit(1);
    }
    const mid = text.slice(i + start.length, j);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    out += start + transform(mid) + end;
    pos = j + end.length;
  }
  return out;
}

const readme = readFileSync(readmePath, "utf8");

// Process suffixed streams first, then the bare ("current") stream. The bare start
// token is a strict prefix-free pattern: it ends with " -->" and would not match
// suffixed variants which contain ":<stream>" before " -->".
const STREAMS = [
  { name: "latest", suffix: ":latest" },
  { name: "beta", suffix: ":beta" },
  { name: "current", suffix: "" },
];

const counts = new Map();
let out = readme;
for (const { name, suffix } of STREAMS) {
  const start = `<!-- sync:infoflow-plugin-version${suffix} -->`;
  const end = `<!-- /sync:infoflow-plugin-version${suffix} -->`;
  const target = versionForStream(name === "current" ? null : name);
  out = replaceRegions(
    out,
    start,
    end,
    (region) => applyVersionToRegion(region, target),
    counts,
    name,
  );
}

writeFileSync(readmePath, out);
const parts = [
  `current(${counts.get("current") ?? 0})→${version}`,
  `latest(${counts.get("latest") ?? 0})→${distTags?.latest ?? (isPrerelease ? "unchanged" : version)}`,
  `beta(${counts.get("beta") ?? 0})→${distTags?.beta ?? (isPrerelease ? version : "unchanged")}`,
];
console.log(`README.md: synced regions — ${parts.join("  ")}`);
