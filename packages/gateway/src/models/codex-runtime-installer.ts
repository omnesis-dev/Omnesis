// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-owned installation of the one Codex runtime tested by this release.
 *
 * Runtime bits are immutable, versioned, and contain no login state. Codex
 * authentication remains in the separate shared home managed by
 * {@link CodexRuntimeService}. The service decides when turns are drained;
 * this collaborator only prepares, validates, and atomically selects bits.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  CODEX_RUNTIME_COMPAT,
  CodexAppServerRuntime,
  buildCodexEnv,
  parseCodexCliVersion,
  type CodexRuntimeCommandInfo,
} from "@omnesis/agent";
import { codexPaths } from "@omnesis/core";
import { CODEX_RUNTIME_LOCK } from "./codex-runtime-lock.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const properLockfile = require("proper-lockfile") as {
  lock(
    path: string,
    opts: {
      lockfilePath: string;
      realpath: boolean;
      stale: number;
      update: number;
      retries: number;
      onCompromised: (err: Error) => void;
    },
  ): Promise<() => Promise<void>>;
};
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const LOCK_STALE_MS = 60_000;
const LOCK_UPDATE_MS = 10_000;

export interface CodexInstallCommandResult {
  stdout: string;
  stderr: string;
}

export type CodexInstallCommandRunner = (
  command: string,
  args: readonly string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
) => Promise<CodexInstallCommandResult>;

