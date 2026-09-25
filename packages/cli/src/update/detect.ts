// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure logic for `omnesis update`: install-method detection,
 * channel→dist-tag mapping, version comparison, the exact command lines each
 * update path runs, which roles this host actually has, and the ordered work
 * those roles imply — including the way back when an update fails. No IO of
 * its own — filesystem access is injected so every function here is
 * unit-testable against fake layouts. The command shell, which owns process
 * spawning, the gateway API calls and the prompts, lives in
 * `../commands/update.ts`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  COLLECTOR_PAIRING_STATE_FILE,
  GATEWAY_STORE_FILE,
  HARDENED_ADMIN_COMMAND,
  HARDENED_ADMIN_PATH,
  HARDENED_BOOTSTRAP_URL,
  HARDENED_CONFIG_DIR,
  HARDENED_UNIT_NAME,
  HARDENED_UNIT_PATH,
  launchdLabel,
  launchdPlistPath,
  systemdUnitName,
  systemdUnitPath,
  type ServiceComponent,
} from "@omnesis/core";
import {
  CLI_PACKAGE,
  IMAGE_TAG_KEY,
  normalizeVersion,
  type InstallMethod,
} from "@omnesis/core/release-check";
import type { Harness } from "../harness-skills.js";

export {
  CLI_PACKAGE,
  DEFAULT_PACKAGE_INDEX_URL,
  DOCKER_ENV_FILE,
  IMAGE_TAG_KEY,
  detectDockerInstall,
  detectInstallMethod,
  isResolvedVersion,
  newestStableTag,
  nodeDetectFs,
  normalizeVersion,
  packageIndexUrl,
  versionFromStableTag,
  type DetectFs,
  type InstallMethod,
} from "@omnesis/core/release-check";

/** Durable updater state, stored owner-only under the config directory. */
export const UPDATE_STATE_FILE = "update-state.json";

// ── Channels ────────────────────────────────────────────────────────────

