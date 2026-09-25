// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Verification and commit point for adopting a hand-made source checkout. */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CliError, EXIT_FAILURE, EXIT_USER_ERROR } from "../utils.js";
import { versionFromStableTag, type CommandSpec } from "./detect.js";

const GITHUB_HOST = "github.com";
const GITHUB_SSH_USER = "git";
const OFFICIAL_ORIGINS = new Set([
  "https://github.com/omnesis-dev/Omnesis",
  "https://github.com/omnesis-dev/Omnesis.git",
  `${GITHUB_SSH_USER}@${GITHUB_HOST}:omnesis-dev/Omnesis`,
  `${GITHUB_SSH_USER}@${GITHUB_HOST}:omnesis-dev/Omnesis.git`,
  `ssh://${GITHUB_SSH_USER}@${GITHUB_HOST}/omnesis-dev/Omnesis`,
  `ssh://${GITHUB_SSH_USER}@${GITHUB_HOST}/omnesis-dev/Omnesis.git`,
]);

const ACTIVE_GIT_PATHS = [
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_START",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
] as const;

const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface SourceAdoptionRunOutcome {
  code: number;
  stdout: string;
}

export type SourceAdoptionRunner = (spec: CommandSpec) => Promise<SourceAdoptionRunOutcome>;

export interface SourceAdoptionPathIdentity {
  kind: "directory" | "file" | "symlink" | "other";
  device: string;
  inode: string;
}

export interface SourceAdoptionFs {
  identity(path: string): SourceAdoptionPathIdentity | null;
  exists(path: string): boolean;
}

export interface SourceAdoptionDeps {
  run: SourceAdoptionRunner;
  fs?: SourceAdoptionFs;
  nonce?: () => string;
  log(message: string): void;
}

export const nodeSourceAdoptionFs: SourceAdoptionFs = {
  identity: (path) => {
    try {
      const stat = lstatSync(path);
      return {
        kind: stat.isSymbolicLink()
          ? "symlink"
          : stat.isDirectory()
            ? "directory"
            : stat.isFile()
              ? "file"
              : "other",
        device: String(stat.dev),
        inode: String(stat.ino),
      };
    } catch {
      return null;
    }
  },
  exists: (path) => existsSync(path),
};

interface LocalCheckoutSnapshot {
  rootIdentity: string;
  gitIdentity: string;
  configIdentity: string;
  head: string;
  rawOrigin: string;
  effectiveOrigin: string;
  marker: "absent" | "managed" | string;
}

export interface SourceAdoptionRemoteRefs {
  main: string | null;
  stableTags: ReadonlyMap<string, readonly string[]>;
}

function refusal(message: string): never {
  throw new CliError(`Refusing source adoption: ${message}`, EXIT_USER_ERROR);
}

function failure(message: string): never {
  throw new CliError(`Could not verify source adoption: ${message}`, EXIT_FAILURE);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function identityKey(identity: SourceAdoptionPathIdentity): string {
  return `${identity.kind}:${identity.device}:${identity.inode}`;
}

function gitSpec(rootDir: string, args: string[]): CommandSpec {
  const gitDir = join(rootDir, ".git");
  return {
    command: "git",
    args: [`--git-dir=${gitDir}`, `--work-tree=${rootDir}`, "--no-replace-objects", ...args],
    cwd: rootDir,
  };
}

async function runGit(
  rootDir: string,
  args: string[],
  deps: SourceAdoptionDeps,
  action: string,
): Promise<SourceAdoptionRunOutcome> {
  try {
    return await deps.run(gitSpec(rootDir, args));
  } catch (error) {
    failure(`${action}: ${errorMessage(error)}`);
  }
}

function exactlyOne(lines: string[], label: string): string {
  if (lines.length !== 1) refusal(`${label} must contain exactly one value.`);
  return lines[0]!;
}

function assertOfficialOrigin(origin: string, label: string): void {
  if (!OFFICIAL_ORIGINS.has(origin)) {
    refusal(
      `${label} is not the official Omnesis repository. Expected an exact HTTPS or SSH URL for ` +
        "github.com/omnesis-dev/Omnesis.",
    );
  }
}

export function isOfficialSourceAdoptionOrigin(origin: string): boolean {
  return OFFICIAL_ORIGINS.has(origin);
}

function setUnique(current: string | undefined, next: string, description: string): string {
  if (current !== undefined) {
    throw new Error(`remote advertised ${description} more than once`);
  }
  return next;
}

/** Parse the live `ls-remote` proof, including annotated-tag peeled commits. */
export function parseSourceAdoptionRemoteRefs(output: string): SourceAdoptionRemoteRefs {
  let main: string | undefined;
  const tags = new Map<string, { direct?: string; peeled?: string }>();

  for (const line of outputLines(output)) {
    const match = line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/u);
    if (!match) throw new Error("remote returned a malformed ref line");
    const [, objectId, ref] = match as [string, string, string];
    if (ref === "refs/heads/main") {
      main = setUnique(main, objectId, "refs/heads/main");
      continue;
    }
    if (!ref.startsWith("refs/tags/")) continue;

    const peeled = ref.endsWith("^{}");
    const tag = ref.slice("refs/tags/".length, peeled ? -3 : undefined);
    if (versionFromStableTag(tag) === null) continue;
    const entry = tags.get(tag) ?? {};
    if (peeled) entry.peeled = setUnique(entry.peeled, objectId, `${tag}^{}`);
    else entry.direct = setUnique(entry.direct, objectId, tag);
    tags.set(tag, entry);
  }

  const stableTags = new Map<string, string[]>();
  for (const [tag, entry] of tags) {
    if (!entry.direct) throw new Error(`remote advertised ${tag} only as a peeled ref`);
    const commit = entry.peeled ?? entry.direct;
    const names = stableTags.get(commit) ?? [];
    names.push(tag);
    stableTags.set(commit, names);
  }
  return { main: main ?? null, stableTags };
}

