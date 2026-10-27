#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readdirSync,
  readSync,
  statfsSync,
  writeSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Refuse persistent hosts before the lane creates any files or services. */
export function validateDisposableRunner(env, work, source) {
  if (
    process.platform !== "linux" ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.RUNNER_OS !== "Linux" ||
    env.HOME !== "/home/runner"
  )
    throw new Error("requires an actual disposable GitHub-hosted Linux runner");
  const within = (path, parent) => path.startsWith(`${parent}/`);
  for (const name of ["RUNNER_TEMP", "GITHUB_WORKSPACE"]) {
    const value = env[name];
    if (!value || !within(value, "/home/runner/work") || realpathSync(value) !== value)
      throw new Error(`invalid canonical hosted-runner ${name}`);
  }
  if (
    realpathSync(env.HOME) !== env.HOME ||
    resolve(source) !== env.GITHUB_WORKSPACE ||
    !work ||
    resolve(work) !== work ||
    !within(work, env.RUNNER_TEMP)
  )
    throw new Error("work and source must belong to the disposable runner");
  for (const target of [
    work,
    join(env.HOME, ".config", "omnesis"),
    join(env.HOME, ".local", "bin", "omnesis"),
    join(env.HOME, "omnesis"),
  ]) {
    for (let path = target; path !== dirname(path); path = dirname(path)) {
      try {
        if (lstatSync(path).isSymbolicLink())
          throw new Error("refusing symlink in owned runner paths");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return { disposableRunner: true };
}

const COMPILER_ENTRY = "node_modules/typescript/lib/tsc.js";
function ownedCompilerEntry(source, allowMissing = false) {
  if (!source || realpathSync(source) !== resolve(source))
    throw new Error("source must be canonical");
  for (const relative of [
    "node_modules",
    "node_modules/typescript",
    "node_modules/typescript/lib",
  ]) {
    const directory = join(source, relative),
      stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(directory) !== directory)
      throw new Error("dependency path must stay inside the owned source without symlinks");
  }
  const path = join(source, COMPILER_ENTRY);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 8 * 1024 * 1024)
      throw new Error("compiler entry must be a bounded regular owned file");
  } catch (error) {
    if (!allowMissing || error.code !== "ENOENT") throw error;
  }
  return path;
}
/** Damage one actual installed dependency; npm, never this harness, repairs it. */
export function damageDependencyTree(source) {
  const path = ownedCompilerEntry(source),
    bytes = readFileSync(path);
  const proof = {
    relativePath: COMPILER_ENTRY,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    absentBeforeSignal: true,
  };
  unlinkSync(path);
  validateDependencyDamage(source, proof);
  return proof;
}
export function validateDependencyDamage(source, proof) {
  const path = ownedCompilerEntry(source, true);
  if (
    proof?.relativePath !== COMPILER_ENTRY ||
    !/^[a-f0-9]{64}$/.test(proof.sha256) ||
    proof.absentBeforeSignal !== true ||
    existsSync(path)
  )
    throw new Error("external dependency damage was not observed before interruption");
  return proof;
}
export function verifyDependencyRestored(source, proof) {
  const path = ownedCompilerEntry(source);
  if (
    proof?.relativePath !== COMPILER_ENTRY ||
    createHash("sha256").update(readFileSync(path)).digest("hex") !== proof.sha256
  )
    throw new Error("real dependency repair did not restore the compiler entry hash");
  return { restored: true };
}

