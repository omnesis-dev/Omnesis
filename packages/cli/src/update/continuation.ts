// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Handing an update's remaining steps to the build it just installed.
 *
 * An update has two halves. Only the build already on the host can do the
 * first: resolve the target and put its code in place (fetch, check out and
 * build a source checkout; install a package; pull container images). Every
 * decision after that — the backup where it can wait, the restarts and the
 * health wait, the harness refresh, the completion record and the rollback —
 * belongs to the target, so that a fix to those steps takes effect on the very
 * update that delivers it. Once its apply succeeds, the installed updater
 * therefore offers the rest to the installed build's own `omnesis update`, and
 * only finishes the update itself when that build does not take the offer.
 *
 * The offer is a file in the config directory, owner-only, named by a random
 * id the new process is given on its command line; the new process adopts the
 * host update lock straight from the process offering, so no other update can
 * start in between, and records that it accepted before it does anything. An
 * offer that was not accepted — a target too old to know the protocol, a build
 * that cannot start, an install that is not the one the offer describes — is
 * finished in-process by the offering updater. One that was accepted is the
 * new build's to finish or roll back, and its exit status is the update's.
 *
 * Pure planning lives beside the IO here, each function taking what it reads.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { assertNever, atomicWriteFileSync, UPDATE_LOCK_ENV, type UpdateLock } from "@omnesis/core";
import { c, CliError, EXIT_FAILURE } from "../utils.js";
import {
  assertImageTag,
  CLI_PACKAGE,
  compareSemver,
  dockerApplyPlan,
  isResolvedVersion,
  normalizeVersion,
  npmGlobalApplyPlan,
  sourceApplyPlan,
  versionFromStableTag,
  type ApplyPlan,
  type CommandSpec,
  type ComponentRole,
  type InstallMethod,
  type UpdateStep,
} from "./detect.js";
import type { UpdateInterruptionRouter, UpdateSignal } from "./interruption.js";

/**
 * The first release whose `omnesis update` takes an offer. A target older than
 * this runs no continuation, so the updater already on the host finishes it.
 */
const CONTINUATION_MIN_VERSION = "0.4.11";

/** The hidden `omnesis update` subcommand an offer is handed to. */
export const CONTINUATION_SUBCOMMAND = "continue-after-apply";

/** The offer, in the config directory, while one is open. */
const CONTINUATION_FILE = "update-continuation.json";

/** What was installed, in the terms its apply plan and rollback are rebuilt from. */
export type ContinuationSubject =
  | { method: "npm-global"; target: string; previous: string; registry?: string }
  | {
      method: "source";
      rootDir: string;
      edge: boolean;
      /** The ref checked out: a stable tag, or `origin/main` for an edge update. */
      target: string;
      targetCommit: string;
      /** The last completed commit, which the rollback restores. */
      previous: string;
    }
  | {
      method: "docker";
      composeFile: string;
      projectDir: string;
      target: string;
      /** The tag the containers last served, which the rollback restores. */
      previous: string;
    };

/**
 * A backup that waits until after the apply: through the API of a gateway
 * that the apply cannot change, or as a copy of the closed stores of one that
 * is not running.
 */
export type DeferredBackup = "online" | "offline";

/** What an update flow offers once its apply succeeded. */
export interface ContinuationOffer {
  subject: ContinuationSubject;
  /** The CLI version the installed build must report to take the offer. */
  targetVersion: string;
  /** The version this host ran before the update: the rollback's health wait and the backup note name it. */
  previousVersion: string;
  deferredBackup: DeferredBackup | null;
  /** False for `--no-restart`. */
  restart: boolean;
}

/**
 * The offer as written to disk, with what binds it to one lock and one run.
 * Any field whose meaning an older continuing build could miss takes a new
 * `version`: a build refuses a version it does not know, and the offering
 * updater then finishes the update itself.
 */
export interface UpdateContinuation extends ContinuationOffer {
  version: 1;
  id: string;
  /** The lock owner id the offering process held when it wrote the offer. */
  lockId: string;
  state: "offered" | "accepted";
  yes: boolean;
  healthTimeoutSec: number;
}

/** The installed build declined an offer; the message says why. */
export class ContinuationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuationRefused";
  }
}

