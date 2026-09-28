// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The health check's read-access probe for a Maildir.
 *
 * The shared tree probe examines every entry it lists and gives up past a few
 * hundred, and a single mailbox's `cur` directory routinely holds tens of
 * thousands of files. This probe instead samples: it confirms the root lists,
 * finds a few mailboxes, and opens one message file in each. It reads no
 * message content and never writes.
 */

import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { SourceReadAccessResult } from "@omnesis/source-sdk";

/** Directory entries read from any one directory. */
const MAX_ENTRIES = 512;
/** Mailboxes sampled. */
const MAX_MAILBOXES = 3;

type Outcome = SourceReadAccessResult | "missing";

function failure(err: unknown): SourceReadAccessResult | "missing" {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EACCES" || code === "EPERM") return { status: "denied" };
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  return { status: "unavailable" };
}

/** Up to `limit` entries of a directory, stopping early rather than failing. */
async function sampleDir(
  path: string,
  limit: number,
  signal: AbortSignal,
): Promise<{ names: Array<{ name: string; isDir: boolean; isFile: boolean }> } | Outcome> {
  try {
    const dir = await opendir(path);
    try {
      const names: Array<{ name: string; isDir: boolean; isFile: boolean }> = [];
      while (names.length < limit && !signal.aborted) {
        const entry = await dir.read();
        if (!entry) break;
        names.push({ name: entry.name, isDir: entry.isDirectory(), isFile: entry.isFile() });
      }
      return { names };
    } finally {
      await dir.close();
    }
  } catch (err) {
    return failure(err);
  }
}

async function openOne(path: string): Promise<Outcome> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    await handle.close();
    return { status: "readable" };
  } catch (err) {
    return failure(err);
  }
}

/** Whether `dir` is a mailbox whose listing and first message open. */
async function probeMailbox(dir: string, signal: AbortSignal): Promise<Outcome> {
  let sawMailbox = false;
  for (const sub of ["cur", "new"]) {
    const listing = await sampleDir(join(dir, sub), 64, signal);
    if (listing === "missing") return "missing";
    if ("status" in listing) return listing;
    sawMailbox = true;
    const file = listing.names.find((entry) => entry.isFile && !entry.name.startsWith("."));
    if (file) return openOne(join(dir, sub, file.name));
  }
  return sawMailbox ? { status: "readable" } : "missing";
}

export async function probeMaildirReadAccess(
  root: string,
  signal: AbortSignal,
): Promise<SourceReadAccessResult> {
  const top = await sampleDir(root, MAX_ENTRIES, signal);
  if (top === "missing") return { status: "unavailable" };
  if ("status" in top) return top;

  const candidates = [root, ...top.names.filter((e) => e.isDir).map((e) => join(root, e.name))];
  let found = 0;
  for (const candidate of candidates) {
    if (signal.aborted) return { status: "unavailable" };
    const outcome = await probeMailbox(candidate, signal);
    if (outcome === "missing") continue;
    if (outcome.status !== "readable") return outcome;
    found += 1;
    if (found >= MAX_MAILBOXES) break;
  }
  // A root with no mailbox directly in it or one level down still syncs when
  // its mailboxes are nested deeper; the probe cannot vouch for it either way.
  return found > 0 ? { status: "readable" } : { status: "unavailable" };
}