async function readMarkerValues(rootDir: string, deps: SourceAdoptionDeps): Promise<string[]> {
  const result = await runGit(
    rootDir,
    ["config", "--local", "--no-includes", "--get-all", "omnesis.install"],
    deps,
    "read the repository-local ownership marker",
  );
  if (result.code === 1) return [];
  if (result.code !== 0) failure("Git could not read the repository-local ownership marker.");
  return outputLines(result.stdout);
}

async function readMarker(
  rootDir: string,
  deps: SourceAdoptionDeps,
  expected?: string,
): Promise<"absent" | "managed" | string> {
  const values = await readMarkerValues(rootDir, deps);
  if (expected !== undefined) {
    if (values.length !== 1 || values[0] !== expected) {
      refusal("the repository-local ownership marker changed during adoption.");
    }
    return expected;
  }
  if (values.length === 0) return "absent";
  if (values.length === 1 && values[0] === "managed") return "managed";
  refusal(
    "the repository-local ownership marker has an unexpected, incomplete, or duplicate value. " +
      "Inspect it with `git config --local --no-includes --get-all omnesis.install` before retrying.",
  );
}

async function assertSparseCheckoutDisabled(
  rootDir: string,
  deps: SourceAdoptionDeps,
): Promise<void> {
  for (const scope of ["--local", "--worktree"] as const) {
    const result = await runGit(
      rootDir,
      ["config", scope, "--bool", "core.sparseCheckout"],
      deps,
      "inspect sparse-checkout configuration",
    );
    if (result.code === 1) continue;
    if (result.code !== 0) failure("Git could not inspect sparse-checkout configuration.");
    const value = exactlyOne(outputLines(result.stdout), "the sparse-checkout setting");
    if (value === "true") {
      refusal(
        "sparse checkouts are not supported because a managed update must build the full tree.",
      );
    }
    if (value !== "false") failure("Git returned an invalid sparse-checkout setting.");
  }
}

