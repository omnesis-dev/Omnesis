#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `npm run release -- <subcommand>` — the one entry point for cutting an
 * Omnesis release.
 *
 *   plan                 what a release would do to the repository as it stands
 *   version <x.y.z>      apply the pending changesets and write x.y.z everywhere
 *   pr                   open (or refresh) the release pull request
 *   tag                  preflight, then create the annotated tag — never pushed
 *   status               where the released artifacts currently stand
 *
 * Every subcommand takes `--dry-run` and every subcommand is re-runnable: each
 * one inspects the tree, does only what is still missing, and says so when
 * there is nothing left to do.
 *
 * The boundary this script holds: it operates on public code and public
 * channels only. Publishing is the tag-triggered workflow's job, not a local
 * command; store submission needs credentials that are deliberately not here,
 * so the script names it as the next step and stops. Nothing outside the
 * repository is read — a wrapper that knows about store builds passes what it
 * knows in through `--store-versions`, and its absence changes nothing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readChangelogSection } from "./changelog.mjs";
import { checkProductVersion } from "./check-product-version.mjs";
import {
  NATIVE_VERSION_FILES,
  assertStrictSemver,
  planNativeVersionWrites,
  writeNativeVersions,
} from "./native-versions.mjs";
import {
  buildReleasePlan,
  decideTag,
  formatPlan,
  formatReleasePrBody,
  formatTagDryRun,
  formatVersionDryRun,
  parseChangeset,
  releasePrRefusal,
  resolveTargetVersion,
} from "./plan.mjs";
import { preflightTag } from "./preflight-tag.mjs";
import { syncPluginVersions } from "./sync-plugin-versions.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Effects ─────────────────────────────────────────────────────────────

/** Run a command, returning its trimmed stdout; throws on a non-zero exit. */
function capture(command, args, { quiet = false } = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", quiet ? "pipe" : "inherit"],
  }).trim();
}

/** Run a command for its effect, streaming its output. */
function run(command, args) {
  execFileSync(command, args, { cwd: repoRoot, stdio: "inherit" });
}

/** Run a command whose failure is information rather than an error. */
function tryCapture(command, args) {
  try {
    return capture(command, args, { quiet: true });
  } catch {
    return null;
  }
}

// ── Repository state ────────────────────────────────────────────────────

function readProductVersion(root) {
  return JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
}

/** The package the CLI is published as: the manifest is the one place that names it. */
function cliPackageName(root) {
  return JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).name;
}

/**
 * Every pending `.changeset/*.md`. A file whose frontmatter names no
 * recognized bump is an error rather than something to skip: silently dropping
 * it would make the plan report fewer pending changes than `changeset version`
 * is about to apply.
 */
function readPendingChangesets(root) {
  const dir = join(root, ".changeset");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((name) => {
      const entry = {
        id: name.replace(/\.md$/u, ""),
        ...parseChangeset(readFileSync(join(dir, name), "utf8")),
      };
      if (entry.bumps.length === 0) {
        throw new Error(`.changeset/${name} declares no patch/minor/major bump`);
      }
      return entry;
    });
}

/**
 * Everything the plan reasons over. `probeRemote` is off by default because it
 * is the one network call here: only `plan`, which reports on the tag step,
 * needs to know whether origin already carries the tag.
 */
function readRepoState(root, requestedVersion, { probeRemote = false } = {}) {
  const productVersion = readProductVersion(root);
  const pendingChangesets = readPendingChangesets(root);
  const target = resolveTargetVersion({ productVersion, pendingChangesets, requestedVersion });
  const tag = `v${target}`;
  return {
    productVersion,
    requestedVersion,
    pendingChangesets,
    nativeVersions: planNativeVersionWrites(root, target),
    branch: tryCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "(detached)",
    treeClean: (tryCapture("git", ["status", "--porcelain"]) ?? "dirty") === "",
    localTagExists: tryCapture("git", ["rev-parse", "--verify", `refs/tags/${tag}`]) !== null,
    remoteTagExists:
      probeRemote &&
      Boolean(tryCapture("git", ["ls-remote", "--tags", "--refs", "origin", `refs/tags/${tag}`])),
    changelogSection: readChangelogSection(root, target),
  };
}

function repoOwner() {
  const url = tryCapture("git", ["remote", "get-url", "origin"]) ?? "";
  const owner = url.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/u)?.[1];
  // Interpolated into a `gh api` path below, so it must be a plain path
  // segment and never a traversal.
  return owner && /^[\w.-]+$/u.test(owner) && owner !== ".." ? owner : null;
}

// ── plan ────────────────────────────────────────────────────────────────

function commandPlan({ requestedVersion }) {
  // A report, never a gate: it exits 0 even when it lists blockers, because
  // the blockers are the answer. `version` and `tag` are the commands that
  // refuse.
  const state = readRepoState(repoRoot, requestedVersion, { probeRemote: true });
  console.log(formatPlan(buildReleasePlan(state)));
  return 0;
}

