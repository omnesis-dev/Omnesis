// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The release plan: what a release would do to the repository as it stands.
 *
 * Pure — every fact it reasons over is gathered by the conductor and handed in
 * as a plain object, so `release plan` and the guard each subcommand runs
 * before it acts are the same code path rather than two descriptions of the
 * same rules that can disagree.
 */

/** Ordered weakest to strongest; `none` is declared but moves nothing. */
const BUMPS = ["patch", "minor", "major"];

/**
 * Bumps and summary of one `.changeset/*.md` file. The bump value may be
 * quoted or bare and may carry a trailing YAML comment — changesets accepts
 * all of those, so a release gate that read only one form would under-report
 * what a release is about to do. `none` is a bump changesets recognizes and
 * that moves no version; it is kept so a file declaring only `none` reads as
 * deliberate rather than malformed.
 */
export function parseChangeset(text) {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? "";
  const bumps = [
    ...frontmatter.matchAll(/:\s*["']?(patch|minor|major|none)["']?\s*(?:#.*)?$/gmu),
  ].map((m) => m[1]);
  const summary = text
    .replace(/^---\r?\n[\s\S]*?\r?\n---/u, "")
    .trim()
    .split(/\r?\n/u)[0]
    .trim();
  return { bumps, summary };
}

/** The strongest bump across a set — how changesets resolves a lockstep group. */
export function maxBump(bumps) {
  let best = -1;
  for (const bump of bumps) best = Math.max(best, BUMPS.indexOf(bump));
  return best === -1 ? null : BUMPS[best];
}

/** Apply one bump to a strict SemVer version. */
export function nextVersion(current, bump) {
  const [major, minor, patch] = current.split(".").map(Number);
  if (![major, minor, patch].every(Number.isInteger)) {
    throw new Error(`Not a strict SemVer version: ${current}`);
  }
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  return current;
}

/**
 * Version this release lands on: the requested one when the operator named
 * one, otherwise what the pending changesets resolve to, otherwise the
 * version already in the tree.
 */
export function resolveTargetVersion(state) {
  if (state.requestedVersion) return state.requestedVersion;
  const bump = maxBump(state.pendingChangesets.flatMap((entry) => entry.bumps));
  return bump ? nextVersion(state.productVersion, bump) : state.productVersion;
}

function step(id, title, state, detail) {
  return { id, title, state, detail };
}

/**
 * Build the ordered plan. Each step is `done` (nothing left to do), `todo`
 * (this run would do it), `blocked` (something must change first), or
 * `external` (deliberately not this script's to run).
 */
export function buildReleasePlan(state) {
  const target = resolveTargetVersion(state);
  const tag = `v${target}`;
  const pending = state.pendingChangesets;
  const bump = maxBump(pending.flatMap((entry) => entry.bumps));
  const steps = [];

  if (pending.length > 0) {
    const produced = nextVersion(state.productVersion, bump);
    const summaries = pending
      .map((entry) => entry.summary)
      .filter(Boolean)
      .map((summary) => `\n      • ${summary}`)
      .join("");
    const counted =
      `${pending.length} pending changeset${pending.length === 1 ? "" : "s"} → ${bump} bump ` +
      `(${state.productVersion} → ${produced})`;
    // A requested version the pending changesets cannot produce is blocked
    // rather than attempted: running `changeset version` would consume the
    // changesets and bump the manifests to the version they do produce, and
    // only then discover it is not the one that was asked for.
    steps.push(
      produced === target
        ? step("changeset", "Describe the change", "todo", counted + summaries)
        : step(
            "changeset",
            "Describe the change",
            "blocked",
            `${counted}, not ${target}. Adjust the changeset bumps, ` +
              `or release ${produced} instead.`,
          ),
    );
  } else if (target !== state.productVersion) {
    steps.push(
      step(
        "changeset",
        "Describe the change",
        "blocked",
        `No pending changesets, so nothing moves ${state.productVersion} to ${target}. ` +
          "Run `npx changeset` first.",
      ),
    );
  } else {
    steps.push(
      step(
        "changeset",
        "Describe the change",
        "done",
        `No pending changesets; tree is at ${target}.`,
      ),
    );
  }

  const staleNative = state.nativeVersions.filter((entry) => entry.changed).map((e) => e.path);
  const versionDone =
    pending.length === 0 && state.productVersion === target && staleNative.length === 0;
  steps.push(
    step(
      "version",
      `Write ${target} across the repository`,
      versionDone ? "done" : "todo",
      versionDone
        ? "Every manifest, plugin manifest and native project file already carries this version."
        : [
            "changeset version → every workspace manifest and the product changelog",
            "release:sync-plugins → plugin, extension and contract manifests",
            "npm install --package-lock-only → the lockfile",
            staleNative.length > 0
              ? `native project files → ${staleNative.join(", ")}`
              : "native project files already current",
            "release:check-version → the lockstep guard",
          ].join("; "),
    ),
  );

  const onMain = state.branch === "main";
  steps.push(
    step(
      "pr",
      "Open the release pull request",
      onMain ? "blocked" : "todo",
      onMain
        ? "HEAD is on main — a release commit lands through a pull request; branch first."
        : `${state.branch} → main, body from the ${target} changelog section` +
            (state.changelogSection ? "" : " (no section for this version yet)"),
    ),
  );

  const tagBlockers = [];
  if (state.productVersion !== target) tagBlockers.push(`the tree is at ${state.productVersion}`);
  if (pending.length > 0) tagBlockers.push("changesets are still pending");
  if (!state.treeClean) tagBlockers.push("the working tree is dirty");
  if (state.remoteTagExists) tagBlockers.push(`${tag} already exists on origin`);
  steps.push(
    step(
      "tag",
      `Create the annotated tag ${tag}`,
      state.localTagExists && tagBlockers.length === 0
        ? "done"
        : tagBlockers.length > 0
          ? "blocked"
          : "todo",
      tagBlockers.length > 0
        ? tagBlockers.join("; ")
        : state.localTagExists
          ? `${tag} already exists locally.`
          : "After main CI is green at the release commit. The tag is never pushed by this script.",
    ),
  );

  steps.push(
    step(
      "publish",
      "Publish packages, images and the GitHub Release",
      "external",
      `Pushing ${tag} triggers the release workflow, which republishes nothing locally.`,
    ),
  );
  steps.push(
    step(
      "stores",
      "Submit the mobile and browser-extension builds",
      "external",
      "A credentialed step outside this repository; this script never performs it.",
    ),
  );

  return {
    productVersion: state.productVersion,
    targetVersion: target,
    tag,
    steps,
    blockers: steps.filter((entry) => entry.state === "blocked").map((entry) => entry.detail),
  };
}

const MARKS = { done: "✔", todo: "→", blocked: "✖", external: "·" };

export function formatPlan(plan) {
  const lines = [
    `Release plan: ${plan.productVersion} → ${plan.targetVersion} (${plan.tag})`,
    "",
    ...plan.steps.map((entry) => `${MARKS[entry.state]} ${entry.title}\n    ${entry.detail}`),
  ];
  if (plan.blockers.length > 0) {
    lines.push("", `${plan.blockers.length} step(s) blocked — resolve them before this release.`);
  }
  return lines.join("\n");
}

// ── Dry-run renderings ──────────────────────────────────────────────────
//
// Every mutating subcommand prints exactly the sequence it would run. These
// are pure so the promise a dry run makes is the same text the real run is
// built from, and so both can be asserted without executing anything.

export function formatVersionDryRun({
  productVersion,
  targetVersion,
  pendingCount,
  staleNativePaths,
  settled = false,
}) {
  const lines = [`Would version ${productVersion} → ${targetVersion}:`];
  if (pendingCount > 0) lines.push(`  npx changeset version   (${pendingCount} pending)`);
  lines.push("  node scripts/release/sync-plugin-versions.mjs");
  // Nothing moved a manifest version, so the lockfile cannot have drifted.
  if (!settled) lines.push("  npm install --package-lock-only");
  if (staleNativePaths.length === 0)
    lines.push("  native project files already carry this version");
  for (const path of staleNativePaths) lines.push(`  write ${targetVersion} into ${path}`);
  lines.push(
    `  node scripts/release/check-product-version.mjs v${targetVersion}`,
    "Dry run — nothing written.",
  );
  return lines.join("\n");
}

export function formatTagDryRun({ tag, version, sign }) {
  return [
    `Would preflight and create ${tag} on HEAD:`,
    `  node scripts/release/preflight-tag.mjs ${tag}`,
    `  git tag ${sign ? "-s" : "-a"} ${tag} -m "Omnesis ${version}" <verified-sha>`,
    "Dry run — nothing created. The tag is never pushed by this script.",
  ].join("\n");
}

/**
 * Body of the release pull request: the changelog section this release
 * generated, plus what merging it sets in motion. Kept next to the plan so the
 * PR describes the same sequence `plan` prints.
 */
export function formatReleasePrBody(version, section) {
  return [
    `Release \`v${version}\`.`,
    "",
    section ?? "_No changelog section for this version yet._",
    "",
    "---",
    "",
    "Merging this lands the release commit on `main`. Once main CI is green at that",
    "commit, cut the tag with `npm run release -- tag` and push it; the tag-triggered",
    "release workflow publishes the packages, images and GitHub Release.",
  ].join("\n");
}

// ── Tag and branch decisions ────────────────────────────────────────────

/**
 * What `release tag` should do given the tag's current state. Creating the tag
 * is the only outcome that acts; an existing tag on HEAD is the idempotent
 * no-op, and one pointing elsewhere is the refusal that keeps a release from
 * silently being cut at the wrong commit.
 */
export function decideTag({ existingSha, headSha }) {
  if (!existingSha) return { kind: "create" };
  if (existingSha !== headSha) return { kind: "mismatch", existingSha, headSha };
  return { kind: "exists", sha: existingSha };
}

/** Why this branch cannot carry a release PR, or `null` when it can. */
export function releasePrRefusal(branch) {
  if (branch === "main") return "Cannot open a release PR from main; work on a branch.";
  if (branch === "(detached)") {
    return "Cannot open a release PR from a detached HEAD; check out a branch.";
  }
  return null;
}