async function inspectLocalCheckout(
  rootDir: string,
  deps: SourceAdoptionDeps,
  expectedMarker?: string,
): Promise<LocalCheckoutSnapshot> {
  const fs = deps.fs ?? nodeSourceAdoptionFs;
  const root = fs.identity(rootDir);
  if (!root || root.kind !== "directory") {
    refusal("the detected repository root is not a real directory.");
  }
  const gitDir = join(rootDir, ".git");
  const git = fs.identity(gitDir);
  if (!git) refusal("the detected repository has no .git directory.");
  if (git.kind === "file") {
    refusal(
      "linked worktrees and submodules cannot be adopted because they share Git configuration.",
    );
  }
  if (git.kind !== "directory") {
    refusal("the .git entry must be a real directory, not a symlink or special file.");
  }
  const config = fs.identity(join(gitDir, "config"));
  if (!config || config.kind !== "file") {
    refusal("the repository-local .git/config must be a real file, not a symlink or special file.");
  }

  for (const relative of ACTIVE_GIT_PATHS) {
    if (fs.exists(join(gitDir, relative))) {
      refusal(`a Git operation is in progress (${relative}). Finish or abort it first.`);
    }
  }
  if (fs.exists(join(gitDir, "info", "grafts"))) {
    refusal("local Git grafts can alter ancestry and must be removed before adoption.");
  }
  if (fs.exists(join(gitDir, "info", "sparse-checkout"))) {
    refusal(
      "sparse checkouts are not supported because a managed update must build the full tree.",
    );
  }

  const topLevelResult = await runGit(
    rootDir,
    ["rev-parse", "--show-toplevel"],
    deps,
    "locate the repository root",
  );
  if (topLevelResult.code !== 0) failure("Git could not locate the repository root.");
  const topLevel = exactlyOne(outputLines(topLevelResult.stdout), "Git's repository root");
  if (!isAbsolute(topLevel) || resolve(topLevel) !== rootDir) {
    refusal("the running CLI is not rooted at Git's exact top-level checkout.");
  }

  const bareResult = await runGit(
    rootDir,
    ["rev-parse", "--is-bare-repository"],
    deps,
    "inspect the repository layout",
  );
  if (
    bareResult.code !== 0 ||
    exactlyOne(outputLines(bareResult.stdout), "Git's bare setting") !== "false"
  ) {
    refusal("bare repositories cannot be adopted.");
  }

  const absoluteGitDirResult = await runGit(
    rootDir,
    ["rev-parse", "--absolute-git-dir"],
    deps,
    "locate the Git directory",
  );
  if (absoluteGitDirResult.code !== 0) failure("Git could not locate its metadata directory.");
  const absoluteGitDir = exactlyOne(
    outputLines(absoluteGitDirResult.stdout),
    "Git's metadata directory",
  );
  if (resolve(absoluteGitDir) !== gitDir) {
    refusal("Git metadata is not contained in this standalone checkout.");
  }

  const commonGitDirResult = await runGit(
    rootDir,
    ["rev-parse", "--git-common-dir"],
    deps,
    "locate the shared Git directory",
  );
  if (commonGitDirResult.code !== 0) failure("Git could not locate its shared metadata directory.");
  const commonGitDir = exactlyOne(
    outputLines(commonGitDirResult.stdout),
    "Git's shared metadata directory",
  );
  if (resolve(rootDir, commonGitDir) !== gitDir) {
    refusal("linked worktrees cannot be adopted because they share Git configuration.");
  }

  await assertSparseCheckoutDisabled(rootDir, deps);

  const replacements = await runGit(
    rootDir,
    ["for-each-ref", "--format=%(refname)", "refs/replace"],
    deps,
    "inspect replacement refs",
  );
  if (replacements.code !== 0) failure("Git could not inspect replacement refs.");
  if (outputLines(replacements.stdout).length > 0) {
    refusal("local Git replacement refs can alter ancestry and must be removed before adoption.");
  }

  const status = await runGit(
    rootDir,
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
    deps,
    "inspect the working tree",
  );
  if (status.code !== 0) failure("Git could not inspect the working tree.");
  if (status.stdout.length > 0) {
    refusal("the working tree is not clean, including untracked files or dirty submodules.");
  }

  const branch = await runGit(
    rootDir,
    ["symbolic-ref", "--quiet", "HEAD"],
    deps,
    "inspect HEAD attachment",
  );
  if (branch.code === 0) {
    refusal(
      "HEAD is attached to a local branch. Check out the intended commit with --detach first.",
    );
  }
  if (branch.code !== 1) failure("Git could not determine whether HEAD is detached.");

  const headResult = await runGit(rootDir, ["rev-parse", "--verify", "HEAD"], deps, "resolve HEAD");
  if (headResult.code !== 0) failure("Git could not resolve HEAD.");
  const head = exactlyOne(outputLines(headResult.stdout), "HEAD");
  if (!OBJECT_ID_PATTERN.test(head)) failure("Git returned an invalid HEAD object ID.");

  const rawOriginResult = await runGit(
    rootDir,
    ["config", "--local", "--no-includes", "--get-all", "remote.origin.url"],
    deps,
    "read origin",
  );
  if (rawOriginResult.code === 1) refusal("the checkout has no repository-local origin URL.");
  if (rawOriginResult.code !== 0) failure("Git could not read origin.");
  const rawOrigin = exactlyOne(outputLines(rawOriginResult.stdout), "the origin URL");
  assertOfficialOrigin(rawOrigin, "the repository-local origin URL");

  const effectiveOriginResult = await runGit(
    rootDir,
    ["remote", "get-url", "--all", "origin"],
    deps,
    "resolve origin",
  );
  if (effectiveOriginResult.code !== 0) failure("Git could not resolve origin.");
  const effectiveOrigin = exactlyOne(
    outputLines(effectiveOriginResult.stdout),
    "the effective origin URL",
  );
  assertOfficialOrigin(effectiveOrigin, "the effective origin URL");

  const marker = await readMarker(rootDir, deps, expectedMarker);
  return {
    rootIdentity: identityKey(root),
    gitIdentity: identityKey(git),
    configIdentity: identityKey(config),
    head,
    rawOrigin,
    effectiveOrigin,
    marker,
  };
}

