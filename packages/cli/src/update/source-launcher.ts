// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "@omnesis/core";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Whether `content` is one of the source launchers the installer owns for
 * exactly `rootDir`.  Migration and recovery share this predicate so neither
 * path ever replaces a merely similar executable in ~/.local/bin.
 */
export function sourceLauncherTargetsRoot(content: string, rootDir: string): boolean {
  const ownsRoot =
    content.includes(`SOURCE_ROOT=${shellQuote(rootDir)}\n`) ||
    (content.includes(`"${rootDir}/node_modules/.bin/tsx"`) &&
      content.includes(`"${rootDir}/packages/cli/src/index.ts"`));
  return (
    content.startsWith("#!/bin/sh\n") &&
    ownsRoot &&
    content.includes("node_modules/.bin/tsx") &&
    content.includes("packages/cli/src/index.ts")
  );
}

/**
 * Stable source launcher installed outside the checkout's mutable
 * node_modules. An interrupted transaction may run only `update`: it first
 * restores the recorded last-good source and dependencies, then lets the
 * updater reapply its target. Daemons cannot race that repair after reboot.
 */
export function sourceRecoveryLauncher(
  rootDir: string,
  configDir: string,
  lockHelper = join(homedir(), ".local", "lib", "omnesis", "update-lock.cjs"),
): string {
  return `#!/bin/sh
SOURCE_ROOT=${shellQuote(rootDir)}
DEFAULT_CONFIG_DIR=${shellQuote(configDir)}
UPDATE_LOCK_HELPER=${shellQuote(lockHelper)}
# Homebrew installs node@24 keg-only. When the caller's PATH has no Node 24 or
# newer, run that keg instead.
case "$(node --version 2>/dev/null)" in
  v2[4-9].*|v[3-9][0-9].*|v[1-9][0-9][0-9].*) ;;
  *)
    for HOMEBREW_NODE_PREFIX in "\${HOMEBREW_PREFIX:-}" /opt/homebrew /usr/local /home/linuxbrew/.linuxbrew; do
      if [ -n "$HOMEBREW_NODE_PREFIX" ] && [ -x "$HOMEBREW_NODE_PREFIX/opt/node@24/bin/node" ]; then
        PATH="$HOMEBREW_NODE_PREFIX/opt/node@24/bin:$PATH"
        export PATH
        break
      fi
    done
    ;;
esac
RUNTIME_CONFIG_DIR="\${OMNESIS_CONFIG_DIR:-$DEFAULT_CONFIG_DIR}"
UPDATE_LOCK_ACQUIRED=0
UPDATE_LOCK_HANDOFF=0
UPDATE_LOCK_HEARTBEAT_PID=""
UPDATE_COMMAND="\${1:-}"
UPDATE_LOCK_WAIT_MINUTES=""
if [ "$UPDATE_COMMAND" = "update" ]; then
  UPDATE_PREVIOUS_ARG=""
  for UPDATE_ARG in "$@"; do
    if [ "$UPDATE_PREVIOUS_ARG" = "--wait-for-lock" ]; then UPDATE_LOCK_WAIT_MINUTES="$UPDATE_ARG"; fi
    case "$UPDATE_ARG" in
      --wait-for-lock=*) UPDATE_LOCK_WAIT_MINUTES="\${UPDATE_ARG#--wait-for-lock=}" ;;
    esac
    UPDATE_PREVIOUS_ARG="$UPDATE_ARG"
  done
  case "$UPDATE_LOCK_WAIT_MINUTES" in
    ''|*[!0-9]*) UPDATE_LOCK_WAIT_MINUTES="" ;;
  esac
fi
stop_update_lock_heartbeat() {
  if [ -n "$UPDATE_LOCK_HEARTBEAT_PID" ]; then
    kill "$UPDATE_LOCK_HEARTBEAT_PID" >/dev/null 2>&1 || true
    wait "$UPDATE_LOCK_HEARTBEAT_PID" 2>/dev/null || true
    UPDATE_LOCK_HEARTBEAT_PID=""
  fi
}
release_update_lock() {
  stop_update_lock_heartbeat
  if [ "$UPDATE_LOCK_ACQUIRED" = "1" ]; then
    if node "$UPDATE_LOCK_HELPER" release "$RUNTIME_CONFIG_DIR" "$OMNESIS_UPDATE_LOCK_ID" >/dev/null 2>&1; then
      UPDATE_LOCK_ACQUIRED=0
    else
      return 73
    fi
  fi
}
finish_update_lock() {
  UPDATE_STATUS="$1"
  trap - EXIT HUP INT TERM
  if ! release_update_lock; then
    printf '%s\\n' "Could not release the source update lock; retry after the active lock operation finishes." >&2
    exit 73
  fi
  exit "$UPDATE_STATUS"
}
acquire_update_lock() {
  if [ -n "\${OMNESIS_UPDATE_LOCK_ID:-}" ]; then
    OMNESIS_UPDATE_LOCK_ID="$(node "$UPDATE_LOCK_HELPER" adopt "$RUNTIME_CONFIG_DIR" "$OMNESIS_UPDATE_LOCK_ID" "$$")" || exit $?
  else
    OMNESIS_UPDATE_LOCK_ID="$(node "$UPDATE_LOCK_HELPER" acquire "$RUNTIME_CONFIG_DIR" "source update" "$$" \${UPDATE_LOCK_WAIT_MINUTES:+"$UPDATE_LOCK_WAIT_MINUTES"})" || exit $?
  fi
  UPDATE_LOCK_ACQUIRED=1
  if [ "$UPDATE_COMMAND" = "update" ]; then UPDATE_LOCK_HANDOFF=1; fi
  export OMNESIS_UPDATE_LOCK_ID
  node "$UPDATE_LOCK_HELPER" heartbeat-loop "$RUNTIME_CONFIG_DIR" "$OMNESIS_UPDATE_LOCK_ID" &
  UPDATE_LOCK_HEARTBEAT_PID=$!
  trap 'finish_update_lock $?' EXIT
  trap 'finish_update_lock 129' HUP
  trap 'finish_update_lock 130' INT
  trap 'finish_update_lock 143' TERM
}
read_update_phase() {
  UPDATE_PHASE=""
  if [ -f "$RUNTIME_CONFIG_DIR/update-state.json" ]; then
    UPDATE_PHASE="$(node -e '
const fs = require("node:fs");
const [path, rootDir] = process.argv.slice(1);
try {
  const state = JSON.parse(fs.readFileSync(path, "utf8"));
  const exactCommit = /^[0-9a-f]{40}$/;
  if (state?.version !== 1 || state?.method !== "source" || state?.rootDir !== rootDir) throw new Error();
  if (state.phase === "complete" && exactCommit.test(state.commit)) process.stdout.write("complete" + String.fromCharCode(10) + state.commit);
  else if (["applying", "rolling-back"].includes(state.phase) && exactCommit.test(state.targetCommit) && exactCommit.test(state.lastCompletedCommit)) {
    process.stdout.write(state.phase + String.fromCharCode(10) + state.lastCompletedCommit);
  } else throw new Error();
} catch { process.stdout.write("invalid"); }
' "$RUNTIME_CONFIG_DIR/update-state.json" "$SOURCE_ROOT" 2>/dev/null || true)"
  fi
  UPDATE_LAST_COMPLETED="$(printf '%s\\n' "$UPDATE_PHASE" | sed -n '2p')"
  UPDATE_PHASE="$(printf '%s\\n' "$UPDATE_PHASE" | sed -n '1p')"
  if [ "$UPDATE_PHASE" = "invalid" ]; then
    printf '%s\\n' "The source update state is invalid. Re-run the source installer to repair it." >&2
    exit 1
  fi
  if [ "$UPDATE_PHASE" = "complete" ]; then
    CURRENT_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse HEAD 2>/dev/null || true)"
    if [ "$CURRENT_COMMIT" != "$UPDATE_LAST_COMPLETED" ]; then UPDATE_PHASE="mismatch"; fi
  fi
}
update_unfinished() {
  [ "$UPDATE_PHASE" = "applying" ] || [ "$UPDATE_PHASE" = "rolling-back" ] || [ "$UPDATE_PHASE" = "mismatch" ]
}
# npm installs over the node_modules a workspace checkout already has, and
# an install over another build's tree can fail the same way on every run.
# A failed install is retried once from an empty node_modules.
install_source_dependencies() {
  ( cd "$SOURCE_ROOT" && npm ci ) && return 0
  printf '%s\\n' "Installing dependencies failed; installing them again from an empty node_modules..." >&2
  rm -rf "$SOURCE_ROOT/node_modules" && ( cd "$SOURCE_ROOT" && npm ci )
}
read_update_phase
if update_unfinished; then
  if [ "\${1:-}" != "update" ]; then
    printf '%s\\n' "A source update did not finish. Run 'omnesis update' before starting another command." >&2
    printf '%s\\n' "If its build was killed for lack of memory, first stop the collector and gateway (systemctl --user stop omnesis-collector omnesis-gateway on Linux, launchctl bootout on macOS)." >&2
    exit 1
  fi
  acquire_update_lock
  # An update this one waited for may have finished in the meantime.
  read_update_phase
fi
if update_unfinished; then
  if [ -n "$(git -C "$SOURCE_ROOT" status --porcelain)" ]; then
    printf '%s\\n' "The source checkout has local changes after the interrupted update. Preserve or discard them explicitly before retrying." >&2
    exit 1
  fi
  printf '%s\\n' "Source update recovery: restoring the last completed CLI before retrying..." >&2
  git -C "$SOURCE_ROOT" checkout --detach "$UPDATE_LAST_COMPLETED" >/dev/null || {
    printf '%s\\n' "Could not restore the last completed source commit. Re-run the source installer." >&2
    exit 1
  }
  install_source_dependencies || {
    printf '%s\\n' "Could not restore source dependencies. Re-run this command or the source installer." >&2
    exit 1
  }
elif [ ! -x "$SOURCE_ROOT/node_modules/.bin/tsx" ]; then
  if [ "$UPDATE_LOCK_ACQUIRED" != "1" ]; then acquire_update_lock; fi
  if [ ! -x "$SOURCE_ROOT/node_modules/.bin/tsx" ]; then
    printf '%s\\n' "Source recovery: restoring missing CLI dependencies before continuing..." >&2
    install_source_dependencies || {
      printf '%s\\n' "Could not restore source dependencies. Re-run this command or the source installer." >&2
      exit 1
    }
  fi
fi
if [ "$UPDATE_LOCK_HANDOFF" = "1" ]; then
  "$SOURCE_ROOT/node_modules/.bin/tsx" "$SOURCE_ROOT/packages/cli/src/index.ts" "$@"
  UPDATE_STATUS=$?
  finish_update_lock "$UPDATE_STATUS"
fi
if [ "$UPDATE_LOCK_ACQUIRED" = "1" ]; then
  if ! release_update_lock; then
    printf '%s\\n' "Could not release the source recovery lock; retry after the active lock operation finishes." >&2
    trap - EXIT HUP INT TERM
    exit 73
  fi
  trap - EXIT HUP INT TERM
fi
exec "$SOURCE_ROOT/node_modules/.bin/tsx" "$SOURCE_ROOT/packages/cli/src/index.ts" "$@"
`;
}

