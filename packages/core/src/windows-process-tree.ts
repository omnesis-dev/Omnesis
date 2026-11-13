// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile, execFileSync } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { windowsPowerShellExecutable } from "@omnesis/platform/windows-powershell";
export { windowsPowerShellExecutable } from "@omnesis/platform/windows-powershell";

const execFileAsync = promisify(execFile);
const PROCESS_QUERY = `
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  if ($null -ne $_.CreationDate) {
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      parentPid = [int]$_.ParentProcessId
      birth = $_.CreationDate.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
  }
})
ConvertTo-Json -Compress -InputObject $rows
`;
const QUERY_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROCESS_QUERY];
const KILL_OWNED_PROCESS = `
$ErrorActionPreference = 'Stop'
$targetProcess = $null
try {
  try {
    $targetProcess = [System.Diagnostics.Process]::GetProcessById([int]$env:OMNESIS_OWNED_PROCESS_PID)
    $null = $targetProcess.Handle
  } catch [System.ArgumentException] { exit 0 } catch [System.InvalidOperationException] { exit 0 }
  $ticks = $targetProcess.StartTime.ToUniversalTime().Ticks
  # CIM datetime records microseconds; compare creation time at that resolution.
  $birth = ($ticks - ($ticks % 10)).ToString([System.Globalization.CultureInfo]::InvariantCulture)
  if ($birth -ne $env:OMNESIS_OWNED_PROCESS_BIRTH -or $targetProcess.HasExited) { exit 0 }
  $targetProcess.Kill()
  if (-not $targetProcess.WaitForExit(5000)) { throw 'Owned Windows process did not exit' }
} finally {
  if ($null -ne $targetProcess) { $targetProcess.Dispose() }
}
`;
const KILL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", KILL_OWNED_PROCESS];
const COMMAND_TIMEOUT_MS = 10_000;
let ownBirth: string | undefined;

/** Exact UTC creation ticks for durable ownership records; only this process is cached. */
export function windowsProcessStart(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid && ownBirth !== undefined) return ownBirth;
  try {
    const birth = execFileSync(
      windowsPowerShellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference = 'Stop'; [Console]::Out.Write((Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture))`,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: COMMAND_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!/^[0-9]+$/u.test(birth)) return null;
    if (pid === process.pid) ownBirth = birth;
    return birth;
  } catch {
    return null;
  }
}

export interface WindowsProcessIdentity {
  pid: number;
  parentPid: number;
  birth: string;
}

export interface WindowsProcessTreeOptions {
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

function ownedProcessEnvironment(pid: number, birth: string): NodeJS.ProcessEnv {
  taskkillArgs(pid);
  if (!/^[0-9]+$/u.test(birth)) throw new Error("Invalid child process birth identity");
  return {
    ...process.env,
    OMNESIS_OWNED_PROCESS_PID: String(pid),
    OMNESIS_OWNED_PROCESS_BIRTH: birth,
  };
}

/** Pin Process.Handle before comparing creation time; Kill reuses that handle. */
function killWindowsProcessSync(pid: number, birth: string): void {
  execFileSync(windowsPowerShellExecutable(), KILL_ARGS, {
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
    stdio: "ignore",
    env: ownedProcessEnvironment(pid, birth),
  });
}

async function killWindowsProcess(pid: number, birth: string): Promise<void> {
  await execFileAsync(windowsPowerShellExecutable(), KILL_ARGS, {
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
    env: ownedProcessEnvironment(pid, birth),
  });
}

function parseSnapshot(raw: string): WindowsProcessIdentity[] {
  const rows: unknown = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  if (!Array.isArray(rows)) throw new Error("Invalid Windows process snapshot");
  return rows.map((value: unknown) => {
    if (typeof value !== "object" || value === null)
      throw new Error("Invalid Windows process identity");
    const row = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.pid) ||
      Number(row.pid) < 0 ||
      !Number.isSafeInteger(row.parentPid) ||
      Number(row.parentPid) < 0 ||
      typeof row.birth !== "string" ||
      !/^[0-9]+$/u.test(row.birth)
    )
      throw new Error("Invalid Windows process identity");
    return { pid: Number(row.pid), parentPid: Number(row.parentPid), birth: row.birth };
  });
}

async function snapshot(): Promise<WindowsProcessIdentity[]> {
  const result = await execFileAsync(windowsPowerShellExecutable(), QUERY_ARGS, {
    encoding: "utf8",
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseSnapshot(result.stdout);
}

function snapshotSync(): WindowsProcessIdentity[] {
  return parseSnapshot(
    execFileSync(windowsPowerShellExecutable(), QUERY_ARGS, {
      encoding: "utf8",
      windowsHide: true,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
}

/**
 * Retain observed birth identities across a leader's exit and reparenting.
 * Ownership starts only after observing the live original ChildProcess. A numeric parent PID
 * alone cannot safely recover a tree whose root vanished before observation.
 * Refresh while the root is alive so teardown owns its detached descendants.
 * This file uses only erasable TypeScript and built-ins: Node check runners
 * also import it directly without the application's development loader.
 */
export class WindowsProcessTree {
  private readonly rootPid: number;
  private readonly options: Required<WindowsProcessTreeOptions>;
  private readonly births = new Map<number, string>();
  private current: WindowsProcessIdentity[] = [];
  private refreshing: Promise<void> | null = null;

  constructor(rootPid: number, options: WindowsProcessTreeOptions = {}) {
    if (!Number.isSafeInteger(rootPid) || rootPid <= 0)
      throw new Error("Invalid child process PID");
    this.rootPid = rootPid;
    this.options = {
      snapshot,
      snapshotSync,
      kill: killWindowsProcess,
      killSync: killWindowsProcessSync,
      rootIsAlive: () => false,
      ...options,
    };
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

  /** Verify each target's birth again; descendants go first while their roots exist. */
  async kill(): Promise<void> {
    await this.refresh();
    const targets = [...this.current].reverse();
    for (const target of targets) {
      await this.refresh();
      if (!this.current.some((row) => row.pid === target.pid && row.birth === target.birth))
        continue;
      try {
        await this.options.kill(target.pid, target.birth);
      } catch (error) {
        await this.refresh();
        if (this.current.some((row) => row.pid === target.pid && row.birth === target.birth))
          throw error;
      }
    }
    await this.refresh();
  }

  /** Last-resort process-exit cleanup, when asynchronous work cannot run. */
  killSync(): void {
    this.observe(this.options.snapshotSync());
    for (const target of [...this.current].reverse()) {
      this.observe(this.options.snapshotSync());
      if (!this.current.some((row) => row.pid === target.pid && row.birth === target.birth))
        continue;
      try {
        this.options.killSync(target.pid, target.birth);
      } catch (error) {
        this.observe(this.options.snapshotSync());
        if (this.current.some((row) => row.pid === target.pid && row.birth === target.birth))
          throw error;
      }
    }
    this.observe(this.options.snapshotSync());
  }
}