/** Fingerprints only: neither root material nor bearer credentials leave the process. */
export function encryptedIdentity(config) {
  const names = [
    `keyring/passphrase/${Buffer.from("install-root-key-v1").toString("base64url")}.json`,
    "keyring/storage-keys/main-db.json",
    "tls/cert.pem",
    "token",
    "collector-token",
  ];
  const hashes = {};
  for (const name of names) {
    const bytes = readFileSync(join(config, name));
    if (!bytes.length) throw new Error(`empty identity artifact: ${name}`);
    if (name !== "tls/cert.pem") {
      let wrapped;
      try {
        wrapped = JSON.parse(bytes);
      } catch {
        throw new Error(`identity artifact is not encrypted: ${name}`);
      }
      const marker =
        name === "keyring/storage-keys/main-db.json"
          ? "omnesis.storage-key"
          : name.startsWith("keyring/passphrase/")
            ? "omnesis.passphrase-secret"
            : "omnesis.secret-file";
      if (
        wrapped?.omnesis !== marker ||
        wrapped.version !== 1 ||
        typeof wrapped.ciphertext !== "string" ||
        !wrapped.ciphertext
      )
        throw new Error(`identity artifact is not encrypted: ${name}`);
    }
    hashes[name] = createHash("sha256").update(bytes).digest("hex");
  }
  const fd = openSync(join(config, "omnesis.db"), "r");
  const header = Buffer.alloc(16);
  try {
    if (
      fstatSync(fd).size < 4096 ||
      readSync(fd, header, 0, 16, 0) !== 16 ||
      header.toString() === "SQLite format 3\0"
    )
      throw new Error("gateway database is empty or plaintext");
  } finally {
    closeSync(fd);
  }
  return hashes;
}