// ── Planning ────────────────────────────────────────────────────────────

/** Whether a target build takes an offer: a release at or after the protocol's first. */
export function supportsContinuation(targetVersion: string | null): targetVersion is string {
  return (
    targetVersion !== null &&
    isResolvedVersion(targetVersion) &&
    compareSemver(targetVersion, CONTINUATION_MIN_VERSION) >= 0
  );
}

/**
 * Whether this plan's backup may run after the apply, and how.
 *
 * It may when the apply cannot change what the gateway executes before its
 * restart. A container install pulls images without recreating a container,
 * and a dedicated gateway runs a release root owns, so their gateways back up
 * through the API after the apply. A gateway that is not running
 * is copied by the updater itself, with its lock held, so the target's copy is
 * the one taken.
 *
 * It may not for a running gateway served from the installation being moved —
 * a source checkout or a package: its online backup loads the backup worker
 * from the install tree at the moment it runs, and after the apply that tree
 * is the target's. That backup stays before the apply.
 */
export function deferredBackupFor(
  method: ContinuationSubject["method"],
  gateway: ComponentRole,
  steps: readonly UpdateStep[],
): DeferredBackup | null {
  const backup = steps.find((step) => step.kind === "backup");
  if (!backup || backup.kind !== "backup") return null;
  if (method === "docker" || gateway.hardened) return "online";
  return backup.offline ? "offline" : null;
}

/**
 * The plan in the order a handed-over update runs it: a deferred backup
 * directly behind the apply and ahead of every restart, and of the kind the
 * offer names. Without a deferred backup, or without a backup, it is the plan
 * as it stands.
 */
export function orderForHandoff(
  steps: readonly UpdateStep[],
  deferred: DeferredBackup | null,
): UpdateStep[] {
  if (!deferred || !steps.some((step) => step.kind === "backup")) return [...steps];
  const rest = steps.filter((step) => step.kind !== "backup");
  const at = rest.findIndex((step) => step.kind === "apply");
  const backup: UpdateStep =
    deferred === "offline" ? { kind: "backup", offline: true } : { kind: "backup" };
  return [...rest.slice(0, at + 1), backup, ...rest.slice(at + 1)];
}

/** The apply plan an offer describes, rebuilt by the build continuing it. */
export function applyPlanForSubject(
  subject: ContinuationSubject,
  buildEnv?: Record<string, string>,
): ApplyPlan {
  switch (subject.method) {
    case "npm-global":
      return npmGlobalApplyPlan(subject.target, subject.previous, subject.registry);
    case "source":
      return sourceApplyPlan(
        subject.rootDir,
        subject.target,
        subject.targetCommit,
        subject.previous,
        buildEnv,
      );
    case "docker":
      return dockerApplyPlan(
        subject.composeFile,
        subject.projectDir,
        subject.target,
        subject.previous,
      );
    default:
      return assertNever(subject);
  }
}

/** How the target reads to the operator, and the version its gateway must report. */
export function continuationTarget(subject: ContinuationSubject): {
  label: string;
  expectVersion: string | null;
} {
  switch (subject.method) {
    case "source":
      if (subject.edge) return { label: "origin/main (edge)", expectVersion: null };
      if (subject.target === subject.targetCommit) {
        return { label: `commit ${subject.target.slice(0, 12)}`, expectVersion: null };
      }
      return { label: subject.target, expectVersion: versionFromStableTag(subject.target) };
    case "npm-global":
    case "docker":
      return { label: subject.target, expectVersion: subject.target };
    default:
      return assertNever(subject);
  }
}

/** How this host's Omnesis is installed, in what its update effects need. */
export type InstallTarget =
  | { kind: "npm-global" }
  | { kind: "source"; rootDir: string }
  | { kind: "docker"; composeFile: string; projectDir: string };

/**
 * The plan for the installation this build runs from, if it is the one the
 * offer moved. A build must never continue an update of another install: a
 * checkout at another path, another compose project, or another method.
 */
