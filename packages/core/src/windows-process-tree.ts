// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
export {
  windowsPowerShellExecutable,
  windowsProcessStart,
} from "@omnesis/platform/windows-powershell";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10_000;
export interface WindowsProcessIdentity {
  pid: number;
  parentPid: number;
  birth: string;
}

export type WindowsProcessBackend = Pick<
  typeof import("@omnesis/platform/windows-process"),
  | "snapshotWindowsProcesses"
  | "snapshotWindowsProcessesSync"
  | "killWindowsProcesses"
  | "killWindowsProcessesSync"
>;
let nativeBackend: WindowsProcessBackend | undefined;
let nativeLoading: Promise<WindowsProcessBackend> | undefined;
const require = createRequire(import.meta.url);
function backend(): Promise<WindowsProcessBackend> {
  if (nativeBackend) return Promise.resolve(nativeBackend);
  return (nativeLoading ??= import("@omnesis/platform/windows-process")
    .then((loaded) => {
      nativeBackend = loaded;
      return loaded;
    })
    .catch((error) => {
      nativeLoading = undefined;
      throw error;
    }));
}
function backendSync(): WindowsProcessBackend {
  return (nativeBackend ??= require("@omnesis/platform/windows-process") as WindowsProcessBackend);
}

export interface WindowsProcessTreeOptions {
  /** Raw Node check runners inject the existing narrowly bootstrapped platform facade. */
  backend?: WindowsProcessBackend;
  snapshot?: () => Promise<WindowsProcessIdentity[]>;
  snapshotSync?: () => WindowsProcessIdentity[];
  kill?: (pid: number, birth: string) => Promise<void>;
  killSync?: (pid: number, birth: string) => void;
  /** Bind first adoption to the original ChildProcess, not a reusable PID lookup. */
  rootIsAlive?: () => boolean;
}

function taskkillCommand(): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  if (!root || !win32.isAbsolute(root)) throw new Error("Windows system directory is unavailable");
  return win32.join(root, "System32", "taskkill.exe");
}

function taskkillArgs(pid: number, tree = true): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid child process PID");
  return ["/PID", String(pid), ...(tree ? ["/T"] : []), "/F"];
}

/** Force-stop a live root and descendants; the caller owns taskkill through exit. */
export async function killWindowsProcessTree(pid: number): Promise<void> {
  const args = taskkillArgs(pid);
  await execFileAsync(taskkillCommand(), args, {
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
  });
}

/**
 * Retain observed birth identities across a leader's exit and reparenting.
 * Ownership starts only after observing the live original ChildProcess. A numeric parent PID
 * alone cannot safely recover a tree whose root vanished before observation.
 * Refresh while the root is alive so teardown owns its detached descendants.
 * The class remains raw-Node importable without loading the platform's .js
 * dependency graph; raw check runners inject that facade through their existing
 * narrowly scoped source bootstrap. Normal app runtimes load the backend lazily.
 */
export class WindowsProcessTree {
  private readonly rootPid: number;
  private readonly options: Required<Omit<WindowsProcessTreeOptions, "backend">>;
  private readonly births = new Map<number, string>();
  private current: WindowsProcessIdentity[] = [];
  private refreshing: Promise<void> | null = null;
  private killing: Promise<void> | null = null;

  constructor(rootPid: number, options: WindowsProcessTreeOptions = {}) {
    if (!Number.isSafeInteger(rootPid) || rootPid <= 0)
      throw new Error("Invalid child process PID");
    this.rootPid = rootPid;
    const { backend: suppliedBackend, ...overrides } = options;
    this.options = {
      snapshot: async () =>
        (suppliedBackend ?? (await backend())).snapshotWindowsProcesses(this.queryRoots()),
      snapshotSync: () =>
        (suppliedBackend ?? backendSync()).snapshotWindowsProcessesSync(this.queryRoots()),
      kill: async (pid, birth) =>
        (suppliedBackend ?? (await backend())).killWindowsProcesses([{ pid, birth }]),
      killSync: (pid, birth) =>
        (suppliedBackend ?? backendSync()).killWindowsProcessesSync([{ pid, birth }]),
      rootIsAlive: () => false,
      ...overrides,
    };
  }

  private queryRoots(): number[] {
    // Birth history prevents PID reuse from resetting ownership; it is not a
    // list of processes that still warrant opening after they leave the tree.
    return [
      ...new Set([
        ...(this.options.rootIsAlive() ? [this.rootPid] : []),
        ...this.current.filter((row) => row.pid !== this.rootPid).map((row) => row.pid),
      ]),
    ];
  }

  get alive(): boolean {
    return this.current.length > 0;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const pending = this.options.snapshot().then((rows) => {
      this.observe(rows);
    });
    this.refreshing = pending;
    try {
      await pending;
    } finally {
      if (this.refreshing === pending) this.refreshing = null;
    }
  }

  private observe(rows: WindowsProcessIdentity[]): void {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const root = byPid.get(this.rootPid);
    if (this.births.size === 0 && root && this.options.rootIsAlive())
      this.births.set(root.pid, root.birth);
    let added: boolean;
    do {
      added = false;
      for (const row of rows) {
        if (this.births.get(row.pid) === row.birth || row.pid === this.rootPid) continue;
        const parent = byPid.get(row.parentPid);
        if (!parent || this.births.get(parent.pid) !== parent.birth) continue;
        if (BigInt(row.birth) < BigInt(parent.birth)) continue;
        this.births.set(row.pid, row.birth);
        added = true;
      }
    } while (added);
    this.current = [...this.births].flatMap(([pid, birth]) => {
      const row = byPid.get(pid);
      return row?.birth === birth ? [row] : [];
    });
  }

  /** Share teardown work between exit observers and explicit lifecycle owners. */
  kill(): Promise<void> {
    if (this.killing) return this.killing;
    const pending = Promise.resolve().then(() => this.killOwned());
    this.killing = pending;
    void pending
      .finally(() => {
        if (this.killing === pending) this.killing = null;
      })
      .catch(() => {});
    return pending;
  }

  /** Refresh before every target, including children observed while cleanup runs. */
  private async killOwned(): Promise<void> {
    const attempted = new Set<string>();
    for (;;) {
      await this.refresh();
      const target = [...this.current]
        .reverse()
        .find((row) => !attempted.has(`${row.pid}:${row.birth}`));
      if (!target) return;
      attempted.add(`${target.pid}:${target.birth}`);
      try {
        await this.options.kill(target.pid, target.birth);
      } catch (error) {
        await this.refresh();
        if (this.current.some((row) => row.pid === target.pid && row.birth === target.birth))
          throw error;
      }
    }
  }

  /** Last-resort process-exit cleanup, when asynchronous work cannot run. */
  killSync(): void {
    const attempted = new Set<string>();
    for (;;) {
      this.observe(this.options.snapshotSync());
      const target = [...this.current]
        .reverse()
        .find((row) => !attempted.has(`${row.pid}:${row.birth}`));
      if (!target) return;
      attempted.add(`${target.pid}:${target.birth}`);
      try {
        this.options.killSync(target.pid, target.birth);
      } catch (error) {
        this.observe(this.options.snapshotSync());
        if (this.current.some((row) => row.pid === target.pid && row.birth === target.birth))
          throw error;
      }
    }
  }
}