export type CodexRuntimeCompatibilityProbe = (
  commandInfo: CodexRuntimeCommandInfo,
  opts: {
    codexHome: string;
    workspaceDir: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
) => Promise<void>;

export interface PreparedCodexRuntime {
  readonly id: string;
  readonly version: string;
  readonly stagingDir: string;
}

export interface InstalledCodexRuntime extends CodexRuntimeCommandInfo {
  readonly source: "managed";
  readonly version: string;
  readonly installDir: string;
}

interface RuntimePointer {
  schemaVersion: 1;
  version: string;
  generation?: string;
  previousVersion?: string;
  previousGeneration?: string;
  activatedAt: string;
}

interface RuntimeRef {
  version: string;
  generation: string;
}

interface HeldLock {
  release: () => Promise<void>;
  compromised: Error | null;
}

export interface CodexRuntimeInstallerOptions {
  configDir: string;
  npmCommand?: string;
  env?: NodeJS.ProcessEnv;
  installTimeoutMs?: number;
  probeTimeoutMs?: number;
  runner?: CodexInstallCommandRunner;
  compatibilityProbe?: CodexRuntimeCompatibilityProbe;
  now?: () => Date;
  id?: () => string;
}

type CodexRuntimePreparePhase = "downloading" | "verifying";

export class CodexRuntimeInstaller {
  readonly targetVersion = CODEX_RUNTIME_COMPAT.testedVersion;

  private readonly paths: ReturnType<typeof codexPaths>;
  private readonly npmCommand: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly installTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly runner: CodexInstallCommandRunner;
  private readonly compatibilityProbe: CodexRuntimeCompatibilityProbe;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly heldLocks = new Map<string, HeldLock>();

  constructor(opts: CodexRuntimeInstallerOptions) {
    this.paths = codexPaths(opts.configDir);
    this.npmCommand = opts.npmCommand ?? (process.platform === "win32" ? "npm.cmd" : "npm");
    this.env = opts.env ?? process.env;
    this.installTimeoutMs = opts.installTimeoutMs ?? 5 * 60_000;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 15_000;
    this.runner = opts.runner ?? runCommand;
    this.compatibilityProbe = opts.compatibilityProbe ?? probeAppServerCompatibility;
    this.now = opts.now ?? (() => new Date());
    this.id = opts.id ?? randomUUID;
  }

  /** Resolve and revalidate the selected gateway-owned runtime. */
  async readActive(): Promise<InstalledCodexRuntime | null> {
    await this.ensureStore();
    const maintenanceId = `read-${this.id()}`;
    try {
      await this.acquireLock(maintenanceId);
      return await this.recoverActive();
    } catch (err) {
      if (!isAlreadyLocked(err)) throw err;
      return this.readActiveWithoutRecovery();
    } finally {
      await this.releaseLock(maintenanceId);
    }
  }

  /** Download and validate the tested runtime without changing the active one. */
  async prepare(
    signal?: AbortSignal,
    onPhase?: (phase: CodexRuntimePreparePhase) => void,
  ): Promise<PreparedCodexRuntime> {
    signal?.throwIfAborted();
    await this.ensureStore();
    const id = this.id();
    if (!isSafeOperationId(id)) {
      throw new Error("Codex runtime update id contains unsafe path characters.");
    }
    await this.acquireLock(id);
    const stagingDir = join(this.paths.runtimeStaging, id);
    try {
      await this.recoverActive();
      await mkdir(stagingDir, { recursive: false, mode: 0o700 });
      await chmod(stagingDir, 0o700);
      await writeFile(
        join(stagingDir, "package.json"),
        `${JSON.stringify(
          {
            private: true,
            dependencies: {
              [CODEX_RUNTIME_COMPAT.packageName]: CODEX_RUNTIME_COMPAT.testedVersion,
            },
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await writeFile(
        join(stagingDir, "package-lock.json"),
        `${JSON.stringify(CODEX_RUNTIME_LOCK, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      const npmHome = join(stagingDir, ".npm-home");
      const npmCache = join(stagingDir, ".npm-cache");
      await mkdir(npmHome, { mode: 0o700 });
      await mkdir(npmCache, { mode: 0o700 });
      onPhase?.("downloading");
      await this.runner(
        this.npmCommand,
        ["ci", "--prefix", stagingDir, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
        {
          env: buildNpmEnv(this.env, npmHome, npmCache),
          timeoutMs: this.installTimeoutMs,
          signal,
        },
      );
      await Promise.all([
        rm(npmHome, { recursive: true, force: true }),
        rm(npmCache, { recursive: true, force: true }),
      ]);
      onPhase?.("verifying");
      // npm's convenience links are unnecessary because Omnesis resolves the
      // package bin directly. Keeping no links in this owner-only tree makes
      // its security boundary auditable and prevents link replacement attacks.
      await rm(join(stagingDir, "node_modules", ".bin"), { recursive: true, force: true });
      await hardenRuntimeTree(stagingDir);
      const installed = await this.verifyInstalled(
        stagingDir,
        CODEX_RUNTIME_COMPAT.testedVersion,
        signal,
      );
      signal?.throwIfAborted();
      const probeRoot = join(stagingDir, ".omnesis-compat-probe");
      try {
        await this.compatibilityProbe(installed, {
          codexHome: join(probeRoot, "home"),
          workspaceDir: join(probeRoot, "workspace"),
          timeoutMs: this.probeTimeoutMs,
          env: this.env,
          signal,
        });
      } finally {
        await rm(probeRoot, { recursive: true, force: true }).catch(() => {});
      }
      return { id, version: CODEX_RUNTIME_COMPAT.testedVersion, stagingDir };
    } catch (err) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      await this.releaseLock(id);
      throw err;
    }
  }

  /**
   * Move prepared bits into their immutable version directory and select them.
   * A same-version repair retains the prior generation as the rollback target.
   */
  async commit(prepared: PreparedCodexRuntime): Promise<InstalledCodexRuntime> {
    this.assertPrepared(prepared);
    const generation = generationName(prepared.version, prepared.id);
    const finalDir = join(this.paths.runtimeVersions, generation);
    let published = false;
    try {
      this.assertHeld(prepared.id);
      if (await lstatOrNull(finalDir))
        throw new Error(`Codex runtime generation already exists: ${generation}.`);
      await rename(prepared.stagingDir, finalDir);
      await syncDirectory(this.paths.runtimeVersions);
      const installed = await this.verifyInstalled(finalDir, prepared.version);
      const prior = await this.readPointerRef();
      this.assertHeld(prepared.id);
      // From this point onward retain the immutable generation even if pointer
      // publication fails. It is a harmless orphan recoverable on the next
      // locked inspection; deleting it after rename may have published the
      // pointer but failed only on the directory durability barrier.
      published = true;
      await this.writePointer({
        schemaVersion: 1,
        version: prepared.version,
        generation,
        ...(prior ? { previousVersion: prior.version, previousGeneration: prior.generation } : {}),
        activatedAt: this.now().toISOString(),
      });
      return installed;
    } catch (err) {
      // The pointer rename is the commit boundary. If only the following
      // directory durability barrier failed, adopt the generation selected by
      // every reader instead of recreating a live predecessor while the
      // persisted pointer names this generation.
      if (published) {
        const selected = await this.readPointerRef().catch(() => null);
        if (selected?.generation === generation) {
          return this.verifyInstalled(finalDir, prepared.version);
        }
      }
      if (!published) await rm(finalDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally {
      await this.releaseLock(prepared.id);
    }
  }

  async discard(prepared: PreparedCodexRuntime): Promise<void> {
    this.assertPrepared(prepared);
    try {
      this.assertHeld(prepared.id);
      await rm(prepared.stagingDir, { recursive: true, force: true });
    } finally {
      await this.releaseLock(prepared.id);
    }
  }

  /** Atomically repoint to the retained immutable predecessor. */
  async rollbackActivation(): Promise<void> {
    await this.ensureStore();
    const id = `rollback-${this.id()}`;
    await this.acquireLock(id);
    try {
      const pointer = await this.readPointer();
      if (!pointer) return;
      const current = pointerRef(pointer);
      const previous = previousPointerRef(pointer);
      if (!previous) {
        await rm(this.paths.runtimeCurrent, { force: true });
        await syncDirectory(this.paths.runtimeStore);
        return;
      }
      await this.verifyRef(previous);
      await this.writePointer({
        schemaVersion: 1,
        version: previous.version,
        generation: previous.generation,
        previousVersion: current.version,
        previousGeneration: current.generation,
        activatedAt: this.now().toISOString(),
      });
    } finally {
      await this.releaseLock(id);
    }
  }

  /** Validate package metadata, bin containment, and the executable's version. */
  async verifyInstalled(
    installDir: string,
    expectedVersion: string,
    signal?: AbortSignal,
  ): Promise<InstalledCodexRuntime> {
    await assertDirectoryWithin(this.paths.runtimeStore, installDir);
    const packageJsonPath = join(
      installDir,
      "node_modules",
      ...CODEX_RUNTIME_COMPAT.packageName.split("/"),
      "package.json",
    );
    const packageStat = await lstat(packageJsonPath);
    if (packageStat.isSymbolicLink() || !packageStat.isFile()) {
      throw new Error("Installed Codex package manifest is not a regular file.");
    }
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Installed Codex package manifest is invalid.");
    if (parsed.name !== CODEX_RUNTIME_COMPAT.packageName || parsed.version !== expectedVersion) {
      throw new Error(
        `Installed Codex package identity mismatch (expected ${CODEX_RUNTIME_COMPAT.packageName}@${expectedVersion}).`,
      );
    }
    const bin = codexBin(parsed.bin);
    if (!bin || isAbsolute(bin))
      throw new Error("Installed Codex package has an invalid codex bin.");
    const command = resolve(dirname(packageJsonPath), bin);
    await assertRealPathWithin(dirname(packageJsonPath), command);
    const commandStat = await lstat(command);
    if (commandStat.isSymbolicLink() || !commandStat.isFile()) {
      throw new Error("Installed Codex command is not a regular file.");
    }
    const probe = await this.runner(command, ["--version"], {
      env: buildCodexEnv(this.env, join(installDir, ".omnesis-version-probe")),
      timeoutMs: this.probeTimeoutMs,
      signal,
    });
    const reported = parseCodexCliVersion(`${probe.stdout}${probe.stderr}`);
    if (reported !== expectedVersion) {
      throw new Error(
        `Installed Codex command reported ${reported ?? "an unrecognized version"}; expected ${expectedVersion}.`,
      );
    }
    return {
      source: "managed",
      command,
      packageName: CODEX_RUNTIME_COMPAT.packageName,
      packageVersion: expectedVersion,
      version: expectedVersion,
      installDir,
    };
  }

  private async ensureStore(): Promise<void> {
    for (const path of [
      this.paths.runtimeStore,
      this.paths.runtimeVersions,
      this.paths.runtimeStaging,
    ]) {
      const before = await lstatOrNull(path);
      if (before?.isSymbolicLink())
        throw new Error(`Refusing symlinked Codex runtime path ${path}.`);
      if (before && !before.isDirectory())
        throw new Error(`Codex runtime path ${path} is not a directory.`);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
  }

  private async acquireLock(id: string): Promise<void> {
    let held: HeldLock | null = null;
    let release: (() => Promise<void>) | null = null;
    try {
      release = await properLockfile.lock(this.paths.runtimeStore, {
        lockfilePath: this.paths.runtimeUpdateLock,
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
        retries: 0,
        onCompromised: (err) => {
          if (held) held.compromised = err;
        },
      });
      await chmod(this.paths.runtimeUpdateLock, 0o700);
      held = { release, compromised: null };
      this.heldLocks.set(id, held);
    } catch (err) {
      await release?.().catch(() => {});
      if (isAlreadyLocked(err)) {
        throw Object.assign(new Error("Another Codex runtime update is already in progress."), {
          code: "ELOCKED",
        });
      }
      throw err;
    }
  }

  private assertHeld(id: string): void {
    const held = this.heldLocks.get(id);
    if (!held) throw new Error("Prepared Codex runtime no longer owns the update lock.");
    if (held.compromised)
      throw new Error(`Codex runtime update lock was compromised: ${held.compromised.message}`);
  }

  private async releaseLock(id: string): Promise<void> {
    const held = this.heldLocks.get(id);
    if (!held) return;
    this.heldLocks.delete(id);
    await held.release().catch(() => {});
  }

  private assertPrepared(prepared: PreparedCodexRuntime): void {
    const expected = join(this.paths.runtimeStaging, prepared.id);
    if (
      prepared.version !== CODEX_RUNTIME_COMPAT.testedVersion ||
      prepared.stagingDir !== expected ||
      !isSafeOperationId(prepared.id)
    ) {
      throw new Error("Prepared Codex runtime does not belong to this installer.");
    }
  }

  private async readPointer(): Promise<RuntimePointer | null> {
    const current = await lstatOrNull(this.paths.runtimeCurrent);
    if (!current) return null;
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new Error("Codex runtime pointer is not a regular file.");
    }
    return parsePointer(await readFile(this.paths.runtimeCurrent, "utf8"));
  }

  private async readPointerRef(): Promise<RuntimeRef | null> {
    const pointer = await this.readPointer();
    return pointer ? pointerRef(pointer) : null;
  }

  private async writePointer(pointer: RuntimePointer): Promise<void> {
    const current = await lstatOrNull(this.paths.runtimeCurrent);
    if (current?.isSymbolicLink()) throw new Error("Refusing symlinked Codex runtime pointer.");
    const pointerId = this.id();
    if (!isSafeOperationId(pointerId)) {
      throw new Error("Codex runtime pointer id contains unsafe path characters.");
    }
    const temporary = join(this.paths.runtimeStore, `.current-${pointerId}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(pointer, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    try {
      await rename(temporary, this.paths.runtimeCurrent);
      await syncDirectory(this.paths.runtimeStore);
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => {});
      throw err;
    }
  }

  private async readActiveWithoutRecovery(): Promise<InstalledCodexRuntime | null> {
    const pointer = await this.readPointer();
    return pointer ? this.verifyRef(pointerRef(pointer)) : null;
  }

  private async verifyRef(ref: RuntimeRef): Promise<InstalledCodexRuntime> {
    return this.verifyInstalled(join(this.paths.runtimeVersions, ref.generation), ref.version);
  }

  private async recoverActive(): Promise<InstalledCodexRuntime | null> {
    let pointer = await this.readPointer();
    let active: InstalledCodexRuntime | null = null;
    if (pointer) {
      try {
        active = await this.verifyRef(pointerRef(pointer));
      } catch (currentError) {
        const previous = previousPointerRef(pointer);
        if (previous) {
          try {
            active = await this.verifyRef(previous);
            await this.writePointer({
              schemaVersion: 1,
              version: previous.version,
              generation: previous.generation,
              activatedAt: this.now().toISOString(),
            });
            pointer = await this.readPointer();
          } catch (previousError) {
            throw new AggregateError(
              [currentError, previousError],
              "Neither the selected nor previous Codex runtime is usable.",
              { cause: previousError },
            );
          }
        } else {
          throw currentError;
        }
      }
    }
    // Generations and interrupted staging are deliberately immutable here.
    // A compromised cross-process lock can acquire a new owner between any
    // ownership check and recursive deletion. Leaving rare crash debris is
    // safer than allowing a stale gateway to delete another gateway's active
    // or in-progress runtime.
    return active;
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<CodexInstallCommandResult> {
  const result = await execFileAsync(command, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
    maxBuffer: MAX_COMMAND_OUTPUT,
    windowsHide: true,
    signal: opts.signal,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function buildNpmEnv(
  source: NodeJS.ProcessEnv,
  npmHome: string,
  npmCache: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: npmHome,
    USERPROFILE: npmHome,
    npm_config_cache: npmCache,
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: join(npmHome, "npmrc"),
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  for (const key of [
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "COMSPEC",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

async function probeAppServerCompatibility(
  commandInfo: CodexRuntimeCommandInfo,
  opts: {
    codexHome: string;
    workspaceDir: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<void> {
  opts.signal?.throwIfAborted();
  const runtime = new CodexAppServerRuntime({
    codexHome: opts.codexHome,
    workspaceDir: opts.workspaceDir,
    commandInfo,
    env: opts.env,
    startupTimeoutMs: opts.timeoutMs,
    requestTimeoutMs: opts.timeoutMs,
  });
  const abort = () => void runtime.dispose();
  opts.signal?.addEventListener("abort", abort, { once: true });
  try {
    // listModels forces process spawn, initialize, and a typed model/list
    // round-trip without starting an inference turn or reading shared auth.
    await runtime.listModels(opts.timeoutMs);
  } finally {
    opts.signal?.removeEventListener("abort", abort);
    await runtime.dispose();
  }
}

function parsePointer(text: string): RuntimePointer {
  const value = JSON.parse(text) as unknown;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.version !== "string" ||
    !isSafeVersion(value.version) ||
    (value.generation !== undefined &&
      (typeof value.generation !== "string" || !isSafeGeneration(value.generation))) ||
    typeof value.activatedAt !== "string" ||
    (value.previousVersion !== undefined &&
      (typeof value.previousVersion !== "string" || !isSafeVersion(value.previousVersion))) ||
    (value.previousGeneration !== undefined &&
      (typeof value.previousGeneration !== "string" ||
        !isSafeGeneration(value.previousGeneration))) ||
    (value.previousGeneration !== undefined && value.previousVersion === undefined)
  ) {
    throw new Error("Codex runtime pointer is invalid.");
  }
  return value as unknown as RuntimePointer;
}

function isSafeVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function isSafeGeneration(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?--[A-Za-z0-9._-]+$/.test(value) || isSafeVersion(value);
}

function generationName(version: string, id: string): string {
  return `${version}--${id}`;
}

function isSafeOperationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function pointerRef(pointer: RuntimePointer): RuntimeRef {
  return { version: pointer.version, generation: pointer.generation ?? pointer.version };
}

function previousPointerRef(pointer: RuntimePointer): RuntimeRef | null {
  if (!pointer.previousVersion) return null;
  return {
    version: pointer.previousVersion,
    generation: pointer.previousGeneration ?? pointer.previousVersion,
  };
}

function codexBin(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  return typeof value.codex === "string" ? value.codex : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAlreadyLocked(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ELOCKED";
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (err) {
    // Windows cannot open directories as file handles. Rename remains atomic;
    // directory fsync is the extra durability barrier on platforms that offer it.
    if (process.platform !== "win32") throw err;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function assertDirectoryWithin(root: string, candidate: string): Promise<void> {
  const candidateStat = await lstat(candidate);
  if (candidateStat.isSymbolicLink() || !candidateStat.isDirectory()) {
    throw new Error(`Codex runtime install ${candidate} is not a regular directory.`);
  }
  await assertRealPathWithin(root, candidate);
}

async function assertRealPathWithin(root: string, candidate: string): Promise<void> {
  const [rootReal, candidateReal] = await Promise.all([realpath(root), realpath(candidate)]);
  const rel = relative(rootReal, candidateReal);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`Codex runtime path escapes its owner-only store: ${candidate}.`);
}

async function hardenRuntimeTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Installed Codex runtime contains an unexpected symlink: ${path}.`);
    }
    if (entry.isDirectory()) {
      await chmod(path, 0o700);
      await hardenRuntimeTree(path);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Installed Codex runtime contains an unsupported filesystem entry: ${path}.`);
    }
    const fileStat = await lstat(path);
    await chmod(path, (fileStat.mode & 0o111) === 0 ? 0o600 : 0o700);
  }
  await chmod(root, 0o700);
}
