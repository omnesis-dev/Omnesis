// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis backup` — gateway-side online backup (#57).
 *
 * Wraps the gateway's `/admin/backup*` routes: POSTs to start a backup,
 * then polls `/admin/backup/status` at 2 Hz rendering per-file progress
 * (mirroring the `model install` poll loop — no WebSocket dependency).
 * `--list` prints the completed-backup table from `/admin/backups`.
 *
 * The backup runs on the gateway host and lands in
 * `<configDir>/backups/<timestamp>/` on that machine — the CLI only
 * drives and observes it.
 */

import { defineCommand } from "citty";
import {
  c,
  gatewayFetch,
  gatewayJson,
  formatSize,
  formatDateShort,
  isJSON,
  CliError,
  EXIT_FAILURE,
  pickGatewayExitCode,
} from "../utils.js";

interface BackupFileProgress {
  name: string;
  bytes: number;
  durationMs: number;
}

export type BackupPurpose = "operator" | "pre-update";

interface BackupStatusResponse {
  running: boolean;
  current?: {
    backupId: string;
    startedAt: string;
    path: string;
    includeIndex: boolean;
    note?: string;
    currentFile?: string;
    /** Bytes written so far to the in-flight file; absent from older gateways. */
    currentFileBytes?: number;
    files: BackupFileProgress[];
  };
  lastResult?: {
    backupId: string;
    ok: boolean;
    error?: string;
    startedAt: string;
    finishedAt: string;
    path: string;
    totalBytes: number;
    files: BackupFileProgress[];
  };
}

interface ListedBackup {
  path: string;
  version: string;
  startedAt: string;
  finishedAt: string;
  includeIndex: boolean;
  note?: string;
  files: Array<{ name: string; bytes: number }>;
}

const POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One `\r`-prefixed progress line. The written total counts finished files plus
 * the bytes of the file in flight, which is also shown on its own so a
 * multi-GB snapshot visibly advances. The gateway's estimate is its disk
 * preflight requirement — an upper bound, labelled as such.
 */
export function formatBackupProgress(
  current: Pick<
    NonNullable<BackupStatusResponse["current"]>,
    "currentFile" | "currentFileBytes" | "files"
  >,
  elapsedSeconds: number,
  estimatedTotalBytes?: number,
): string {
  const doneBytes = current.files.reduce((sum, f) => sum + f.bytes, 0);
  const inFlightBytes = current.currentFile ? current.currentFileBytes : undefined;
  const writtenBytes = doneBytes + (inFlightBytes ?? 0);
  const estimate =
    estimatedTotalBytes === undefined ? "" : ` · at most ~${formatSize(estimatedTotalBytes)}`;
  const working = current.currentFile
    ? `backing up ${current.currentFile}${inFlightBytes === undefined ? "" : ` (${formatSize(inFlightBytes)} so far)`}…`
    : "finishing…";
  return `\r  ${current.files.length} file${current.files.length === 1 ? "" : "s"} done · ${formatSize(writtenBytes)} written${estimate} · ${working} [${elapsedSeconds}s]`;
}