/** Dependency-free lock implementation used before a source checkout can load its CLI. */
export function sourceUpdateLockHelper(): string {
  return `#!/usr/bin/env node
"use strict";
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [command, configDir, value, pidArg, waitArg] = process.argv.slice(2);
const lockDir = path.join(configDir || "", "update.lock");
const ownerPath = path.join(lockDir, "owner.json");
const claimPrefix = ".claim-";
const staleMs = 30000;
function processStart(pid) {
  if (process.platform === "darwin") {
    try { return childProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim(); }
    catch { return null; }
  }
  if (process.platform !== "linux") return null;
  try {
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    const start = stat.slice(close + 2).split(" ")[19];
    return bootId && start ? bootId + ":" + start : null;
  } catch { return null; }
}
function readOwner() {
  try {
    if (!fs.lstatSync(ownerPath).isFile()) return null;
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.version !== 1 || typeof owner.id !== "string" || typeof owner.owner !== "string" ||
        !Number.isInteger(owner.pid) || (typeof owner.processStart !== "string" && owner.processStart !== null) ||
        typeof owner.startedAt !== "string" || typeof owner.updatedAt !== "string" ||
        typeof owner.currentStep !== "string" ||
        (owner.processGroupPid !== undefined &&
          (!Number.isInteger(owner.processGroupPid) || owner.processGroupPid <= 0 ||
            (typeof owner.processGroupStart !== "string" && owner.processGroupStart !== null))) ||
        (owner.processGroupPid === undefined && owner.processGroupStart !== undefined) ||
        (owner.returnTo !== undefined && !validReturnOwner(owner.returnTo))) return null;
    return owner;
  } catch { return null; }
}
function validReturnOwner(owner) {
  return owner && typeof owner === "object" && typeof owner.id === "string" &&
    typeof owner.owner === "string" && Number.isInteger(owner.pid) &&
    (typeof owner.processStart === "string" || owner.processStart === null) &&
    typeof owner.startedAt === "string";
}
function alive(owner) {
  try { process.kill(owner.pid, 0); } catch (error) { if (error?.code !== "EPERM") return false; }
  return owner.processStart === null || processStart(owner.pid) === owner.processStart;
}
function groupAlive(owner) {
  if (!Number.isInteger(owner.processGroupPid) || process.platform === "win32") return false;
  try { process.kill(-owner.processGroupPid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}
function replaceJson(target, value) {
  const scratch = target + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(scratch, JSON.stringify(value) + "\\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(scratch, target);
  } catch (error) {
    try { fs.unlinkSync(scratch); } catch {}
    throw error;
  }
}
function readClaim(target) {
  try {
    const claim = JSON.parse(fs.readFileSync(target, "utf8"));
    if (claim.version !== 1 || !["choosing", "waiting"].includes(claim.state) ||
        !Number.isSafeInteger(claim.ticket) || claim.ticket < 0 || !Number.isInteger(claim.pid) ||
        (typeof claim.processStart !== "string" && claim.processStart !== null)) return null;
    return claim;
  } catch { return null; }
}
function claimGuard() {
  const name = claimPrefix + crypto.randomUUID();
  const claim = path.join(lockDir, name);
  const identity = { version: 1, state: "choosing", ticket: 0,
    pid: process.pid, processStart: processStart(process.pid) };
  try { fs.writeFileSync(claim, JSON.stringify(identity) + "\\n", { flag: "wx", mode: 0o600 }); }
  catch { return null; }
  let ticket = 1;
  try {
    const contenders = fs.readdirSync(lockDir).filter((entry) => entry.startsWith(claimPrefix));
    for (const entry of contenders) {
      if (entry === name) continue;
      discardStaleClaim(path.join(lockDir, entry));
      const other = readClaim(path.join(lockDir, entry));
      if (other?.state === "waiting") ticket = Math.max(ticket, other.ticket + 1);
    }
    identity.state = "waiting";
    identity.ticket = ticket;
    replaceJson(claim, identity);
  } catch { releaseGuard(claim); return null; }
  for (let attempt = 0; attempt < 250; attempt += 1) {
    let contenders;
    try {
      contenders = fs.readdirSync(lockDir).filter((entry) => entry.startsWith(claimPrefix));
      for (const entry of contenders) {
        if (entry === name) continue;
        discardStaleClaim(path.join(lockDir, entry));
      }
      contenders = fs.readdirSync(lockDir).filter((entry) => entry.startsWith(claimPrefix));
    }
    catch { releaseGuard(claim); return null; }
    if (!contenders.includes(name)) { releaseGuard(claim); return null; }
    let blocked = false;
    for (const entry of contenders) {
      if (entry === name) continue;
      const other = readClaim(path.join(lockDir, entry));
      if (!other || other.state === "choosing" || other.ticket < ticket ||
          (other.ticket === ticket && entry < name)) { blocked = true; break; }
    }
    if (!blocked) return claim;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
  releaseGuard(claim);
  return null;
}
function discardStaleClaim(candidate) {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile()) return;
    const age = Date.now() - stat.mtimeMs;
    if (age < staleMs) return;
    try {
      const holder = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (alive(holder)) return;
    } catch {}
    fs.unlinkSync(candidate);
  } catch {}
}
function releaseGuard(claim) { try { fs.unlinkSync(claim); } catch {} }
function retire(expectedId, requireStale = false, observedUpdated = Number.POSITIVE_INFINITY) {
  const claim = claimGuard();
  if (!claim) return expectedId && readOwner()?.id !== expectedId ? "not-owner" : "busy";
  const owner = readOwner();
  if (expectedId && owner?.id !== expectedId) { releaseGuard(claim); return "not-owner"; }
  const updated = owner ? Date.parse(owner.updatedAt) : observedUpdated;
  const age = Date.now() - updated;
  if (requireStale && ((Number.isFinite(updated) && age < staleMs) || (owner && (alive(owner) || groupAlive(owner))))) {
    releaseGuard(claim);
    return "busy";
  }
  const retired = lockDir + ".retired-" + process.pid + "-" + crypto.randomUUID();
  try {
    if (!fs.lstatSync(lockDir).isDirectory()) {
      releaseGuard(claim);
      return expectedId && readOwner()?.id !== expectedId ? "not-owner" : "busy";
    }
    fs.renameSync(lockDir, retired);
  } catch {
    releaseGuard(claim);
    return expectedId && readOwner()?.id !== expectedId ? "not-owner" : "busy";
  }
  fs.rmSync(retired, { recursive: true, force: true });
  return "retired";
}
if (command === "adopt") {
  if (!configDir || typeof value !== "string" || !value || !/^\\d+$/.test(pidArg || "")) process.exit(64);
  const claim = claimGuard();
  if (!claim) process.exit(73);
  try {
    const owner = readOwner();
    if (!owner || owner.id !== value) {
      process.stderr.write("The update lock hand-off is no longer valid; start the update again.\\n");
      process.exitCode = 73;
    } else {
      const pid = Number(pidArg);
      owner.returnTo = owner.returnTo || { id: owner.id, owner: owner.owner, pid: owner.pid,
        processStart: owner.processStart, startedAt: owner.startedAt };
      owner.id = crypto.randomUUID();
      owner.owner = "source update recovery";
      owner.pid = pid;
      owner.processStart = processStart(pid);
      owner.updatedAt = new Date().toISOString();
      owner.currentStep = "restoring source dependencies";
      replaceJson(ownerPath, owner);
      process.stdout.write(owner.id);
    }
  } finally { releaseGuard(claim); }
  process.exit(process.exitCode || 0);
}
if (command === "heartbeat" || command === "heartbeat-loop") {
  function heartbeat() {
    const claim = claimGuard();
    if (!claim) return 73;
    try {
      const owner = readOwner();
      if (!owner || owner.id !== value || (command === "heartbeat-loop" && !alive(owner))) return 73;
      owner.updatedAt = new Date().toISOString();
      replaceJson(ownerPath, owner);
      return 0;
    } finally { releaseGuard(claim); }
  }
  if (command === "heartbeat") process.exit(heartbeat());
  // One owned process holds the timer, so stopping it cannot strand a sleeping
  // grandchild with the installer's output pipes open. Handle shutdown between
  // ticks, after the synchronous claim's finally block has released its guard.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => process.exit(0));
  setInterval(() => {
    const status = heartbeat();
    if (status !== 0) process.exit(status);
  }, 5000);
  return;
}
if (command === "release") {
  if (typeof value !== "string" || !value) process.exit(64);
  process.exit(retire(value) === "busy" ? 73 : 0);
}
if (command !== "acquire" || !configDir || !value || !/^\\d+$/.test(pidArg || "") ||
    (waitArg !== undefined && !/^\\d+$/.test(waitArg))) process.exit(64);
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
function tryAcquire() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let created = false;
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      created = true;
      const now = new Date().toISOString();
      const pid = Number(pidArg);
      const owner = { version: 1, id: crypto.randomUUID(), owner: value, pid,
        processStart: processStart(pid), startedAt: now, updatedAt: now, currentStep: value };
      replaceJson(ownerPath, owner);
      process.stdout.write(owner.id);
      process.exit(0);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (created) retire();
        throw error;
      }
      const owner = readOwner();
      let updated = Number.POSITIVE_INFINITY;
      try { updated = owner ? Date.parse(owner.updatedAt) : fs.lstatSync(lockDir).mtimeMs; } catch {}
      const age = Date.now() - updated;
      if ((Number.isFinite(updated) && age < staleMs) || (owner && (alive(owner) || groupAlive(owner)))) {
        return { owner, exhausted: false };
      }
      if (retire(owner?.id, true, updated) !== "retired") continue;
    }
  }
  return { owner: null, exhausted: true };
}
// A wait polls until the holder releases the lock or is proven dead by the
// stale-lock rules above, and gives up once the requested minutes have passed.
const waitMinutes = Number(waitArg || 0);
const waitUntil = Date.now() + waitMinutes * 60000;
let waiting = false;
for (;;) {
  const busy = tryAcquire();
  const holder = busy.owner ? busy.owner.owner + " (PID " + busy.owner.pid + ")" : "another update";
  const detail = busy.owner
    ? holder + ", started " + busy.owner.startedAt + ", currently " + busy.owner.currentStep
    : "another update";
  if (Date.now() >= waitUntil) {
    if (waiting) {
      process.stderr.write("Another Omnesis update was still running on this host after waiting " +
        waitMinutes + " minute" + (waitMinutes === 1 ? "" : "s") + ": " + detail + ".\\n");
    } else if (busy.exhausted) {
      process.stderr.write("Another Omnesis update holds this host lock.\\n");
    } else {
      process.stderr.write("Another Omnesis update is running on this host: " + detail + ".\\n");
    }
    process.exit(73);
  }
  if (!waiting) {
    waiting = true;
    process.stderr.write("Waiting for " + holder + " to finish...\\n");
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.min(2000, waitUntil - Date.now())));
}
`;
}

/** Upgrade a legacy one-line source wrapper before the checkout is mutated. */
export function prepareSourceRecoveryLauncher(
  rootDir: string,
  configDir: string,
  homeDir: string,
): string {
  const launcher = join(homeDir, ".local", "bin", "omnesis");
  const helper = join(homeDir, ".local", "lib", "omnesis", "update-lock.cjs");
  if (existsSync(launcher)) {
    if (!lstatSync(launcher).isFile()) {
      throw new Error(`${launcher} exists but is not a regular file`);
    }
    const current = readFileSync(launcher, "utf8");
    if (!sourceLauncherTargetsRoot(current, rootDir)) {
      throw new Error(`${launcher} is not this source checkout's Omnesis launcher`);
    }
  }
  atomicWriteFileSync(helper, sourceUpdateLockHelper(), { ensureDir: true, mode: 0o755 });
  atomicWriteFileSync(launcher, sourceRecoveryLauncher(rootDir, configDir, helper), {
    ensureDir: true,
    mode: 0o755,
  });
  return launcher;
}
