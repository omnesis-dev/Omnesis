// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** The plugin id the Omnesis integration installs under in OpenClaw. */
const OPENCLAW_INTEGRATION_PLUGIN_ID = "omnesis-integration";

/** How long the inspection may take; it reads local state and normally answers in seconds. */
const INSPECT_TIMEOUT_MS = 60_000;

/** Room for the inspection report, which lists every tool and contract the plugin declares. */
const INSPECT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * OpenClaw's install record for the integration plugin: the `install` object
 * of `openclaw plugins inspect --json`. For an archive install, `integrity`
 * is the SRI sha512 and `shasum` the SHA-1 hex of the archive's bytes, and
 * `installedAt` is the ISO time of the install that wrote it.
 */
export type OpenClawInstallRecord = Readonly<Record<string, unknown>>;

/**
 * Read the integration's install record, or null when there is none or it
 * cannot be read. `plugins inspect` reads the record without loading the
 * plugin.
 */
export function readOpenClawInstallRecord(
  environment: NodeJS.ProcessEnv,
  run: typeof spawnSync = spawnSync,
): OpenClawInstallRecord | null {
  const result = run("openclaw", ["plugins", "inspect", OPENCLAW_INTEGRATION_PLUGIN_ID, "--json"], {
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: INSPECT_TIMEOUT_MS,
    maxBuffer: INSPECT_MAX_BUFFER_BYTES,
  });
  if (result.error || result.status !== 0) return null;
  return recordedInstall(String(result.stdout ?? ""));
}

/**
 * How much earlier than the install's start its record may say it was
 * written, for a timestamp kept at a coarser precision than this clock's.
 */
const INSTALLED_AT_TOLERANCE_MS = 1_000;

/**
 * Whether an install that exited non-zero saved this archive anyway.
 *
 * With its gateway running, `openclaw plugins install` saves the plugin and
 * then asks the running gateway to swap it in. The swap waits for the old
 * plugin's work and stops it within deadlines of its own; when they run out
 * the command exits non-zero although the installation is saved, and the
 * harness loads the saved plugin when it next starts. That outcome is told
 * apart from an install that saved nothing by the record: it names this
 * archive's digests, and it was written after `installStartedAt`. The same
 * build packs a byte-identical archive, so without the second test an
 * earlier install of it would pass for this one.
 */
export function openClawSavedArchive(
  record: OpenClawInstallRecord | null,
  archivePath: string,
  installStartedAt: number,
): boolean {
  if (record === null || typeof record.installedAt !== "string") return false;
  const installedAt = Date.parse(record.installedAt);
  if (!Number.isFinite(installedAt) || installedAt < installStartedAt - INSTALLED_AT_TOLERANCE_MS) {
    return false;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(archivePath);
  } catch {
    return false;
  }
  if (typeof record.integrity === "string") {
    return record.integrity === `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  }
  return record.shasum === createHash("sha1").update(bytes).digest("hex");
}

/** The `install` object of an inspection report, past any banner OpenClaw prints first. */
function recordedInstall(stdout: string): OpenClawInstallRecord | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let report: unknown;
  try {
    report = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (report === null || typeof report !== "object") return null;
  const install = (report as { install?: unknown }).install;
  return install !== null && typeof install === "object" && !Array.isArray(install)
    ? (install as OpenClawInstallRecord)
    : null;
}