export function planForSubject(
  detection: InstallMethod,
  subject: ContinuationSubject,
): InstallTarget {
  if (
    subject.method === "docker" &&
    detection.method === "docker" &&
    detection.composeFile === subject.composeFile &&
    detection.projectDir === subject.projectDir
  ) {
    return { kind: "docker", composeFile: subject.composeFile, projectDir: subject.projectDir };
  }
  if (
    subject.method === "source" &&
    detection.method === "source" &&
    detection.rootDir === subject.rootDir
  ) {
    return { kind: "source", rootDir: subject.rootDir };
  }
  if (subject.method === "npm-global" && detection.method === "npm-global") {
    return { kind: "npm-global" };
  }
  throw new ContinuationRefused(
    "This build is not the installation the update moved, so it will not continue that update.",
  );
}

// ── The offer on disk ───────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const LOCK_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const STABLE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SOURCE_EDGE_TARGET = "origin/main";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageTag(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    assertImageTag(value);
    return true;
  } catch {
    return false;
  }
}

function isRelease(value: unknown): value is string {
  return typeof value === "string" && isResolvedVersion(value) && normalizeVersion(value) === value;
}

function isRegistry(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function parseSubject(value: unknown): ContinuationSubject | null {
  if (!isRecord(value)) return null;
  if (value.method === "npm-global") {
    if (!isRelease(value.target) || !isRelease(value.previous)) return null;
    if (value.registry !== undefined && !isRegistry(value.registry)) return null;
    return {
      method: "npm-global",
      target: value.target,
      previous: value.previous,
      ...(value.registry !== undefined ? { registry: value.registry } : {}),
    };
  }
  if (value.method === "source") {
    if (typeof value.rootDir !== "string" || !isAbsolute(value.rootDir)) return null;
    if (typeof value.edge !== "boolean" || typeof value.target !== "string") return null;
    const targetOk = value.edge
      ? value.target === SOURCE_EDGE_TARGET
      : STABLE_TAG_PATTERN.test(value.target) ||
        (COMMIT_PATTERN.test(value.target) && value.target === value.targetCommit);
    if (!targetOk) return null;
    if (typeof value.targetCommit !== "string" || !COMMIT_PATTERN.test(value.targetCommit)) {
      return null;
    }
    if (typeof value.previous !== "string" || !COMMIT_PATTERN.test(value.previous)) return null;
    return {
      method: "source",
      rootDir: value.rootDir,
      edge: value.edge,
      target: value.target,
      targetCommit: value.targetCommit,
      previous: value.previous,
    };
  }
  if (value.method === "docker") {
    if (typeof value.composeFile !== "string" || !isAbsolute(value.composeFile)) return null;
    if (typeof value.projectDir !== "string" || !isAbsolute(value.projectDir)) return null;
    if (!isImageTag(value.target) || !isImageTag(value.previous)) return null;
    return {
      method: "docker",
      composeFile: value.composeFile,
      projectDir: value.projectDir,
      target: value.target,
      previous: value.previous,
    };
  }
  return null;
}

/** Parse and validate an offer. Anything malformed is no offer at all. */
export function parseUpdateContinuation(raw: string | null): UpdateContinuation | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1) return null;
  if (typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) return null;
  if (typeof value.lockId !== "string" || !LOCK_ID_PATTERN.test(value.lockId)) return null;
  if (value.state !== "offered" && value.state !== "accepted") return null;
  const subject = parseSubject(value.subject);
  if (!subject) return null;
  if (!isRelease(value.targetVersion)) return null;
  if (typeof value.previousVersion !== "string" || !/^[\w.-]{1,64}$/u.test(value.previousVersion)) {
    return null;
  }
  if (
    value.deferredBackup !== null &&
    value.deferredBackup !== "online" &&
    value.deferredBackup !== "offline"
  ) {
    return null;
  }
  if (typeof value.restart !== "boolean" || typeof value.yes !== "boolean") return null;
  if (
    typeof value.healthTimeoutSec !== "number" ||
    !Number.isSafeInteger(value.healthTimeoutSec) ||
    value.healthTimeoutSec <= 0
  ) {
    return null;
  }
  return {
    version: 1,
    id: value.id,
    lockId: value.lockId,
    state: value.state,
    subject,
    targetVersion: value.targetVersion,
    previousVersion: value.previousVersion,
    deferredBackup: value.deferredBackup,
    restart: value.restart,
    yes: value.yes,
    healthTimeoutSec: value.healthTimeoutSec,
  };
}