function assertSnapshotUnchanged(
  before: LocalCheckoutSnapshot,
  after: LocalCheckoutSnapshot,
): void {
  if (
    before.rootIdentity !== after.rootIdentity ||
    before.gitIdentity !== after.gitIdentity ||
    before.configIdentity !== after.configIdentity ||
    before.head !== after.head ||
    before.rawOrigin !== after.rawOrigin ||
    before.effectiveOrigin !== after.effectiveOrigin ||
    before.marker !== after.marker
  ) {
    refusal(
      "the checkout changed while its remote provenance was being verified; retry from a stable tree.",
    );
  }
}

function assertCheckoutCoreUnchanged(
  before: LocalCheckoutSnapshot,
  after: LocalCheckoutSnapshot,
): void {
  if (
    before.rootIdentity !== after.rootIdentity ||
    before.gitIdentity !== after.gitIdentity ||
    before.head !== after.head ||
    before.rawOrigin !== after.rawOrigin ||
    before.effectiveOrigin !== after.effectiveOrigin
  ) {
    refusal(
      "the checkout changed while its ownership marker was being committed; inspect it before retrying.",
    );
  }
}

async function assertReleaseManifest(
  rootDir: string,
  head: string,
  tags: readonly string[],
  deps: SourceAdoptionDeps,
): Promise<void> {
  const manifest = await runGit(
    rootDir,
    ["show", `${head}:packages/cli/package.json`],
    deps,
    "read the release manifest",
  );
  if (manifest.code !== 0) {
    refusal("the live release commit does not contain the CLI package manifest.");
  }
  let version: string | undefined;
  try {
    version = (JSON.parse(manifest.stdout) as { version?: unknown }).version as string | undefined;
  } catch {
    refusal("the live release commit contains an invalid CLI package manifest.");
  }
  if (typeof version !== "string" || !tags.some((tag) => versionFromStableTag(tag) === version)) {
    refusal("the live release tag disagrees with the version in its CLI package manifest.");
  }
}

async function proveRemoteProvenance(
  rootDir: string,
  head: string,
  deps: SourceAdoptionDeps,
): Promise<void> {
  const remote = await runGit(
    rootDir,
    ["ls-remote", "origin", "refs/heads/main", "refs/tags/v*"],
    deps,
    "query the official origin",
  );
  if (remote.code !== 0) {
    refusal(
      "the official origin could not be queried, so no fresh release or main-branch proof exists.",
    );
  }

  let refs: SourceAdoptionRemoteRefs;
  try {
    refs = parseSourceAdoptionRemoteRefs(remote.stdout);
  } catch (error) {
    failure(`the official origin returned invalid refs: ${errorMessage(error)}`);
  }
  const releaseTags = refs.stableTags.get(head);
  if (releaseTags) {
    await assertReleaseManifest(rootDir, head, releaseTags, deps);
    return;
  }
  if (!refs.main) {
    refusal("HEAD is not a live stable release and the official origin did not advertise main.");
  }

  const fetch = await runGit(
    rootDir,
    ["fetch", "--no-tags", "--no-write-fetch-head", "origin", refs.main],
    deps,
    "fetch the freshly advertised main commit",
  );
  if (fetch.code !== 0) {
    refusal(
      "the freshly advertised main commit could not be fetched; cached origin/main is not accepted as proof.",
    );
  }
  const ancestry = await runGit(
    rootDir,
    ["merge-base", "--is-ancestor", head, refs.main],
    deps,
    "verify main-branch ancestry",
  );
  if (ancestry.code === 1) {
    refusal(
      "HEAD is neither a live stable release nor reachable from the freshly advertised main branch.",
    );
  }
  if (ancestry.code !== 0) {
    refusal(
      "Git could not prove HEAD is reachable from the freshly advertised main branch; shallow or incomplete history must be repaired first.",
    );
  }
}

function exactValuePattern(value: string): string {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
}

async function removeMarkerValue(
  rootDir: string,
  value: string,
  deps: SourceAdoptionDeps,
): Promise<string> {
  try {
    const cleanup = await deps.run(
      gitSpec(rootDir, [
        "config",
        "--local",
        "--no-includes",
        "--unset-all",
        "omnesis.install",
        exactValuePattern(value),
      ]),
    );
    // `git config --unset-all` uses 5 when the exact value is already absent.
    if (cleanup.code === 0 || cleanup.code === 5) return "";
    return ` Cleanup also failed with exit code ${cleanup.code}.`;
  } catch (error) {
    return ` Cleanup also failed: ${errorMessage(error)}.`;
  }
}