export async function runBackup(opts: {
  includeIndex: boolean;
  note?: string;
  purpose?: BackupPurpose;
}): Promise<void> {
  const body: { includeIndex?: boolean; note?: string; purpose?: BackupPurpose } = {};
  if (!opts.includeIndex) body.includeIndex = false;
  if (opts.note) body.note = opts.note;
  if (opts.purpose) body.purpose = opts.purpose;

  const res = await gatewayFetch("/admin/backup", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    throw new CliError(
      `${c.red}A backup is already running — check 'omnesis backup --list' once it finishes.${c.reset}`,
      EXIT_FAILURE,
    );
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new CliError(
      `${c.red}Backup rejected: ${res.status} ${txt}${c.reset}`,
      pickGatewayExitCode(res.status),
    );
  }
  const { backupId, estimatedTotalBytes } = (await res.json()) as {
    backupId: string;
    /** Absent when the CLI is talking to a gateway from before this field existed. */
    estimatedTotalBytes?: number;
  };

  if (!isJSON) {
    console.log(
      `${c.dim}Backup started${opts.includeIndex ? "" : " (index.db skipped)"}…${c.reset}`,
    );
  }

  const startMs = Date.now();
  let lastLine = "";
  // Poll until the gateway reports our backup as no longer current.
  for (;;) {
    const status = await gatewayJson<BackupStatusResponse>("/admin/backup/status");
    const current = status.current;
    if (current && current.backupId === backupId) {
      if (!isJSON) {
        const elapsed = Math.floor((Date.now() - startMs) / 1000);
        const line = formatBackupProgress(current, elapsed, estimatedTotalBytes);
        if (line !== lastLine) {
          process.stdout.write(line.padEnd(Math.max(line.length, lastLine.length)));
          lastLine = line;
        }
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const last = status.lastResult;
    if (!last || last.backupId !== backupId) {
      throw new CliError(
        `${c.red}✖${c.reset} Backup disappeared from the gateway's status — check gateway logs.`,
        EXIT_FAILURE,
      );
    }
    if (!last.ok) {
      if (isJSON) {
        console.log(JSON.stringify(last));
        throw new CliError("", EXIT_FAILURE);
      }
      throw new CliError(
        `\n${c.red}✖${c.reset} Backup failed: ${last.error ?? "unknown error"}`,
        EXIT_FAILURE,
      );
    }
    if (isJSON) {
      console.log(JSON.stringify(last));
    } else {
      if (lastLine) process.stdout.write("\n");
      console.log(
        `${c.green}✔${c.reset} Backup complete: ${last.files.length} files, ${formatSize(last.totalBytes)}`,
      );
      for (const f of last.files) {
        console.log(`    ${f.name.padEnd(28)} ${formatSize(f.bytes).padStart(10)}`);
      }
      console.log(`  ${c.dim}Saved on the gateway host at${c.reset} ${last.path}`);
    }
    return;
  }
}

async function runList(): Promise<void> {
  const { backups } = await gatewayJson<{ backups: ListedBackup[] }>("/admin/backups");
  if (isJSON) {
    console.log(JSON.stringify({ backups }));
    return;
  }
  if (backups.length === 0) {
    console.log("No backups yet. Run 'omnesis backup' to create one.");
    return;
  }
  console.log();
  console.log(
    `${c.bold}${"STARTED".padEnd(18)} ${"SIZE".padEnd(10)} ${"FILES".padEnd(6)} ${"INDEX".padEnd(6)} PATH${c.reset}`,
  );
  for (const b of backups) {
    const size = formatSize(b.files.reduce((sum, f) => sum + f.bytes, 0));
    console.log(
      `${formatDateShort(b.startedAt).padEnd(18)} ${size.padEnd(10)} ${String(b.files.length).padEnd(6)} ${(b.includeIndex ? "yes" : "no").padEnd(6)} ${b.path}` +
        (b.note ? `  ${c.dim}— ${b.note}${c.reset}` : ""),
    );
  }
  console.log();
}

export const backupCommand = defineCommand({
  meta: {
    name: "backup",
    description: "Create an online backup of the gateway's databases and config",
  },
  args: {
    list: {
      type: "boolean",
      description: "List completed backups instead of creating one",
    },
    index: {
      type: "boolean",
      description: "Include index.db (pass --no-index to skip; it rebuilds from omnesis.db)",
      default: true,
    },
    note: {
      type: "string",
      description: "Free-form note stored in the backup manifest",
    },
    json: {
      type: "boolean",
      description: "Machine-readable output",
    },
  },
  async run(ctx) {
    if (ctx.args.list) {
      await runList();
      return;
    }
    const note = typeof ctx.args.note === "string" && ctx.args.note ? ctx.args.note : undefined;
    await runBackup({ includeIndex: ctx.args.index !== false, note });
  },
});