export const UPDATE_CHANNELS = ["stable", "beta"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

const CHANNEL_DIST_TAGS: Record<UpdateChannel, string> = {
  stable: "latest",
  beta: "beta",
};

/** Map a release channel to the npm dist-tag it tracks. */
export function channelToDistTag(channel: UpdateChannel): string {
  return CHANNEL_DIST_TAGS[channel];
}

/** Parse untrusted `--channel` input; `null` when it isn't a known channel. */
export function parseChannel(raw: string): UpdateChannel | null {
  return (UPDATE_CHANNELS as readonly string[]).includes(raw) ? (raw as UpdateChannel) : null;
}

// ── Version comparison ──────────────────────────────────────────────────

/** True when the installed version already matches the channel's target. */
export function isUpToDate(currentVersion: string, targetVersion: string): boolean {
  return normalizeVersion(currentVersion) === normalizeVersion(targetVersion);
}

/**
 * Compare two versions by their numeric `major.minor.patch` core. Returns
 * `-1` / `0` / `1` for `a < b` / `a === b` / `a > b`. A pre-release suffix
 * (`-beta.1`) is ignored for the core comparison — enough to tell an upgrade
 * from a downgrade, which is all the update preflight needs.
 */
export function compareSemver(a: string, b: string): number {
  const core = (v: string): number[] =>
    normalizeVersion(v)
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = core(a);
  const pb = core(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

const STABLE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The stable tag for one exact version, out of untrusted `git ls-remote`
 * output — or null when the remote carries no such release.
 *
 * This is the refusal that makes a gateway-commanded update safe. The
 * version arrives over a socket from something the host has decided to
 * believe, but the tag has to exist on the host's own remote before a single
 * command runs against it. A gateway that has been tampered with can name
 * anything; it cannot conjure a release on a repository it does not control,
 * and the manifest check that follows the checkout closes the rest.
 */
export function stableTagForVersion(lsRemoteOutput: string, version: string): string | null {
  const wanted = `v${normalizeVersion(version)}`;
  if (!STABLE_TAG_PATTERN.test(wanted)) return null;
  const found = lsRemoteOutput
    .split(/\r?\n/)
    .some(
      (line) =>
        line.match(/refs\/tags\/(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/)?.[1] ===
        wanted,
    );
  return found ? wanted : null;
}

export type UpdateDirection = "upgrade" | "downgrade" | "same";

export interface UpdateAssessment {
  readonly direction: UpdateDirection;
  readonly current: string;
  readonly target: string;
  /** Human-readable notes to print before the user confirms. */
  readonly notes: string[];
  /**
   * True when the transition is unsafe-by-default and the command must refuse
   * without `--force` — currently a downgrade, which an older binary handles
   * only by resetting sources whose cursors a newer schema wrote.
   */
  readonly requiresForce: boolean;
}

/**
 * Classify an update before it runs. Omnesis has no down-migrations: an
 * upgrade migrates the DB forward (effectively irreversible without a
 * backup), and a downgrade is absorbed by the gateway's per-source cursor
 * reset rather than a schema rollback. This turns those facts into the
 * warnings the update flow prints — and the block it puts in front of a
 * downgrade. Pure: target/current are the only inputs.
 */
export function assessUpdate(currentVersion: string, targetVersion: string): UpdateAssessment {
  const current = normalizeVersion(currentVersion);
  const target = normalizeVersion(targetVersion);
  const cmp = compareSemver(target, current);
  const direction: UpdateDirection = cmp > 0 ? "upgrade" : cmp < 0 ? "downgrade" : "same";

  const notes: string[] = [];
  let requiresForce = false;
  if (direction === "upgrade") {
    notes.push(
      "This upgrade runs forward-only schema migrations on the gateway's next boot. " +
        "There are no down-migrations — back up first: omnesis backup --note pre-upgrade",
    );
  } else if (direction === "downgrade") {
    requiresForce = true;
    notes.push(
      `Downgrade ${current} → ${target}: the older binary cannot read a newer schema. ` +
        "It resets any source whose cursor a newer build wrote (they resync automatically); " +
        "restore a pre-upgrade backup if you need the exact prior state.",
    );
  }
  return { direction, current, target, notes, requiresForce };
}

// ── Update command lines ────────────────────────────────────────────────

/** One process invocation an update path runs. */
export interface CommandSpec {
  command: string;
  args: string[];
  /** Working directory; omitted = inherit the CLI's cwd. */
  cwd?: string;
  /** Variables set on top of the CLI's own environment. */
  env?: Record<string, string>;
  /**
   * A second attempt for a command whose failure can leave behind the state
   * that makes it fail again: when the command exits non-zero on its own,
   * `reset` runs and the command runs once more. `why` tells the operator
   * reading the output why the second attempt differs from the first.
   */
  retry?: { reset: CommandSpec; why: string };
}

/** `npm view omnesis@<tag> version` — resolve the channel's target version. */
export function npmViewVersionSpec(distTag: string, registry?: string): CommandSpec {
  const args = ["view", `${CLI_PACKAGE}@${distTag}`, "version"];
  if (registry) args.push("--registry", registry);
  return { command: "npm", args };
}

/**
 * `npm install -g omnesis@<spec>` — the npm-global update itself. The
 * caller passes the exact version it resolved, not the dist-tag it resolved
 * from, so a tag that moves between resolution and install cannot deliver a
 * different version than the one the user was shown.
 */
export function npmGlobalInstallSpec(versionOrTag: string, registry?: string): CommandSpec {
  const args = ["install", "-g", `${CLI_PACKAGE}@${versionOrTag}`];
  if (registry) args.push("--registry", registry);
  return { command: "npm", args };
}

// ── Docker command lines ────────────────────────────────────────────────

/**
 * An image tag as it may appear in an image reference: up to 128 characters,
 * which is docker's own limit. Checked wherever a tag enters the compose
 * project, because the value ends up in
 * `ghcr.io/omnesis-dev/omnesis-gateway:<tag>`.
 */
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Throw unless `tag` can stand as the tag half of an image reference. */
export function assertImageTag(tag: string): void {
  if (!IMAGE_TAG_PATTERN.test(tag)) {
    throw new Error(`Refusing to record '${tag}' as an image tag.`);
  }
}

/**
 * One `OMNESIS_IMAGE_TAG=…` assignment in the env file, with its raw value.
 * An `export ` prefix is part of the assignment; whitespace around the `=` is
 * not, because compose reads `OMNESIS_IMAGE_TAG =0.4.2` as a key whose name
 * ends in a space — a different key, and not the one the services resolve.
 */
const IMAGE_TAG_ASSIGNMENT = new RegExp(String.raw`^\s*(?:export\s+)?${IMAGE_TAG_KEY}=(.*)$`);

/**
 * One env-file value, read the way compose reads it: a single layer of
 * matching quotes comes off, and an unquoted value ends where an inline
 * comment starts. Anything else is taken literally — there is no `${VAR}`
 * interpolation here.
 */
function envValue(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    // An unterminated quote is not a value compose would resolve either; hand
    // it back as it stands and let the tag check refuse it.
    return end > 0 ? trimmed.slice(1, end) : trimmed;
  }
  const comment = trimmed.search(/\s#/u);
  return (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim();
}

/** `docker compose -f <composeFile> <args…>` — every compose call goes through this. */
export function dockerComposeSpec(composeFile: string, args: readonly string[]): CommandSpec {
  return { command: "docker", args: ["compose", "-f", composeFile, ...args] };
}

/**
 * Recreate one service's container so it runs the image the compose project
 * currently resolves. `up -d --no-deps` rather than `restart`: restarting a
 * container starts the same container from the same image, which would leave
 * a pulled image unused — and, on the way back, would leave the rolled-back
 * tag equally unused.
 */
export function dockerRestartSpec(composeFile: string, component: ServiceComponent): CommandSpec {
  return dockerComposeSpec(composeFile, ["up", "-d", "--no-deps", component]);
}

/**
 * The image tag a compose project resolves its services at, read from its env
 * file in the terms the rest of Omnesis reads that file in: the gateway loads
 * the same file as its own environment, so it carries lines this command did
 * not write — quoted values, `export ` prefixes, inline comments — and reading
 * them more narrowly here would report a tag as missing that every other
 * reader resolves.
 *
 * The last assignment wins, matching how compose itself reads a repeated key:
 * an earlier one names a tag the containers are not running. A value that
 * could not be part of an image reference reads as absent rather than being
 * handed on to docker.
 */
export function readImageTag(envFileText: string): string | null {
  let value: string | null = null;
  for (const line of envFileText.split(/\r?\n/)) {
    const match = line.match(IMAGE_TAG_ASSIGNMENT);
    if (match) value = envValue(match[1]!);
  }
  return value !== null && IMAGE_TAG_PATTERN.test(value) ? value : null;
}

/**
 * The source-checkout update sequence, run in the checkout root. The build
 * takes the environment the heap policy chose for this machine, as the
 * installer's build does.
 *
 * In a workspace checkout `npm ci` clears only the workspaces' own
 * `node_modules` and installs over the root's, reconciling the tree the
 * previous build left. npm's reconciliation can fail on a tree an earlier
 * build left — two packages linking the same `.bin` name, one of them
 * changing between the two lockfiles, is a known trigger — and its own
 * rollback then leaves the tree half-moved, so the same `npm ci` fails the
 * same way every time. A failed install is therefore retried once from an
 * empty `node_modules`, which is what a fresh install runs.
 */
export function sourceUpdateSpecs(
  rootDir: string,
  target = "vX.Y.Z",
  buildEnv?: Record<string, string>,
): CommandSpec[] {
  return [
    { command: "git", args: ["checkout", "--detach", target], cwd: rootDir },
    {
      command: "npm",
      args: ["ci"],
      cwd: rootDir,
      retry: {
        reset: { command: "rm", args: ["-rf", "node_modules"], cwd: rootDir },
        why: "installing the dependencies again from an empty node_modules",
      },
    },
    {
      command: "npm",
      args: ["run", "build"],
      cwd: rootDir,
      ...(buildEnv ? { env: buildEnv } : {}),
    },
  ];
}

const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Durable proof for one installer-managed source checkout. A non-complete
 * phase deliberately retains the last known-good commit: a process killed
 * during either the apply or its rollback can therefore repair from the same
 * baseline on the next run without mistaking a matching HEAD for a build.
 */
export type SourceApplyState =
  | {
      version: 1;
      method: "source";
      rootDir: string;
      phase: "complete";
      commit: string;
    }
  | {
      version: 1;
      method: "source";
      rootDir: string;
      phase: "applying" | "rolling-back";
      targetCommit: string;
      lastCompletedCommit: string;
    };

/**
 * The same proof for a container install. The recorded image tag is written
 * before the pull and says what the install is meant to run; only this
 * record, completed once the gateway answered on the new image, says it does.
 */
export type DockerApplyState =
  | {
      version: 1;
      method: "docker";
      projectDir: string;
      phase: "complete";
      tag: string;
    }
  | {
      version: 1;
      method: "docker";
      projectDir: string;
      phase: "applying" | "rolling-back";
      targetTag: string;
      lastCompletedTag: string;
    };

/**
 * One record per config directory, whichever method last applied there. A
 * package install writes none: npm stages the new tree and renames it into
 * place, and the version the updater compares is read from the installed
 * package itself, so an interrupted install either left the previous version
 * in place or finished — there is no written intent to strand.
 */
export type UpdateApplyState = SourceApplyState | DockerApplyState;

export type SourceApplyRecovery = "none" | "unrecorded" | "unfinished" | "mismatch";

export interface DockerApplyEvidence {
  /** True only when the record proves the recorded tag was served. */
  complete: boolean;
  /** The tag known to have been served, and therefore the rollback baseline. */
  previousTag: string;
  /** Why the apply cannot be skipped, for the operator-facing explanation. */
  recovery: SourceApplyRecovery;
  /**
   * The served version alone proved the recorded tag finished: no record
   * said so, and one should be written so the next run need not ask.
   */
  attested: boolean;
}

export interface SourceApplyEvidence {
  /** True only when both the checkout and the durable completion record agree. */
  complete: boolean;
  /** The build known to have completed, and therefore the rollback baseline. */
  previousCommit: string;
  /** Why the apply cannot be skipped, for the operator-facing explanation. */
  recovery: SourceApplyRecovery;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate the on-disk apply record. Invalid input proves nothing. */
export function parseUpdateApplyState(raw: string | null): UpdateApplyState | null {
  if (raw === null || !raw.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1) return null;
  if (value.method === "docker") return parseDockerApplyState(value);
  if (value.method !== "source" || typeof value.rootDir !== "string") return null;
  if (value.phase === "complete") {
    return typeof value.commit === "string" && SOURCE_COMMIT_PATTERN.test(value.commit)
      ? {
          version: 1,
          method: "source",
          rootDir: value.rootDir,
          phase: "complete",
          commit: value.commit,
        }
      : null;
  }
  if (value.phase !== "applying" && value.phase !== "rolling-back") return null;
  return typeof value.targetCommit === "string" &&
    SOURCE_COMMIT_PATTERN.test(value.targetCommit) &&
    typeof value.lastCompletedCommit === "string" &&
    SOURCE_COMMIT_PATTERN.test(value.lastCompletedCommit)
    ? {
        version: 1,
        method: "source",
        rootDir: value.rootDir,
        phase: value.phase,
        targetCommit: value.targetCommit,
        lastCompletedCommit: value.lastCompletedCommit,
      }
    : null;
}

/** The source half of the record, for readers that only ever deal in checkouts. */
export function parseSourceApplyState(raw: string | null): SourceApplyState | null {
  const state = parseUpdateApplyState(raw);
  return state?.method === "source" ? state : null;
}

function parseDockerApplyState(value: Record<string, unknown>): DockerApplyState | null {
  if (typeof value.projectDir !== "string") return null;
  if (value.phase === "complete") {
    return typeof value.tag === "string" && IMAGE_TAG_PATTERN.test(value.tag)
      ? {
          version: 1,
          method: "docker",
          projectDir: value.projectDir,
          phase: "complete",
          tag: value.tag,
        }
      : null;
  }
  if (value.phase !== "applying" && value.phase !== "rolling-back") return null;
  return typeof value.targetTag === "string" &&
    IMAGE_TAG_PATTERN.test(value.targetTag) &&
    typeof value.lastCompletedTag === "string" &&
    IMAGE_TAG_PATTERN.test(value.lastCompletedTag)
    ? {
        version: 1,
        method: "docker",
        projectDir: value.projectDir,
        phase: value.phase,
        targetTag: value.targetTag,
        lastCompletedTag: value.lastCompletedTag,
      }
    : null;
}

/** Stable wire representation shared by the updater and source installer. */
export function serializeUpdateApplyState(state: UpdateApplyState): string {
  return `${JSON.stringify(state)}\n`;
}

/**
 * Decide whether a source apply may be skipped. HEAD equality is necessary
 * but not sufficient: ignored dependencies and build output can still belong
 * to the previous release. Only a matching complete record proves the apply
 * crossed its final commit point.
 */
export function assessSourceApplyEvidence(
  rootDir: string,
  headCommit: string,
  targetCommit: string,
  rawState: string | null,
): SourceApplyEvidence {
  const parsed = parseSourceApplyState(rawState);
  const state = parsed?.rootDir === rootDir ? parsed : null;
  const invalid = rawState !== null && state === null;

  if (state?.phase === "complete") {
    const complete = state.commit === headCommit && headCommit === targetCommit;
    return {
      complete,
      previousCommit: state.commit,
      recovery: complete || state.commit === headCommit ? "none" : "mismatch",
    };
  }
  if (state) {
    return {
      complete: false,
      previousCommit: state.lastCompletedCommit,
      recovery: "unfinished",
    };
  }
  return {
    complete: false,
    previousCommit: headCommit,
    recovery: invalid ? "mismatch" : headCommit === targetCommit ? "unrecorded" : "none",
  };
}

/**
 * Decide whether a container apply may be skipped. The recorded tag equal to
 * the target is necessary but not sufficient: it is written before the pull.
 * A complete record for that tag proves the gateway served it; failing a
 * record, the version the gateway serves right now is asked, and a match is
 * taken as the proof the record would have been.
 */
export function assessDockerApplyEvidence(
  projectDir: string,
  recordedTag: string,
  targetTag: string,
  rawState: string | null,
  servedVersion: string | null,
): DockerApplyEvidence {
  const parsed = parseUpdateApplyState(rawState);
  const state = parsed?.method === "docker" && parsed.projectDir === projectDir ? parsed : null;
  const invalid = rawState !== null && state === null;
  const serves = (tag: string): boolean => servedVersion !== null && servedVersion === tag;

  if (state?.phase === "complete") {
    if (state.tag === recordedTag && recordedTag === targetTag) {
      // What the record proves and what is running must still agree: a
      // gateway answering with another version is not on this tag.
      const complete = servedVersion === null || serves(targetTag);
      return {
        complete,
        previousTag: complete ? state.tag : (servedVersion ?? state.tag),
        recovery: complete ? "none" : "mismatch",
        attested: false,
      };
    }
    // The tag on file moved without this record following it — an installer
    // re-run writes the tag and recreates the containers itself. What the
    // gateway serves decides, as it does with no record at all.
    if (recordedTag === targetTag && serves(targetTag)) {
      return { complete: true, previousTag: targetTag, recovery: "none", attested: true };
    }
    return {
      complete: false,
      previousTag: servedVersion ?? state.tag,
      recovery: state.tag === recordedTag ? "none" : "mismatch",
      attested: false,
    };
  }
  if (state) {
    return {
      complete: false,
      previousTag: state.lastCompletedTag,
      recovery: "unfinished",
      attested: false,
    };
  }
  if (recordedTag === targetTag) {
    if (serves(targetTag)) {
      return { complete: true, previousTag: targetTag, recovery: "none", attested: true };
    }
    return {
      complete: false,
      previousTag: servedVersion ?? recordedTag,
      recovery: invalid ? "mismatch" : "unrecorded",
      attested: false,
    };
  }
  return { complete: false, previousTag: recordedTag, recovery: "none", attested: false };
}

export function completedDockerApplyState(projectDir: string, tag: string): DockerApplyState {
  return { version: 1, method: "docker", projectDir, phase: "complete", tag };
}

export function activeDockerApplyState(
  projectDir: string,
  phase: "applying" | "rolling-back",
  targetTag: string,
  lastCompletedTag: string,
): DockerApplyState {
  return { version: 1, method: "docker", projectDir, phase, targetTag, lastCompletedTag };
}

export function completedSourceApplyState(rootDir: string, commit: string): SourceApplyState {
  return { version: 1, method: "source", rootDir, phase: "complete", commit };
}

export function activeSourceApplyState(
  rootDir: string,
  phase: "applying" | "rolling-back",
  targetCommit: string,
  lastCompletedCommit: string,
): SourceApplyState {
  return {
    version: 1,
    method: "source",
    rootDir,
    phase,
    targetCommit,
    lastCompletedCommit,
  };
}

export function sourceStatusSpec(rootDir: string): CommandSpec {
  return { command: "git", args: ["status", "--porcelain"], cwd: rootDir };
}

export function sourceManagedSpec(rootDir: string): CommandSpec {
  return {
    command: "git",
    args: ["config", "--local", "--no-includes", "--get-all", "omnesis.install"],
    cwd: rootDir,
  };
}

export function sourceTargetVersionSpec(rootDir: string, target: string): CommandSpec {
  return {
    command: "git",
    args: ["show", `${target}:packages/cli/package.json`],
    cwd: rootDir,
  };
}

/**
 * `git log <target>..<baseline>` — the commits a checkout on `baseline` has
 * that `target` does not, newest first, as `<short sha> <subject>` lines.
 * What an update from `baseline` to `target` leaves behind.
 */
export function sourceLeftBehindSpec(
  rootDir: string,
  target: string,
  baseline: string,
  limit: number,
): CommandSpec {
  return {
    command: "git",
    args: ["log", "--format=%h %s", `--max-count=${limit}`, `${target}..${baseline}`],
    cwd: rootDir,
  };
}

/**
 * `git merge-base <target> <baseline>` — exits 1 with no output when the two
 * commits share no history at all, which is what a checkout sees after the
 * repository's history was replaced by a new root.
 */
export function sourceMergeBaseSpec(
  rootDir: string,
  target: string,
  baseline: string,
): CommandSpec {
  return { command: "git", args: ["merge-base", target, baseline], cwd: rootDir };
}

/**
 * `git rev-parse --is-shallow-repository` — a shallow checkout (an exact-commit
 * install fetches one commit) also has no merge base with a release it lacks,
 * so "no shared history" only means a replaced history when this prints
 * `false`.
 */
export function sourceIsShallowSpec(rootDir: string): CommandSpec {
  return { command: "git", args: ["rev-parse", "--is-shallow-repository"], cwd: rootDir };
}

/**
 * `git rev-list -n 1 <ref>` — the commit a ref resolves to. What decides
 * whether a checkout is already on the target: the lockstep product version
 * in `package.json` is written into `main` before the tag is cut, so every
 * commit after a release reports that release's version and comparing
 * versions would call an unreleased build "already there".
 */
export function sourceRefShaSpec(rootDir: string, ref: string): CommandSpec {
  return { command: "git", args: ["rev-list", "-n", "1", ref], cwd: rootDir };
}

export function sourceAncestrySpec(
  rootDir: string,
  target: string,
  baseline = "HEAD",
): CommandSpec {
  return {
    command: "git",
    args: ["merge-base", "--is-ancestor", baseline, target],
    cwd: rootDir,
  };
}

/**
 * Fetch the update's target. Every form names its refspec on the command line,
 * so the checkout's configured `remote.origin.fetch` never takes part: a
 * checkout cloned from one release tag is configured to fetch that tag, and a
 * plain `git fetch origin` fails outright once origin no longer has it (after
 * the repository's history is replaced). The stable form fetches only the
 * release tag the update chose, without `+`, so it never overwrites a local tag
 * of the same name that points elsewhere. The edge form forces the
 * remote-tracking ref, which must follow `main` even when it no longer
 * descends from what was fetched before; the ancestry and version checks that
 * follow decide whether the checkout moves.
 */
export function sourceFetchSpec(rootDir: string, edge: boolean, stableTag: string): CommandSpec {
  return {
    command: "git",
    args: edge
      ? ["fetch", "origin", "+main:refs/remotes/origin/main"]
      : ["fetch", "--no-tags", "origin", `refs/tags/${stableTag}:refs/tags/${stableTag}`],
    cwd: rootDir,
  };
}

/** Fetch one exact source commit from the checkout's configured origin. */
export function sourceFetchCommitSpec(rootDir: string, commit: string): CommandSpec {
  return { command: "git", args: ["fetch", "origin", commit], cwd: rootDir };
}

export function sourceRemoteTagsSpec(rootDir: string): CommandSpec {
  return {
    command: "git",
    args: ["ls-remote", "--tags", "--refs", "origin", "refs/tags/v*"],
    cwd: rootDir,
  };
}

/** Render a spec as the shell line a user could copy-paste. */
export function formatCommandSpec(spec: CommandSpec): string {
  return [spec.command, ...spec.args].join(" ");
}

/** Manual fallback shown when the install method can't be determined. */
export function manualUpdateInstructions(): string[] {
  return [
    "Could not determine how this CLI was installed — it is neither a global npm",
    "install nor an installer-managed source checkout.",
    "",
    "Re-run the installer to create or repair a managed installation:",
    "  curl -fsSL https://omnesis.dev/install.sh | sh",
  ];
}

// ── Choosing an update path ─────────────────────────────────────────────

/** Flags `omnesis update` accepts that select or constrain a path. */
export interface UpdateFlags {
  edge: boolean;
  /** Raw `--channel` value; `"stable"` is the default and means "unset". */
  channel: string;
  registry?: string;
}

/**
 * Which update flow to run, or why none can run.
 *
 * `refuse` covers a flag that is meaningless for how this CLI was installed.
 * Ignoring such a flag would run an update the caller did not ask for — a
 * package install told to follow `--edge` would silently take a stable
 * release, and a source checkout told to use a `--registry` would silently
 * check out a tag from git instead.
 */
export type UpdatePlan =
  | { kind: "npm-global"; channel: UpdateChannel; registry?: string }
  | { kind: "source"; rootDir: string; edge: boolean }
  /**
   * A container install. `edge` is allowed here and selects the `main` image
   * tag, which the release pipeline moves with the branch — the container
   * equivalent of a source checkout following `origin/main`.
   */
  | { kind: "docker"; composeFile: string; projectDir: string; edge: boolean }
  | { kind: "refuse"; message: string }
  | { kind: "manual" };

export function planUpdate(detection: InstallMethod, flags: UpdateFlags): UpdatePlan {
  const channel = parseChannel(flags.channel);
  if (!channel) {
    return {
      kind: "refuse",
      message: `Unknown --channel: ${flags.channel} (expected ${UPDATE_CHANNELS.join(" | ")}).`,
    };
  }
  if (detection.method === "unknown") return { kind: "manual" };
  if (detection.method === "npm-global") {
    if (flags.edge) {
      return {
        kind: "refuse",
        message:
          "--edge follows the main branch and applies to a source checkout. " +
          "This CLI was installed from a package — use --channel beta for prereleases.",
      };
    }
    return { kind: "npm-global", channel, registry: flags.registry };
  }
  if (detection.method === "docker") {
    if (flags.registry !== undefined) {
      return {
        kind: "refuse",
        message:
          "--registry selects the npm registry a package install is installed from. " +
          "This installation runs from container images: it reads the newest release number " +
          "from the package index (OMNESIS_PACKAGE_INDEX_URL overrides it) and pulls that tag " +
          "from a container registry, and --registry selects neither.",
      };
    }
    if (channel !== "stable") {
      return {
        kind: "refuse",
        message:
          `--channel ${channel} selects an npm dist-tag and applies to a package install. ` +
          "This installation runs from container images — use --edge to follow the main tag.",
      };
    }
    return {
      kind: "docker",
      composeFile: detection.composeFile,
      projectDir: detection.projectDir,
      edge: flags.edge,
    };
  }
  if (flags.registry !== undefined) {
    return {
      kind: "refuse",
      message:
        "--registry selects an npm registry and applies to a package install. " +
        "This CLI runs from a source checkout, which resolves releases from its own git origin.",
    };
  }
  if (channel !== "stable") {
    return {
      kind: "refuse",
      message:
        `--channel ${channel} selects an npm dist-tag and applies to a package install. ` +
        "This CLI runs from a source checkout — use --edge to follow the main branch.",
    };
  }
  return { kind: "source", rootDir: detection.rootDir, edge: flags.edge };
}

// ── Host roles ──────────────────────────────────────────────────────────

/**
 * Filesystem accessors the host-role scan needs — injectable for tests.
 * `readFile` returns `null` when the file is absent or unreadable, and
 * `listDir` returns `[]` for a directory that is not there, so a caller never
 * has to distinguish "nothing installed" from "cannot look".
 */
export interface HostScanFs {
  exists(path: string): boolean;
  readFile(path: string): string | null;
  listDir(path: string): string[];
}

export const nodeHostScanFs: HostScanFs = {
  exists: (p) => existsSync(p),
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  listDir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
};

/** How one Omnesis daemon is installed on this host. */
export interface ComponentRole {
  /** This host holds that component's own state, so it has the role. */
  present: boolean;
  /** This command can restart it: a unit it owns, under this account. */
  supervised: boolean;
  /**
   * What an operator must run to restart it themselves — a hardened unit
   * belongs to root, and a named instance is not the unit this command
   * drives. `null` when nothing on this host supervises it at all, in which
   * case only the operator knows how it was started.
   */
  manualRestart: string | null;
  /** Other units for the same component that this command must not ignore. */
  conflictingServices?: readonly string[];
  /**
   * A dedicated-account gateway: root moves it to another release, with the
   * admin command where it is installed, and with the install otherwise.
   */
  hardened?: { adminInstalled: boolean };
  /**
   * Known not to be running: no process holds this host's gateway lock, so its
   * stores are closed and nothing serves the previous build. Only the gateway
   * is read this way, and only where its lock lives in this config directory.
   */
  stopped?: boolean;
}

/** An agent harness on this host that Omnesis is connected to. */
export interface HarnessRole {
  harness: Harness;
  /** The harness's home directory, as `../commands/connect.ts` resolved it. */
  home: string;
  /**
   * True when the saved integration has no OAuth refresh token, so
   * re-authorizing it needs a human at a browser. The updater refuses to
   * start that flow unattended and prints the command instead.
   */
  needsAuthorization: boolean;
}

/** Everything one host does, as read off the host itself. */
export interface HostRoles {
  gateway: ComponentRole;
  collector: ComponentRole;
  harnesses: readonly HarnessRole[];
}

/** Where to look. Resolved by the caller so the scan itself stays pure. */
export interface HostLayout {
  platform: NodeJS.Platform;
  homeDir: string;
  /** `OMNESIS_CONFIG_DIR` or its default — where daemon state lives. */
  configDir: string;
  /** Each harness this CLI knows about, with its home already resolved. */
  harnessHomes: ReadonlyArray<{ harness: Harness; home: string }>;
  /**
   * Whether a gateway process holds this config directory's gateway lock right
   * now. A process probe rather than a file read, so the caller takes it;
   * absent when not known, which leaves the gateway role as the files say.
   */
  gatewayRunning?: boolean;
}

/** Saved credentials `omnesis connect` writes under a harness home. */
export function harnessIntegrationPath(home: string): string {
  return join(home, "omnesis", "integration.json");
}

/**
 * Whether the default service unit for `component` — the one this command
 * drives — is installed for this user.
 */
export function serviceUnitInstalled(
  platform: NodeJS.Platform,
  homeDir: string,
  component: ServiceComponent,
  fs: HostScanFs = nodeHostScanFs,
): boolean {
  if (platform === "linux") return fs.exists(systemdUnitPath(homeDir, component));
  if (platform === "darwin") return fs.exists(launchdPlistPath(homeDir, component));
  return false;
}

/** Directory the platform's user-level service units live in. */
function serviceUnitDir(platform: NodeJS.Platform, homeDir: string): string | null {
  if (platform === "linux") return join(homeDir, ".config", "systemd", "user");
  if (platform === "darwin") return join(homeDir, "Library", "LaunchAgents");
  return null;
}

/**
 * A name no operator can pass to `--instance`, used to read the fixed parts
 * of an instanced unit's file name out of the naming functions themselves.
 * Deriving them rather than restating them is what keeps this in step with
 * `@omnesis/core` — the two platforms separate the instance differently, and
 * a hand-written pattern silently stops matching when either changes.
 */
const INSTANCE_PROBE = "INSTANCEPROBE";

/** The instance name an operator may pass to `omnesis service --instance`. */
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * Named parallel instances of `component` installed for this user, in the
 * order the directory lists them. `omnesis service install --instance <name>`
 * writes units whose names carry that name; this command drives only the
 * unnamed one, so an instance is a daemon it must report rather than restart.
 */
function serviceUnitInstanceNames(
  platform: NodeJS.Platform,
  homeDir: string,
  component: ServiceComponent,
  fs: HostScanFs = nodeHostScanFs,
): string[] {
  const dir = serviceUnitDir(platform, homeDir);
  if (!dir) return [];
  const probeName =
    platform === "linux"
      ? systemdUnitName(component, INSTANCE_PROBE)
      : `${launchdLabel(component, INSTANCE_PROBE)}.plist`;
  const [prefix, suffix] = probeName.split(INSTANCE_PROBE);
  if (prefix === undefined || suffix === undefined) return [];
  return fs
    .listDir(dir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
    .map((entry) => entry.slice(prefix.length, entry.length - suffix.length))
    .filter((name) => name !== "");
}

export function serviceUnitInstances(
  platform: NodeJS.Platform,
  homeDir: string,
  component: ServiceComponent,
  fs: HostScanFs = nodeHostScanFs,
): string[] {
  return serviceUnitInstanceNames(platform, homeDir, component, fs).filter((name) =>
    INSTANCE_NAME.test(name),
  );
}

/**
 * Whether refreshing this harness integration would need a human. The OAuth
 * grant renews itself silently while a refresh token is on file; without one
 * the flow opens a consent page and waits, which is not something an update
 * may do unattended.
 *
 * Anything unreadable or unparseable counts as "needs a human" — the update
 * must not silently skip an integration it could not inspect.
 */
export function harnessNeedsAuthorization(integrationJson: string | null): boolean {
  if (integrationJson === null) return true;
  try {
    const parsed = JSON.parse(integrationJson) as {
      oauth?: { tokens?: { refresh_token?: unknown } };
    };
    const refresh = parsed.oauth?.tokens?.refresh_token;
    return typeof refresh !== "string" || refresh.length === 0;
  } catch {
    return true;
  }
}

/**
 * What this host actually runs, read off the host rather than guessed: the
 * gateway's store and the collector's pairing state say which daemons have
 * state here, the service units say which of them this command may restart,
 * and an integration file under a harness home says an agent harness is
 * connected.
 *
 * A component can be present without being supervised — a container, or an
 * install that skipped service registration. The update plan then tells the
 * operator what to restart instead of restarting it.
 */
export function detectHostRoles(layout: HostLayout, fs: HostScanFs = nodeHostScanFs): HostRoles {
  const { platform, homeDir, configDir } = layout;

  /**
   * One component, from three readings: does this host hold its state, does
   * this account own the unit that drives it, and — when it does not — is
   * there some other unit an operator would restart by hand.
   */
  const role = (component: ServiceComponent, hasState: boolean): ComponentRole => {
    const own = serviceUnitInstalled(platform, homeDir, component, fs);
    const allInstances = serviceUnitInstanceNames(platform, homeDir, component, fs);
    const instances = allInstances.filter((name) => INSTANCE_NAME.test(name));
    const invalidInstances = allInstances.filter((name) => !INSTANCE_NAME.test(name));
    if (own) {
      return {
        present: true,
        supervised: true,
        manualRestart: null,
        ...(allInstances.length > 0
          ? {
              conflictingServices: allInstances.map((name) =>
                INSTANCE_NAME.test(name)
                  ? `${component} --instance ${name}`
                  : `${component} instance unit ${JSON.stringify(name)}`,
              ),
            }
          : {}),
      };
    }
    if (allInstances.length > 0) {
      return {
        present: true,
        supervised: false,
        manualRestart:
          invalidInstances.length > 0
            ? null
            : instances
                .map((name) => `omnesis service restart ${component} --instance ${name}`)
                .join(", "),
      };
    }
    return { present: hasState, supervised: false, manualRestart: null };
  };

  // A hardened gateway runs as root from its own state directory, so neither
  // this account's config dir nor its unit directory mentions it. Missing it
  // would mean skipping the backup on the one host that holds the corpus.
  const hardenedGateway =
    platform === "linux" &&
    (fs.exists(HARDENED_UNIT_PATH) || fs.exists(join(HARDENED_CONFIG_DIR, GATEWAY_STORE_FILE)));
  // Root moves a dedicated gateway to another release with its admin command.
  // A dedicated gateway set up before that command existed is moved by the
  // install, which reads the old unit's port and passphrase.
  const adminInstalled = hardenedGateway && fs.exists(HARDENED_ADMIN_PATH);

  const detectedGateway = role("gateway", fs.exists(join(configDir, GATEWAY_STORE_FILE)));
  // The lock only speaks for a gateway using this config directory: a named
  // instance keeps its own, and a dedicated gateway keeps its under root's.
  const gateway =
    layout.gatewayRunning === false &&
    detectedGateway.present &&
    !hardenedGateway &&
    serviceUnitInstanceNames(platform, homeDir, "gateway", fs).length === 0
      ? { ...detectedGateway, stopped: true }
      : detectedGateway;
  const collector = role("collector", fs.exists(join(configDir, COLLECTOR_PAIRING_STATE_FILE)));

  const harnesses: HarnessRole[] = [];
  for (const { harness, home } of layout.harnessHomes) {
    const path = harnessIntegrationPath(home);
    if (!fs.exists(path)) continue;
    harnesses.push({
      harness,
      home,
      needsAuthorization: harnessNeedsAuthorization(fs.readFile(path)),
    });
  }

  return {
    gateway:
      hardenedGateway && !gateway.supervised
        ? // Root owns the unit and the release it runs, so this command may
          // name the command that moves it but not run it.
          {
            present: true,
            supervised: false,
            manualRestart: adminInstalled
              ? `sudo ${HARDENED_ADMIN_COMMAND} update`
              : `curl -fsSL ${HARDENED_BOOTSTRAP_URL} | sudo sh -s -- install`,
            hardened: { adminInstalled },
          }
        : hardenedGateway
          ? {
              ...gateway,
              conflictingServices: [...(gateway.conflictingServices ?? []), HARDENED_UNIT_NAME],
            }
          : gateway,
    collector,
    harnesses,
  };
}

/**
 * What a container install runs, read off its compose project: a service
 * declared there is a daemon this host has, and one this command restarts by
 * recreating its container. Nothing else in the project counts — the updater
 * service is this command itself, and an agent harness is a process on the
 * operator's machine, never a container Omnesis ships.
 *
 * The scan is deliberately shallow rather than a YAML parse: only keys at the
 * indentation of the first entry under a top-level `services:` are service
 * names, so a `gateway:` appearing under a service's `depends_on:` — nested
 * deeper — is not one. A project written in a shape it does not read — quoted
 * service names, flow style — therefore yields no services at all, which the
 * caller has to refuse rather than act on.
 *
 * `composeFile` is the project's path, which is what a restart of one of these
 * containers is addressed by: there is no service manager inside a container
 * for `omnesis service restart` to drive.
 */
export function detectDockerRoles(composeFileText: string, composeFile: string): HostRoles {
  const services = new Set<string>();
  let inServices = false;
  let serviceIndent: number | null = null;
  for (const raw of composeFileText.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inServices = /^services:\s*(#.*)?$/.test(line.trim());
      serviceIndent = null;
      continue;
    }
    if (!inServices) continue;
    serviceIndent ??= indent;
    if (indent !== serviceIndent) continue;
    const name = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9_.-]*):/)?.[1];
    if (name) services.add(name);
  }

  const role = (name: ServiceComponent): ComponentRole => ({
    present: services.has(name),
    supervised: services.has(name),
    // The compose command that recreates the container, which is what an
    // operator restarting it by hand runs too — `omnesis service restart`
    // would run inside a container that has no service manager.
    manualRestart: services.has(name)
      ? formatCommandSpec(dockerRestartSpec(composeFile, name))
      : null,
  });
  return { gateway: role("gateway"), collector: role("collector"), harnesses: [] };
}

// ── The per-host plan ───────────────────────────────────────────────────

/**
 * One thing the update does on this host after its refusals have passed.
 * The list is ordered and the order is the contract: the backup precedes
 * anything irreversible, and the gateway is healthy again — its forward-only
 * migrations finished — before the devices it serves are restarted.
 */
export type UpdateStep =
  /**
   * The backup, before anything irreversible: through the gateway's API while
   * it runs, and — `offline` — as a copy of the closed stores of a gateway
   * that does not.
   */
  | { kind: "backup"; offline?: true }
  /**
   * Stop this account's collector while the build runs, on a machine whose
   * memory the build needs all of, and start it again after.
   */
  | { kind: "pause-collector" }
  /** Move the installation to the target, rolling back if it fails. */
  | { kind: "apply" }
  /**
   * Rewrite a supervised daemon's service definition where the release
   * generates a different one, ahead of the restart that loads it — or of the
   * hint, when this run restarts nothing.
   */
  | { kind: "service-definition"; component: ServiceComponent }
  | { kind: "restart"; component: ServiceComponent }
  /** Wait for the restarted gateway to serve again. */
  | { kind: "await-health" }
  /**
   * Present but not this command's to restart: say what to restart, and how
   * when the host knows (`command`), instead of restarting it.
   */
  | {
      kind: "restart-hint";
      component: ServiceComponent;
      command: string | null;
      /** Whether it still runs the previous build could not be told. */
      uncertain?: true;
    }
  /**
   * The gateway is not running, so nothing serves the previous build: its
   * stores migrate when it next starts, and its collector need not wait for it.
   */
  | { kind: "gateway-stopped" }
  | { kind: "harness-refresh"; harness: Harness }
  /** The grant needs a human — print the command rather than block on it. */
  | { kind: "harness-authorize"; harness: Harness }
  | { kind: "harness-restart"; harness: Harness }
  /** Refreshed, but the restart that loads it belongs to someone else. */
  | { kind: "harness-restart-hint"; harness: Harness; command: string };

export interface HostPlanOptions {
  /** False for `--no-backup`, which the operator takes responsibility for. */
  backup: boolean;
  /**
   * False when the caller restarts the daemons itself. Every restart becomes
   * a hint, and the health wait goes with the gateway restart that would have
   * justified it.
   *
   * This is what a device commanded by a fleet update passes. The command
   * runs as a child of the very daemon it would restart, so restarting from
   * here would kill the update mid-build; the daemon reports its result and
   * then exits for its own supervisor to bring it back. Defaults to true —
   * an operator at a terminal wants the restarts.
   */
  restart?: boolean;
  /**
   * What is known of the build each running daemon started from, for a run
   * that applies nothing because the installation is already on its target.
   * `true`: it started after the installation last finished changing, so it
   * runs the installed build and no restart is claimed for it. `null`: that
   * cannot be told, and a hint says it may still run the previous build.
   * `false` or absent: it predates the installed build — always the case on a
   * run that applies something.
   */
  runningBuild?: Partial<Record<ServiceComponent, boolean | null>>;
  /**
   * True where the supervised daemons run under unit files `omnesis service
   * install` wrote — launchd or systemd, not containers — so each one owed a
   * restart or a hint has its service definition brought to the release first.
   */
  serviceDefinitions?: boolean;
  /**
   * True when the apply builds on a machine whose memory leaves the build no
   * room beside a running collector. A supervised collector is stopped for the
   * apply; a gateway is not, since it serves through the build.
   */
  pauseCollectorForBuild?: boolean;
}

/**
 * Whether a daemon runs the installed build, from when it started and when
 * the installation last finished changing. Either one unknown leaves the
 * answer unknown.
 */
export function runsInstalledBuild(
  startedAtMs: number | null,
  installedAtMs: number | null,
): boolean | null {
  if (startedAtMs === null || installedAtMs === null) return null;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(installedAtMs)) return null;
  return startedAtMs >= installedAtMs;
}

/**
 * The ordered work one host's roles imply. Pure: the roles and the flags are
 * the only inputs, so every combination is a unit test.
 */
export function planHostUpdate(roles: HostRoles, opts: HostPlanOptions): UpdateStep[] {
  const steps: UpdateStep[] = [];
  const restarting = opts.restart !== false;
  const current = (component: ServiceComponent): boolean => opts.runningBuild?.[component] === true;
  const uncertain = (component: ServiceComponent): { uncertain?: true } =>
    opts.runningBuild?.[component] === null ? { uncertain: true } : {};
  const hint = (component: ServiceComponent, role: ComponentRole): UpdateStep => ({
    kind: "restart-hint",
    component,
    // The role's own command when it has one — a container is restarted by
    // recreating it, and a named service instance by naming it. A supervised
    // component with none is driven by this command's service manager, so the
    // canonical service command is what an operator would run for it.
    command: role.manualRestart ?? (role.supervised ? manualRestartCommand(component) : null),
    ...uncertain(component),
  });
  const definition = (component: ServiceComponent): UpdateStep[] =>
    opts.serviceDefinitions && roles[component].supervised
      ? [{ kind: "service-definition", component }]
      : [];

  if (roles.gateway.present && opts.backup) {
    steps.push(roles.gateway.stopped ? { kind: "backup", offline: true } : { kind: "backup" });
  }
  // Never on a run that restarts nothing: there this command is the collector's child.
  if (
    opts.pauseCollectorForBuild &&
    restarting &&
    roles.collector.present &&
    roles.collector.supervised
  ) {
    steps.push({ kind: "pause-collector" });
  }
  steps.push({ kind: "apply" });

  if (roles.gateway.present) {
    if (roles.gateway.supervised && restarting) {
      steps.push(...definition("gateway"), { kind: "restart", component: "gateway" });
      // The devices this gateway serves must not reconnect into a half-migrated
      // schema, so the wait sits between the two restarts rather than after them.
      steps.push({ kind: "await-health" });
    } else if (roles.gateway.stopped) {
      steps.push(...definition("gateway"), { kind: "gateway-stopped" });
    } else if (!current("gateway")) {
      steps.push(...definition("gateway"), hint("gateway", roles.gateway));
    }
  }
  if (roles.collector.present) {
    // A collector is only restarted once its own gateway is known to be
    // serving the new build. On a host whose gateway this command could not
    // restart, that is not known — so the collector is reported too, in the
    // order the operator has to do them, rather than reconnected to a gateway
    // still running the previous build. A gateway that is not running, or
    // that already runs the installed build, holds nothing back.
    const gatewayStillOld =
      roles.gateway.present &&
      !roles.gateway.stopped &&
      !current("gateway") &&
      (!roles.gateway.supervised || !restarting);
    if (roles.collector.supervised && restarting && !gatewayStillOld) {
      steps.push(...definition("collector"), { kind: "restart", component: "collector" });
    } else if (!current("collector")) {
      steps.push(
        ...definition("collector"),
        roles.collector.supervised && restarting
          ? // Withheld rather than absent: this command could restart it, and
            // says so, but not before its gateway is on the new build.
            {
              kind: "restart-hint",
              component: "collector",
              command: manualRestartCommand("collector"),
              ...uncertain("collector"),
            }
          : hint("collector", roles.collector),
      );
    }
  }
  for (const harness of roles.harnesses) {
    if (harness.needsAuthorization) {
      // The plugin is not reinstalled on this path, so a restart would have
      // nothing new to load.
      steps.push({ kind: "harness-authorize", harness: harness.harness });
      continue;
    }
    steps.push({ kind: "harness-refresh", harness: harness.harness });
    steps.push(
      restarting
        ? { kind: "harness-restart", harness: harness.harness }
        : {
            kind: "harness-restart-hint",
            harness: harness.harness,
            command: formatCommandSpec(harnessRestartSpec(harness.harness)),
          },
    );
  }
  return steps;
}

// ── Applying, and the way back ──────────────────────────────────────────

/**
 * How this installation moves to the target, and the exact way back if that
 * fails or the gateway does not come back. A half-applied update — new code
 * on disk, nothing serving — is the failure mode the rollback exists to
 * remove, so the way back is computed before the way forward is executed.
 */
export interface ApplyPlan {
  /** Commands that move the installation to the target. */
  readonly apply: readonly CommandSpec[];
  /** Commands that return it to what it was running. */
  readonly rollback: readonly CommandSpec[];
  /** What the apply moves to — the ref, version or tag, for the operator to read. */
  readonly target: string;
  /** What the rollback restores, for the operator to read. */
  readonly previous: string;
  /** Durable transaction states for an installer-managed checkout or container project. */
  readonly applyState?: {
    readonly applying: UpdateApplyState;
    readonly complete: UpdateApplyState;
    readonly rollingBack: UpdateApplyState;
    readonly rolledBack: UpdateApplyState;
    /**
     * When `complete` is written: after the apply commands succeed, for a
     * checkout whose build is the risky part; or at the end of the whole
     * plan, for containers whose apply only records intent and pulls — the
     * gateway serving the new image is what finishes that update.
     */
    readonly completeAt: "apply" | "end";
  };
}

/** `git rev-parse HEAD` — the ref an interrupted source update returns to. */
export function sourceHeadSpec(rootDir: string): CommandSpec {
  return { command: "git", args: ["rev-parse", "HEAD"], cwd: rootDir };
}

/** A source checkout's way to `target`, and its way back to `previousRef`. */
export function sourceApplyPlan(
  rootDir: string,
  target: string,
  targetCommit: string,
  previousRef: string,
  buildEnv?: Record<string, string>,
): ApplyPlan {
  return {
    apply: sourceUpdateSpecs(rootDir, target, buildEnv),
    // The same sequence: a rollback is not a special operation, it is this
    // checkout being brought to the ref it was already running. `npm ci` and
    // the build are part of it because a failed build leaves both the tree
    // and node_modules at the target.
    rollback: sourceUpdateSpecs(rootDir, previousRef, buildEnv),
    target,
    previous: previousRef,
    applyState: {
      applying: activeSourceApplyState(rootDir, "applying", targetCommit, previousRef),
      complete: completedSourceApplyState(rootDir, targetCommit),
      rollingBack: activeSourceApplyState(rootDir, "rolling-back", targetCommit, previousRef),
      rolledBack: completedSourceApplyState(rootDir, previousRef),
      completeAt: "apply",
    },
  };
}

/** A global package install's way to `target`, and back to `previousVersion`. */
export function npmGlobalApplyPlan(
  target: string,
  previousVersion: string,
  registry?: string,
): ApplyPlan {
  return {
    apply: [npmGlobalInstallSpec(target, registry)],
    rollback: [npmGlobalInstallSpec(previousVersion, registry)],
    target,
    previous: previousVersion,
  };
}

/**
 * A container install's way to `target`, and back to `previous`. Both
 * directions run the same command: compose resolves its images from the tag
 * recorded beside the compose file, which the flow writes before either the
 * apply or the rollback runs, so the pull differs only in what it fetches.
 *
 * When `previous` is a release tag, the rollback is cheap and exact: that tag
 * names one immutable image, still in the local image store, so the pull
 * contacts the registry for the manifest and reuses every layer. When it is a
 * moving tag — an edge install, whose `previous` and `target` are both `main`
 * — the apply's pull has already replaced the local image, and the rollback
 * fetches whatever `main` points at then, which may be the build that just
 * failed. There the pre-update backup, not this plan, is the way back.
 */
export function dockerApplyPlan(
  composeFile: string,
  projectDir: string,
  target: string,
  previous: string,
): ApplyPlan {
  return {
    apply: [dockerComposeSpec(composeFile, ["pull"])],
    rollback: [dockerComposeSpec(composeFile, ["pull"])],
    target,
    previous,
    applyState: {
      applying: activeDockerApplyState(projectDir, "applying", target, previous),
      complete: completedDockerApplyState(projectDir, target),
      rollingBack: activeDockerApplyState(projectDir, "rolling-back", target, previous),
      rolledBack: completedDockerApplyState(projectDir, previous),
      completeAt: "end",
    },
  };
}

/** `omnesis connect <harness> --refresh` — reinstall the plugin and skill. */
export function harnessRefreshSpec(harness: Harness, cliPath: string): CommandSpec {
  return { command: cliPath, args: ["connect", harness, "--refresh"] };
}

/**
 * The harness's own restart. Omnesis does not supervise these processes —
 * the harness owns that surface — so this invokes the harness CLI and the
 * caller falls back to printing the instruction when the binary or the
 * subcommand is not there.
 */
/**
 * `<harness> gateway restart`. Given the harness's resolved executable, the
 * spec runs that path with its directory and this Node's leading PATH, so the
 * restart works from a shell or service whose PATH does not include the
 * harness's install location, and a `#!/usr/bin/env node` executable still
 * finds an interpreter.
 */
export function harnessRestartSpec(harness: Harness, binary?: string | null): CommandSpec {
  if (!binary) return { command: harness, args: ["gateway", "restart"] };
  const path = [dirname(binary), dirname(process.execPath), process.env.PATH ?? ""]
    .filter((entry) => entry.length > 0)
    .join(delimiter);
  return { command: binary, args: ["gateway", "restart"], env: { PATH: path } };
}

/** What an operator must run themselves when the updater may not do it. */
export function manualRestartCommand(component: ServiceComponent): string {
  return `omnesis service restart ${component}`;
}

/** What an operator must run themselves to re-authorize a harness. */
export function manualAuthorizeCommand(harness: Harness): string {
  return `omnesis connect ${harness} --refresh`;
}