// ── version ─────────────────────────────────────────────────────────────

/**
 * Apply the pending changesets and write the target version into every place
 * that carries it, including the iOS and Android project files.
 *
 * The lockfile is refreshed with `--package-lock-only`: the release commit
 * needs the lockfile to agree with the bumped manifests, and rebuilding
 * `node_modules` here would be both slow and destructive in a worktree that
 * shares its dependency tree with another checkout.
 */
function commandVersion({ requestedVersion, dryRun }) {
  if (!requestedVersion) throw new Error("Usage: release version <x.y.z> [--dry-run]");
  assertStrictSemver(requestedVersion);
  const state = readRepoState(repoRoot, requestedVersion);
  // Only the changeset step gates versioning. A dirty tree is expected here —
  // this command is what dirties it — and the tag step's own preconditions are
  // checked when the tag is cut.
  const blocked = buildReleasePlan(state).steps.find(
    (entry) => entry.id === "changeset" && entry.state === "blocked",
  );
  if (blocked) throw new Error(`Cannot version to ${requestedVersion}: ${blocked.detail}`);

  const stale = state.nativeVersions.filter((entry) => entry.changed).map((entry) => entry.path);
  const settled =
    state.pendingChangesets.length === 0 &&
    state.productVersion === requestedVersion &&
    stale.length === 0;

  if (dryRun) {
    console.log(
      formatVersionDryRun({
        productVersion: state.productVersion,
        targetVersion: requestedVersion,
        pendingCount: state.pendingChangesets.length,
        staleNativePaths: stale,
        settled,
      }),
    );
    return 0;
  }

  if (state.pendingChangesets.length > 0) run("npx", ["changeset", "version"]);
  // Re-synchronized even when the manifests already carry the target: a plugin
  // manifest or lockfile that drifted is exactly what this command exists to
  // repair, and both steps are idempotent.
  syncPluginVersions(repoRoot);
  if (!settled) run("npm", ["install", "--package-lock-only"]);
  const written = writeNativeVersions(repoRoot, requestedVersion);
  for (const path of written) console.log(`  wrote ${requestedVersion} into ${path}`);
  checkProductVersion(repoRoot, `v${requestedVersion}`);
  console.log(`Product version ${requestedVersion} is consistent across the repository.`);
  if (settled) return 0;
  console.log("Next: commit the release, open the PR with `npm run release -- pr`.");
  return 0;
}

// ── pr ──────────────────────────────────────────────────────────────────