/** Read the same three fictional records by their stable identities and content. */
export async function seededDocuments(url, token) {
  const found = [];
  for (const query of ["brindlewick", "Tomatoes along", "bread baking at altitude"]) {
    const request = async (path) => {
      const response = await fetch(new URL(path, url), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`document proof: HTTP ${response.status}`);
      return response.json();
    };
    const page = await request(`/documents/search?q=${encodeURIComponent(query)}&limit=10`);
    if (
      !Array.isArray(page.results) ||
      page.results.length !== 1 ||
      typeof page.results[0].id !== "string"
    )
      throw new Error("fictional document is missing or ambiguous");
    const doc = await request(`/documents/${encodeURIComponent(page.results[0].id)}`);
    if (
      doc.id !== page.results[0].id ||
      typeof doc.content !== "string" ||
      !doc.content.includes(query)
    )
      throw new Error("fictional document content was not preserved");
    found.push({ id: doc.id, contentHash: createHash("sha256").update(doc.content).digest("hex") });
  }
  if (new Set(found.map((d) => d.id)).size !== 3)
    throw new Error("expected three distinct fictional documents");
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** Retention can keep the count constant; completed backup identity must still change. */
export function newCompletedBackup(before, after) {
  const paths = (body) => {
    if (!Array.isArray(body.backups)) throw new Error("backup listing is missing");
    return body.backups
      .filter((b) => b.purpose === "pre-update")
      .map((b) => {
        if (typeof b.path !== "string" || !b.path) throw new Error("backup identity missing");
        return b.path;
      });
  };
  const previous = new Set(paths(before));
  if (!paths(after).some((path) => !previous.has(path)))
    throw new Error("retry created no new completed pre-update backup");
  return { newBackup: true };
}

/** The caller supplies a verified tiny tmpfs; refuse to fill an ordinary filesystem. */
export function exhaustTinyFilesystem(directory) {
  const fs = statfsSync(directory);
  const total = Number(fs.blocks) * Number(fs.bsize);
  if (Number(fs.type) !== 0x01021994 || total > 8 * 1024 * 1024 || total < 4096)
    throw new Error("disk fault requires a tmpfs of at most 8 MiB");
  const fd = openSync(join(directory, "fault-filler"), "wx", 0o600);
  let written = 0;
  try {
    const block = Buffer.alloc(4096, 0x5a);
    for (; written <= 8 * 1024 * 1024; written += block.length) writeSync(fd, block);
    throw new Error("finite disk-fill budget reached without ENOSPC");
  } catch (error) {
    if (error.code !== "ENOSPC") throw error;
  } finally {
    closeSync(fd);
  }
  const after = statfsSync(directory);
  if (Number(after.bavail) !== 0) throw new Error("tmpfs still has available blocks");
  return {
    filesystem: "tmpfs",
    totalBytes: total,
    writtenBytes: written,
    availableBytes: 0,
    error: "ENOSPC",
  };
}

function processIdentity(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      state: fields[0],
      parent: Number(fields[1]),
      group: Number(fields[2]),
      started: fields[19],
    };
  } catch {
    return null;
  }
}
/** A stale identity is a safe no-op; never signal a reused PID. */
export function signalOwnedProcess(pid, started, signal = "SIGTERM") {
  const identity = processIdentity(pid);
  if (!identity || identity.started !== started) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
function signalOwnedGate(identity, signal) {
  if (!identity || processIdentity(identity.pid)?.started !== identity.started) return;
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
/** Freeze only our updater before its final descendant snapshot, then retire its groups. */
function hardRetireUpdater(child, gate) {
  try {
    child.kill("SIGSTOP");
  } catch {
    /* The updater already exited. */
  }
  const descendants = new Set([child.pid]);
  const processes = existsSync("/proc")
    ? readdirSync("/proc")
        .filter((s) => /^\d+$/.test(s))
        .map((s) => processIdentity(Number(s)))
        .filter(Boolean)
    : [];
  for (let changed = true; changed;) {
    changed = false;
    for (const item of processes)
      if (descendants.has(item.parent) && !descendants.has(item.pid)) {
        descendants.add(item.pid);
        changed = true;
      }
  }
  for (const item of processes)
    if (descendants.has(item.pid) && processIdentity(item.pid)?.started === item.started)
      signalGroup(item.group, "SIGKILL");
  signalOwnedGate(gate, "SIGKILL");
  signalGroup(child.pid, "SIGKILL");
}

/** Retain both the transaction failure and the caught owned-resource retirement failure. */
export async function withOwnedCleanup(execute, cleanup) {
  let value, primary;
  let failed = false;
  try {
    value = await execute();
  } catch (error) {
    primary = error;
    failed = true;
  }
  try {
    await cleanup();
  } catch (error) {
    if (failed)
      throw new AggregateError(
        [primary, error],
        `${primary instanceof Error ? primary.message : String(primary)}; owned cleanup also failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    throw error;
  }
  if (failed) throw primary;
  return value;
}

/** Signal only the updater we spawned, after its npm child publishes entry. */
export async function interruptUpdate(
  command,
  args,
  { env, phaseDirectory, stateFile, targetCommit, timeoutMs = 300000, cleanupTimeoutMs = 10000 },
) {
  const child = spawn(command, args, { env, stdio: "inherit", detached: true });
  const terminal = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let exited = false;
  terminal.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  let gateIdentity = null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    child.kill("SIGTERM");
  };
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  const deadline = Date.now() + timeoutMs;
  return withOwnedCleanup(
    async () => {
      while (!existsSync(join(phaseDirectory, "entered/pid"))) {
        if (cancelled) throw new Error("fault controller interrupted");
        if (exited) throw new Error("updater exited before npm ci fault phase");
        if (Date.now() >= deadline) throw new Error("npm ci fault phase was never reached");
        await new Promise((r) => setTimeout(r, 50));
      }
      const npmPid = Number(readFileSync(join(phaseDirectory, "entered/pid"), "utf8").trim());
      if (!Number.isSafeInteger(npmPid) || npmPid <= 1) throw new Error("invalid entered npm PID");
      const observedGate = processIdentity(npmPid);
      let ancestor = observedGate;
      for (let depth = 0; ancestor && ancestor.parent !== child.pid && depth < 32; depth++)
        ancestor = processIdentity(ancestor.parent);
      if (!observedGate || ancestor?.parent !== child.pid)
        throw new Error("entered npm PID does not belong to this updater");
      gateIdentity = observedGate;
      if (stateFile) {
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        if (
          state.method !== "source" ||
          state.phase !== "applying" ||
          state.targetCommit !== targetCommit
        )
          throw new Error("npm gate was not inside the target source apply transaction");
      }
      validateDependencyDamage(
        env.UPDATE_FAULT_SOURCE,
        JSON.parse(readFileSync(join(phaseDirectory, "damage.json"))),
      );
      if (!child.kill("SIGTERM")) throw new Error("updater disappeared before interruption");
      const result = await Promise.race([
        terminal,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("interrupted updater did not finish recovery")),
            600000,
          );
          timer.unref();
        }),
      ]);
      if (cancelled) throw new Error("fault controller interrupted");
      if (result.code !== 143 || result.signal !== null)
        throw new Error(`updater did not handle SIGTERM: ${JSON.stringify(result)}`);
      // A live gated child would let rollback race the install it is undoing.
      try {
        process.kill(npmPid, 0);
      } catch (error) {
        if (error.code === "ESRCH")
          return { phase: "npm ci", signal: "SIGTERM", exitCode: result.code, childRetired: true };
        throw error;
      }
      throw new Error("gated npm child survived updater recovery");
    },
    async () => {
      try {
        try {
          if (!exited) {
            child.kill("SIGTERM");
            const timer = setTimeout(
              () => hardRetireUpdater(child, gateIdentity),
              cleanupTimeoutMs,
            );
            try {
              await terminal;
            } finally {
              clearTimeout(timer);
            }
          }
        } finally {
          signalOwnedGate(gateIdentity, "SIGKILL");
          signalGroup(child.pid, "SIGKILL");
        }
        if (gateIdentity) {
          const deadline = Date.now() + 2000;
          for (;;) {
            const current = processIdentity(gateIdentity.pid);
            if (!current || current.started !== gateIdentity.started || current.state === "Z")
              break;
            if (Date.now() >= deadline) throw new Error("owned gate did not retire after cleanup");
            await new Promise((r) => setTimeout(r, 10));
          }
        }
      } finally {
        process.removeListener("SIGTERM", cancel);
        process.removeListener("SIGINT", cancel);
      }
    },
  );
}

async function main([command, ...args]) {
  if (command === "gate") {
    const proof = damageDependencyTree(args[0]);
    writeFileSync(join(process.env.UPDATE_FAULT_DIR, "damage.json"), JSON.stringify(proof) + "\n", {
      mode: 0o600,
    });
    writeFileSync(join(process.env.UPDATE_FAULT_DIR, "entered/pid"), String(process.pid));
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  }
  if (command === "verify-dependency")
    return verifyDependencyRestored(args[0], JSON.parse(readFileSync(args[1])));
  if (command === "record-process") {
    const identity = processIdentity(Number(args[0]));
    if (!identity || identity.parent !== Number(args[1]))
      throw new Error("process is not owned by this lane");
    return { pid: identity.pid, started: identity.started };
  }
  if (command === "signal-process")
    return { signaled: signalOwnedProcess(Number(args[0]), args[1]) };
  if (command === "guard") return validateDisposableRunner(process.env, args[0], args[1]);
  if (command === "verify-new-backup")
    return newCompletedBackup(JSON.parse(readFileSync(args[0])), JSON.parse(readFileSync(args[1])));
  if (command === "identity") return encryptedIdentity(args[0]);
  if (command === "documents")
    return seededDocuments(args[0], readFileSync(args[1], "utf8").trim());
  if (command === "fill") return exhaustTinyFilesystem(args[0]);
  if (command === "interrupt")
    return interruptUpdate(args[0], ["update", "--yes"], {
      env: process.env,
      phaseDirectory: process.env.UPDATE_FAULT_DIR,
      stateFile: args[1] && join(args[1], "update-state.json"),
      targetCommit: args[2],
    });
  throw new Error("expected identity, fill, or interrupt");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch((error) => {
      process.stderr.write(`update fault: ${error.message}\n`);
      process.exitCode = 1;
    });
}