/**
 * Verify a hand-made checkout against its live official remote, then write
 * only the repository-local ownership marker. The first ordinary update
 * deliberately sees no completion record and rebuilds the checkout.
 */
export async function adoptSourceCheckout(
  requestedRootDir: string,
  deps: SourceAdoptionDeps,
): Promise<void> {
  const rootDir = resolve(requestedRootDir);
  if (!isAbsolute(requestedRootDir) || rootDir !== requestedRootDir) {
    refusal("the detected repository root must be an absolute canonical path.");
  }

  const before = await inspectLocalCheckout(rootDir, deps);
  await proveRemoteProvenance(rootDir, before.head, deps);
  const after = await inspectLocalCheckout(rootDir, deps);
  assertSnapshotUnchanged(before, after);

  if (before.marker === "managed") {
    deps.log("This source checkout is already managed; verification passed.");
    return;
  }

  const nonce = (deps.nonce ?? randomUUID)();
  if (!/^[0-9A-Za-z-]+$/u.test(nonce)) failure("the adoption nonce was invalid.");
  const claim = `adopting:${nonce}`;
  const pending = `managed-pending:${nonce}`;

  let write: SourceAdoptionRunOutcome;
  try {
    write = await deps.run(
      gitSpec(rootDir, ["config", "--local", "--no-includes", "--add", "omnesis.install", claim]),
    );
  } catch (error) {
    const cleanup = await removeMarkerValue(rootDir, claim, deps);
    failure(`Git could not claim the ownership marker: ${errorMessage(error)}.${cleanup}`);
  }
  if (write.code !== 0) {
    const cleanup = await removeMarkerValue(rootDir, claim, deps);
    failure(`Git could not claim the ownership marker (exit ${write.code}).${cleanup}`);
  }

  try {
    const claimed = await inspectLocalCheckout(rootDir, deps, claim);
    assertCheckoutCoreUnchanged(before, claimed);
  } catch (error) {
    const cleanup = await removeMarkerValue(rootDir, claim, deps);
    failure(`the ownership claim could not be verified: ${errorMessage(error)}.${cleanup}`);
  }

  let promote: SourceAdoptionRunOutcome;
  try {
    promote = await deps.run(
      gitSpec(rootDir, [
        "config",
        "--local",
        "--no-includes",
        "--replace-all",
        "omnesis.install",
        pending,
        exactValuePattern(claim),
      ]),
    );
  } catch (error) {
    const cleanup = await removeMarkerValue(rootDir, claim, deps);
    failure(`Git could not stage the ownership marker: ${errorMessage(error)}.${cleanup}`);
  }
  if (promote.code !== 0) {
    const cleanup = await removeMarkerValue(rootDir, claim, deps);
    failure(`Git could not stage the ownership marker (exit ${promote.code}).${cleanup}`);
  }

  try {
    const staged = await inspectLocalCheckout(rootDir, deps, pending);
    assertCheckoutCoreUnchanged(before, staged);
  } catch (error) {
    const cleanup = await removeMarkerValue(rootDir, pending, deps);
    failure(`the staged ownership marker could not be verified: ${errorMessage(error)}.${cleanup}`);
  }

  let commit: SourceAdoptionRunOutcome;
  try {
    commit = await deps.run(
      gitSpec(rootDir, [
        "config",
        "--local",
        "--no-includes",
        "--replace-all",
        "omnesis.install",
        "managed",
        exactValuePattern(pending),
      ]),
    );
  } catch (error) {
    const cleanup = await removeMarkerValue(rootDir, pending, deps);
    failure(`Git could not commit the ownership marker: ${errorMessage(error)}.${cleanup}`);
  }
  if (commit.code !== 0) {
    const cleanup = await removeMarkerValue(rootDir, pending, deps);
    failure(`Git could not commit the ownership marker (exit ${commit.code}).${cleanup}`);
  }

  try {
    await readMarker(rootDir, deps, "managed");
  } catch (error) {
    failure(
      "the committed ownership marker could not be confirmed. Its canonical value was left " +
        `in place so another writer's marker cannot be deleted; inspect it explicitly: ${errorMessage(error)}.`,
    );
  }

  deps.log(
    "Adopted this source checkout. Its first managed update will rebuild it and install recovery support.",
  );
}