function commandPr({ dryRun }) {
  // The PR describes the version the branch actually carries; there is no
  // target to resolve, because `version` has already run by this point.
  const version = readProductVersion(repoRoot);
  const branch = tryCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "(detached)";
  const refusal = releasePrRefusal(branch);
  if (refusal) throw new Error(refusal);
  const body = formatReleasePrBody(version, readChangelogSection(repoRoot, version));
  const title = `Release v${version}`;
  const existing = tryCapture("gh", ["pr", "view", "--json", "url", "--jq", ".url"]);

  if (dryRun) {
    console.log(
      existing ? `Would refresh ${existing}` : `Would open "${title}" (${branch} → main)`,
    );
    console.log("");
    console.log(body);
    console.log("");
    console.log("Dry run — nothing opened.");
    return 0;
  }

  const dir = mkdtempSync(join(tmpdir(), "omnesis-release-"));
  try {
    const bodyFile = join(dir, "pr-body.md");
    writeFileSync(bodyFile, `${body}\n`);
    if (existing) {
      run("gh", ["pr", "edit", "--title", title, "--body-file", bodyFile]);
      console.log(`Refreshed ${existing}`);
    } else {
      run("gh", ["pr", "create", "--base", "main", "--title", title, "--body-file", bodyFile]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return 0;
}

// ── tag ─────────────────────────────────────────────────────────────────

/**
 * Create the annotated release tag on the verified commit. Pushing it is left
 * to the operator: the push is what arms every downstream publication, so it
 * stays one deliberate, separately typed command.
 */
function commandTag({ requestedVersion, dryRun, sign }) {
  const version = requestedVersion ?? readProductVersion(repoRoot);
  assertStrictSemver(version);
  const tag = `v${version}`;

  const decision = decideTag({
    existingSha: tryCapture("git", ["rev-parse", "--verify", `${tag}^{commit}`]),
    headSha: capture("git", ["rev-parse", "HEAD"]),
  });
  if (decision.kind === "mismatch") {
    throw new Error(
      `${tag} already exists and points at ${decision.existingSha}, not HEAD (${decision.headSha}).`,
    );
  }
  if (decision.kind === "exists") {
    console.log(`${tag} already exists at ${decision.sha}.`);
    console.log(`Next: git push origin ${tag}`);
    return 0;
  }

  if (dryRun) {
    console.log(formatTagDryRun({ tag, version, sign }));
    return 0;
  }

  const sha = preflightTag(repoRoot, tag);
  run("git", ["tag", sign ? "-s" : "-a", tag, "-m", `Omnesis ${version}`, sha]);
  console.log(`Created ${sign ? "signed " : ""}annotated tag ${tag} at ${sha}.`);
  if (!sign) {
    console.log("Unsigned — pass --sign to sign it with your configured release key.");
  }
  console.log(`Next: git push origin ${tag}`);
  return 0;
}

// ── status ──────────────────────────────────────────────────────────────

function npmDistTags(root, registry) {
  const args = ["view", cliPackageName(root), "dist-tags", "--json"];
  if (registry) args.push("--registry", registry);
  const raw = tryCapture("npm", args);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function imageTags(owner, image) {
  if (!owner) return null;
  const raw = tryCapture("gh", [
    "api",
    `/orgs/${owner}/packages/container/${image}/versions`,
    "--jq",
    '[.[].metadata.container.tags[]] | unique | join(", ")',
  ]);
  return raw || null;
}

function parseStoreVersions(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    throw new Error('--store-versions expects a JSON object, e.g. \'{"ios":"0.4.0"}\'');
  }
}

function commandStatus({ registry, storeVersions }) {
  // The store versions are the one fact this repository cannot know: the
  // builds are submitted with credentials that live outside it. A wrapper that
  // does know passes them in; without one the slot says so rather than
  // guessing. Parsed first so a malformed argument fails before the network
  // probes below spend time on it.
  const stores = parseStoreVersions(storeVersions ?? process.env.OMNESIS_RELEASE_STORE_VERSIONS);
  const owner = repoOwner();
  console.log(`Checked-in product version: ${readProductVersion(repoRoot)}`);

  const newestTag = tryCapture("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]);
  const headTag = tryCapture("git", ["describe", "--tags", "--exact-match", "--match", "v[0-9]*"]);
  console.log(
    `Newest tag reachable from HEAD: ${newestTag ?? "(none)"}${headTag ? " (HEAD is this tag)" : ""}`,
  );

  const tags = npmDistTags(repoRoot, registry);
  const registryLabel = registry ?? "the default registry";
  console.log(
    tags
      ? `npm dist-tags on ${registryLabel}: ${Object.entries(tags)
          .map(([t, v]) => `${t}=${v}`)
          .join(", ")}`
      : `npm dist-tags on ${registryLabel}: unavailable (omnesis is not published there, or the registry is unreachable)`,
  );

  for (const image of ["omnesis-gateway", "omnesis-collector"]) {
    const found = imageTags(owner, image);
    console.log(
      `Image tags for ${image}: ${found ?? "unavailable (unpublished, or no package read access)"}`,
    );
  }

  if (stores) {
    for (const [store, storeVersion] of Object.entries(stores)) {
      console.log(`Store version (${store}): ${storeVersion}`);
    }
  } else {
    console.log('Store versions: not supplied (pass --store-versions \'{"ios":"…"}\').');
  }
  return 0;
}

// ── Entry point ─────────────────────────────────────────────────────────

const SUBCOMMANDS = {
  plan: commandPlan,
  version: commandVersion,
  pr: commandPr,
  tag: commandTag,
  status: commandStatus,
};

export function parseArgs(argv) {
  const [subcommand, ...rest] = argv;
  const options = { dryRun: false, sign: false };
  const positional = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--sign") options.sign = true;
    else if (arg === "--registry" || arg === "--store-versions") {
      const value = rest[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      options[arg === "--registry" ? "registry" : "storeVersions"] = value;
    } else if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error(`Unexpected argument: ${positional[1]}`);
  options.requestedVersion = positional[0];
  return { subcommand, options };
}

function usage() {
  return [
    "Usage: npm run release -- <subcommand> [options]",
    "",
    "  plan [x.y.z]        what a release would do to the repository as it stands",
    "  version <x.y.z>     apply pending changesets and write x.y.z everywhere",
    "  pr                  open or refresh the release pull request",
    "  tag [x.y.z]         preflight, then create the annotated tag (never pushed)",
    "  status              current tag, npm dist-tags, image tags, store versions",
    "",
    "  --dry-run           print what would happen; change nothing",
    "  --sign              (tag) sign the tag with your configured release key",
    "  --registry <url>    (status) query this registry instead of the default",
    "  --store-versions    (status) JSON object of store versions from a wrapper",
    "",
    `Native project files written by \`version\`: ${NATIVE_VERSION_FILES.join(", ")}`,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { subcommand, options } = parseArgs(process.argv.slice(2));
    const handler = SUBCOMMANDS[subcommand];
    if (!handler) {
      console.error(subcommand ? `Unknown subcommand: ${subcommand}\n` : "");
      console.error(usage());
      process.exitCode = 2;
    } else {
      process.exitCode = handler(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
