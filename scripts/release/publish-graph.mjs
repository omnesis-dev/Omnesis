// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Publish the Omnesis package graph to an npm-compatible registry so that a
 * run interrupted partway can be repeated and continue where it stopped.
 *
 * npm registries offer no transaction across packages and never let a
 * published version be replaced, so the contract is resumability rather
 * than atomicity:
 *
 * - Every package is staged and packed before the first network call, so a
 *   manifest or build problem never leaves the registry half-published.
 * - Packages publish in dependency order, leaves first, so the entry
 *   package that installs resolve lands only after everything it depends
 *   on and an installer never sees an entry version whose dependencies
 *   are missing. Packages that depend on each other publish consecutively.
 * - Before each publish the registry is asked for that name@version. An
 *   absent version publishes. A present version whose artifact carries the
 *   same integrity as the staged tarball is already complete and is skipped,
 *   with the requested dist-tag applied if it points elsewhere. A present
 *   version with a different artifact stops the run before any further
 *   package publishes, because the registry holds something this tree did
 *   not produce and only a person can decide what that means.
 *
 * The summary names each package as published, already-published, or
 * mismatched, so a resumed run reads differently from a first run.
 */

import { execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Run npm for its effect, streaming its output; rejects on a non-zero exit. */
function runNpm(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args[0]} exited with ${signal ?? code}`));
    });
  });
}

const WORKSPACE_DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/**
 * Order packages so every workspace dependency precedes its dependents,
 * keeping the input order among ties. Packages that depend on each other
 * (a cycle, which npm installs fine) cannot be ordered dependency-first
 * among themselves; they come out consecutively, after everything outside
 * the cycle they depend on, so the window in which one member is published
 * without the other is as short as the publisher can make it.
 */
export function orderByDependencies(packages) {
  const byName = new Map(packages.map((entry) => [entry.pkg.name, entry]));
  const ordered = [];
  const visited = new Set();
  const visit = (entry) => {
    const name = entry.pkg.name;
    // A dependency edge back into a package still being visited is the
    // cycle case; the post-order emission leaves its members consecutive.
    if (visited.has(name)) return;
    visited.add(name);
    for (const field of WORKSPACE_DEPENDENCY_FIELDS) {
      for (const dependency of Object.keys(entry.pkg[field] ?? {})) {
        const target = byName.get(dependency);
        if (target) visit(target);
      }
    }
    ordered.push(entry);
  };
  for (const entry of packages) visit(entry);
  return ordered;
}

/**
 * `npm pack` one staged directory into `tarballDir`; returns the tarball's
 * path and integrity. The tarball is what gets published, so the registry's
 * artifact is this file byte for byte and the integrity comparison on a
 * later run is exact.
 */
export async function packStagedPackage(stageDir, tarballDir) {
  mkdirSync(tarballDir, { recursive: true });
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", tarballDir],
    // The JSON lists every file in the tarball; the gateway's dist and
    // portal run to thousands, well past execFile's default buffer.
    { cwd: stageDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const [packed] = JSON.parse(stdout);
  if (!packed?.integrity || !packed?.filename) {
    throw new Error(`npm pack reported no tarball for ${stageDir}`);
  }
  return { integrity: packed.integrity, tarball: join(tarballDir, packed.filename) };
}

/**
 * What the registry holds for name@version: `null` when the version is
 * absent, else its artifact integrity and the dist-tags of the package.
 */
export async function viewPublishedVersion(name, version, registry) {
  let output;
  try {
    ({ stdout: output } = await execFileAsync(
      "npm",
      [
        "view",
        `${name}@${version}`,
        "dist.integrity",
        "dist-tags",
        "--json",
        "--registry",
        registry,
      ],
      { encoding: "utf8" },
    ));
  } catch (err) {
    const text = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    if (/E404/u.test(text)) return null;
    throw new Error(`npm view ${name}@${version} failed: ${err.stderr?.trim() || err.message}`, {
      cause: err,
    });
  }
  const trimmed = output.trim();
  if (trimmed === "" || trimmed === "{}") return null;
  const parsed = JSON.parse(trimmed);
  if (typeof parsed["dist.integrity"] !== "string") return null;
  return { integrity: parsed["dist.integrity"], distTags: parsed["dist-tags"] ?? {} };
}

export function publishTarball(tarball, { registry, tag, access }) {
  return runNpm(["publish", tarball, "--registry", registry, "--tag", tag, "--access", access]);
}

export function addDistTag(name, version, tag, registry) {
  return runNpm(["dist-tag", "add", `${name}@${version}`, tag, "--registry", registry]);
}

/**
 * Stage, pack and publish `packages` in dependency order. Returns the
 * per-package outcomes; throws after the summary when a mismatch or a
 * publish failure stopped the run, so the exit status says so.
 *
 * The registry and npm steps are injectable for tests that drive a small
 * synthetic graph against a disposable registry.
 */
export async function publishGraph({
  packages,
  registry,
  tag,
  access,
  dryRun = false,
  stagingBase,
  tarballDir,
  stage,
  pack = packStagedPackage,
  view = viewPublishedVersion,
  publish = publishTarball,
  distTag = addDistTag,
  log = console.log,
}) {
  const ordered = orderByDependencies(packages);

  // Everything local first: a package that cannot be staged or packed
  // stops the run before the registry has changed at all.
  const prepared = [];
  for (const entry of ordered) {
    const stageDir = stage(entry, stagingBase, { access });
    const { integrity, tarball } = await pack(stageDir, tarballDir);
    prepared.push({ entry, tarball, integrity });
  }
  if (dryRun) {
    for (const { entry } of prepared) log(`packed ${entry.pkg.name}@${entry.pkg.version}`);
    log(`${prepared.length} packages packed`);
    return prepared.map(({ entry }) => ({ name: entry.pkg.name, outcome: "packed" }));
  }

  const results = [];
  let stopped = null;
  for (const { entry, tarball, integrity } of prepared) {
    const { name, version } = entry.pkg;
    // Any registry step that fails ends the run as this package's failure,
    // so the summary and the outcomes still account for every package.
    try {
      const existing = await view(name, version, registry);
      if (existing === null) {
        await publish(tarball, { registry, tag, access });
        results.push({ name, outcome: "published" });
        log(`published ${name}@${version}`);
        continue;
      }
      if (existing.integrity !== integrity) {
        results.push({ name, outcome: "mismatched", detail: existing.integrity });
        stopped =
          `${name}@${version} already exists on ${registry} with a different artifact ` +
          `(registry ${existing.integrity}, staged ${integrity}); nothing after it was published`;
        break;
      }
      if (existing.distTags[tag] !== version) {
        await distTag(name, version, tag, registry);
        results.push({ name, outcome: "already-published", detail: `tagged ${tag}` });
        log(`already published ${name}@${version}; tagged ${tag}`);
      } else {
        results.push({ name, outcome: "already-published" });
        log(`already published ${name}@${version}`);
      }
    } catch (err) {
      results.push({ name, outcome: "failed", detail: err.message });
      stopped = `${name}@${version} failed to publish: ${err.message}`;
      break;
    }
  }

  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  const skipped = prepared.length - results.length;
  log(
    `${count("published")} published, ${count("already-published")} already published` +
      (count("mismatched") ? `, ${count("mismatched")} mismatched` : "") +
      (count("failed") ? `, ${count("failed")} failed` : "") +
      (skipped ? `, ${skipped} not attempted` : "") +
      ` (${registry}, tag ${tag})`,
  );
  if (stopped) throw new Error(stopped);
  return results;
}