export function continuationPath(configDir: string): string {
  return join(configDir, CONTINUATION_FILE);
}

export function writeContinuation(configDir: string, doc: UpdateContinuation): void {
  atomicWriteFileSync(continuationPath(configDir), `${JSON.stringify(doc)}\n`, {
    ensureDir: true,
    mode: 0o600,
  });
}

/** The open offer, or null when there is none or it is not a regular, valid file. */
export function readContinuation(configDir: string): UpdateContinuation | null {
  const path = continuationPath(configDir);
  try {
    if (!lstatSync(path).isFile()) return null;
    return parseUpdateContinuation(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function removeContinuation(configDir: string): void {
  rmSync(continuationPath(configDir), { force: true });
}

/**
 * The offer named `id`, if this build may take it: still open, bound to the
 * lock this process was handed, and for exactly the version this build is.
 * The last check is what stops a package install that landed in another
 * prefix, or an image that did not change, from finishing an update to a
 * version it is not.
 */
export function claimContinuation(
  configDir: string,
  id: string,
  opts: { lockId: string | undefined; ownVersion: string },
): UpdateContinuation {
  const doc = readContinuation(configDir);
  if (!doc || doc.id !== id) {
    throw new ContinuationRefused("No update is waiting to be continued under that id.");
  }
  if (doc.state !== "offered") {
    throw new ContinuationRefused("That update has already been continued.");
  }
  if (!opts.lockId || opts.lockId.trim() !== doc.lockId) {
    throw new ContinuationRefused("The update lock was not handed to this process with the offer.");
  }
  const own = normalizeVersion(opts.ownVersion);
  if (own !== doc.targetVersion) {
    throw new ContinuationRefused(
      `This build is ${own}, not ${doc.targetVersion}, which the update installed.`,
    );
  }
  return doc;
}

/** Record that this process took the offer — after it adopted the lock, before it acts. */
export function acceptContinuation(configDir: string, doc: UpdateContinuation): void {
  const current = readContinuation(configDir);
  if (!current || current.id !== doc.id || current.state !== "offered") {
    throw new ContinuationRefused("The update offer changed before it could be accepted.");
  }
  writeContinuation(configDir, { ...current, state: "accepted" });
}

// ── Launching the installed build ───────────────────────────────────────

/**
 * Where a global package's CLI entry is now, read from the manifest on disk —
 * after an install that is the new package's, whose entry may have moved.
 */
export function installedPackageEntry(argv1: string): string | null {
  let dir: string;
  try {
    dir = dirname(realpathSync(argv1));
  } catch {
    return null;
  }
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: unknown;
          bin?: unknown;
        };
        if (parsed.name === CLI_PACKAGE) {
          const bin =
            typeof parsed.bin === "string"
              ? parsed.bin
              : isRecord(parsed.bin) && typeof parsed.bin[CLI_PACKAGE] === "string"
                ? parsed.bin[CLI_PACKAGE]
                : null;
          if (bin === null) return null;
          const entry = join(dir, bin);
          return existsSync(entry) ? entry : null;
        }
      } catch {
        // An unreadable manifest does not stop the upward walk.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * `OMNESIS_*` names the host's container wrapper (`docker_write_wrapper` in
 * `scripts/install.sh`) never forwards: the container's own paths, port and
 * gateway URL come from the compose file. Kept equal to that list by a test.
 */
export const CONTAINER_OWN_ENV: ReadonlySet<string> = new Set([
  "OMNESIS_CONFIG_DIR",
  "OMNESIS_GATEWAY_URL",
  "OMNESIS_GATEWAY_PORT",
  "OMNESIS_DB_PATH",
  "OMNESIS_INDEX_DB_PATH",
  "OMNESIS_ANALYTICS_DB_PATH",
  "OMNESIS_LOG_FILE",
  "OMNESIS_TLS_CERT",
  "OMNESIS_TLS_KEY",
  UPDATE_LOCK_ENV,
]);

export interface ContinuationCommandContext {
  env: NodeJS.ProcessEnv;
  /** The node binary running this updater. */
  execPath: string;
  /** The global package's CLI entry as installed now. */
  packageEntry(): string | null;
  /** Whether a terminal is attached, which a container run must be told. */
  interactive: boolean;
}

/**
 * The command that runs the installed build's `omnesis update` on an offer,
 * with the lock id it adopts. Null when that build cannot be found.
 *
 * A source checkout's CLI is its own tsx entry rather than the launcher on
 * PATH, and a package's is the entry its manifest names now. A container
 * install's is the updater service at the tag just recorded, run the way the
 * host wrapper runs it, with the same `OMNESIS_*` settings carried in.
 */
export function continuationCommand(
  subject: ContinuationSubject,
  id: string,
  lockId: string,
  ctx: ContinuationCommandContext,
): CommandSpec | null {
  const tail = ["update", CONTINUATION_SUBCOMMAND, id];
  const env = { [UPDATE_LOCK_ENV]: lockId };
  switch (subject.method) {
    case "source":
      return {
        command: join(subject.rootDir, "node_modules", ".bin", "tsx"),
        args: [join(subject.rootDir, "packages", "cli", "src", "index.ts"), ...tail],
        env,
      };
    case "npm-global": {
      const entry = ctx.packageEntry();
      return entry ? { command: ctx.execPath, args: [entry, ...tail], env } : null;
    }
    case "docker": {
      const forwarded: string[] = [];
      for (const [name, value] of Object.entries(ctx.env).sort(([a], [b]) => a.localeCompare(b))) {
        if (value === undefined || !/^OMNESIS_[A-Za-z0-9_]*$/u.test(name)) continue;
        if (CONTAINER_OWN_ENV.has(name)) continue;
        forwarded.push("--env", `${name}=${value}`);
      }
      return {
        command: "docker",
        args: [
          "compose",
          "-f",
          subject.composeFile,
          "--profile",
          "update",
          "run",
          "--rm",
          "--no-deps",
          ...(ctx.interactive ? [] : ["-T"]),
          "--env",
          `${UPDATE_LOCK_ENV}=${lockId}`,
          ...forwarded,
          "updater",
          ...tail,
        ],
        env,
      };
    }
    default:
      return assertNever(subject);
  }
}

/** Where a signal this process receives goes while the installed build runs. */
export interface SignalRelay {
  deliver?(signal: UpdateSignal): void;
}

export interface ContinuationOutcome {
  /** The installed build took the offer; what followed is its to report. */
  accepted: boolean;
  /** Its exit status; for a process ended by a signal, 128 plus that signal's number. */
  code: number;
  signal: NodeJS.Signals | null;
  /** Why the offer was not taken, when that is known on this side. */
  detail?: string;
}

/**
 * Write the offer, run the installed build on it, and report whether it was
 * taken. Output is the terminal's. The offer is removed afterwards either way,
 * so a later run can never take one this run made.
 */
export async function launchContinuation(opts: {
  configDir: string;
  doc: UpdateContinuation;
  command: CommandSpec | null;
  relay: SignalRelay;
  spawn?: typeof nodeSpawn;
}): Promise<ContinuationOutcome> {
  const { configDir, doc, command, relay } = opts;
  if (!command) {
    return { accepted: false, code: 1, signal: null, detail: "its CLI could not be found" };
  }
  const spawnProcess = opts.spawn ?? nodeSpawn;
  try {
    writeContinuation(configDir, doc);
    const exit = await new Promise<{ code: number; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const child = spawnProcess(command.command, command.args, {
          stdio: "inherit",
          env: { ...process.env, ...command.env },
          ...(command.cwd ? { cwd: command.cwd } : {}),
        });
        relay.deliver = (signal) => {
          try {
            child.kill(signal);
          } catch {
            // The child already exited.
          }
        };
        // Once the process runs, only its close settles the outcome: a failed
        // signal delivery must not read as an offer that was never taken while
        // the build is still working on it.
        let running = false;
        child.once("spawn", () => {
          running = true;
        });
        child.on("error", (err) => {
          if (!running) reject(err);
        });
        child.once("close", (code, signal) => {
          resolve({
            code: code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1),
            signal,
          });
        });
      },
    );
    const after = readContinuation(configDir);
    const accepted = after?.id === doc.id && after.state === "accepted";
    return {
      accepted,
      ...exit,
      ...(accepted
        ? {}
        : {
            detail: exit.signal ? `it was stopped by ${exit.signal}` : `it exited ${exit.code}`,
          }),
    };
  } catch (err) {
    return {
      accepted: false,
      code: 1,
      signal: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    relay.deliver = undefined;
    try {
      removeContinuation(configDir);
    } catch {
      // A leftover offer is inert: a later run's has another id.
    }
  }
}

export type HandOverResult =
  /** The installed build took the rest and finished it. */
  | { finished: true }
  /** It did not take the offer; `signal` arrived while it was being offered. */
  | { finished: false; signal: UpdateSignal | null };

/**
 * Offer the steps after a successful apply to the build it installed, relaying
 * signals to it while it runs. A failure it reports after accepting ends the
 * update with its exit status, because its rollback was its own to run.
 *
 * The caller must hold no claim on `interruptions`, and holds the lock again
 * afterwards: one that did not come back from a build that exited is
 * reclaimed, and one that cannot be is refused rather than worked around.
 */
export async function handOverAfterApply(opts: {
  offer: ContinuationOffer;
  continueAfterApply(offer: ContinuationOffer, relay: SignalRelay): Promise<ContinuationOutcome>;
  interruptions: UpdateInterruptionRouter;
  lock?: Pick<UpdateLock, "setStep" | "reclaim">;
  targetLabel: string;
}): Promise<HandOverResult> {
  const { lock, targetLabel } = opts;
  /** Null once this process holds the lock at `step`; otherwise why it cannot. */
  const holdLock = (step: string): string | null => {
    try {
      lock?.setStep(step);
      return null;
    } catch (err) {
      if (lock?.reclaim()) {
        try {
          lock.setStep(step);
          return null;
        } catch (retry) {
          return retry instanceof Error ? retry.message : String(retry);
        }
      }
      return err instanceof Error ? err.message : String(err);
    }
  };
  const lockLost = (detail: string): CliError =>
    new CliError(
      `${c.red}Installed ${targetLabel}, but this update no longer holds the host update lock: ` +
        `${detail}. Nothing has been restarted. Run the update again once no other update is running.${c.reset}`,
      EXIT_FAILURE,
    );

  const before = holdLock(`handing the rest of the update to ${targetLabel}`);
  if (before) throw lockLost(before);
  // Signals go to the installed build, which owns the transaction once it
  // accepts. One that arrives before it accepted is the caller's to act on.
  const relay: SignalRelay = {};
  const received: { signal: UpdateSignal | null } = { signal: null };
  const stopRelaying = opts.interruptions.claim((signal) => {
    received.signal ??= signal;
    relay.deliver?.(signal);
  });
  let outcome: ContinuationOutcome;
  try {
    outcome = await opts.continueAfterApply(opts.offer, relay);
  } catch (err) {
    outcome = {
      accepted: false,
      code: EXIT_FAILURE,
      signal: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    stopRelaying();
  }

  if (outcome.accepted) {
    if (outcome.code === 0) return { finished: true };
    const back = holdLock(`finishing after the updater from ${targetLabel} exited ${outcome.code}`);
    // A build that reported its own failure has already said what it did; one
    // that was stopped, or left the lock behind, may not have got that far.
    if (outcome.signal || outcome.code >= 128 || back !== null) {
      console.log(
        `${c.yellow}! The updater installed with ${targetLabel} stopped ` +
          `(${outcome.signal ?? `exit ${outcome.code}`}) before it could be known to have finished ` +
          `or rolled back, so this host may be only partly updated. Check ` +
          `${c.bold}omnesis service status${c.reset}${c.yellow} and run the update again.${c.reset}`,
      );
    }
    throw new CliError("", outcome.code);
  }

  console.log(
    `${c.dim}The updater installed with ${targetLabel} did not take over the rest of this update` +
      `${outcome.detail ? ` (${outcome.detail})` : ""}; finishing it here.${c.reset}`,
  );
  const after = holdLock("continuing after the apply");
  if (after) throw lockLost(after);
  return { finished: false, signal: received.signal };
}
