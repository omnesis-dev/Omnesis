// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** The plugin id the Omnesis integration installs under in OpenClaw. */
const OPENCLAW_INTEGRATION_PLUGIN_ID = "omnesis-integration";

/** How long the inspection may take; it reads local state and normally answers in seconds. */
const INSPECT_TIMEOUT_MS = 60_000;

/**
 * Whether OpenClaw's install record for the integration names this archive.
 *
 * With its gateway running, `openclaw plugins install` saves the plugin and
 * then asks the running gateway to swap it in. The swap waits for the old
 * plugin's work and stops it within deadlines of its own; when they run out
 * the command exits non-zero although the installation is saved, and the
 * harness loads the saved plugin when it next starts. That outcome is told
 * apart from an install that saved nothing by the record itself: the
 * integrity and SHA-1 OpenClaw records for an archive install are those of
 * the archive's bytes, so a record naming this archive's digests means its
 * contents are what the harness will load.
 *
 * Read with `openclaw plugins inspect --json`, which reads the install
 * record without loading the plugin. Anything unreadable is not evidence of
 * an install.
 */
export function openClawRecordsArchive(
  archivePath: string,
  environment: NodeJS.ProcessEnv,
  run: typeof spawnSync = spawnSync,
): boolean {
  const result = run("openclaw", ["plugins", "inspect", OPENCLAW_INTEGRATION_PLUGIN_ID, "--json"], {
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: INSPECT_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return false;
  const install = recordedInstall(String(result.stdout ?? ""));
  if (!install) return false;
  let bytes: Buffer;
  try {
    bytes = readFileSync(archivePath);
  } catch {
    return false;
  }
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const shasum = createHash("sha1").update(bytes).digest("hex");
  return install.integrity === integrity || install.shasum === shasum;
}

/** The `install` object of an inspection report, past any banner OpenClaw prints first. */
function recordedInstall(stdout: string): { integrity?: unknown; shasum?: unknown } | null {
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
  return install !== null && typeof install === "object" ? install : null;
}
