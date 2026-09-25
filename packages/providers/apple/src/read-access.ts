// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { fullDiskAccessRemediation } from "@omnesis/core";
import {
  listReadAccessDirectory,
  probeFileReadAccess,
  type SourceReadAccessResult,
} from "@omnesis/source-sdk";
import { contactsDbFile } from "./paths.js";

export function appleFileReadAccess(path: string, fullDiskAccess = true) {
  return ({ signal }: { signal: AbortSignal }): Promise<SourceReadAccessResult> =>
    probeFileReadAccess(path, {
      signal,
      ...(fullDiskAccess
        ? { remediation: fullDiskAccessRemediation("<collector-executable>") }
        : {}),
    });
}

/** Discover the current stores without consulting cached handles or querying data. */
export async function probeAppleStoresReadAccess(
  directory: string,
  kind: "contacts" | "reminders",
  signal: AbortSignal,
): Promise<SourceReadAccessResult> {
  const options = { signal, remediation: fullDiskAccessRemediation("<collector-executable>") };
  const root = await listReadAccessDirectory(directory, options);
  if (root.status !== "readable") return root;
  let files: string[];
  if (kind === "reminders") {
    files = root.entries
      .filter((entry) => entry.name.startsWith("Data-") && entry.name.endsWith(".sqlite"))
      .map((entry) => join(directory, entry.name));
  } else if (root.entries.some((entry) => entry.name === "Sources")) {
    const sources = join(directory, "Sources");
    const stores = await listReadAccessDirectory(sources, options);
    if (stores.status !== "readable") return stores;
    files = stores.entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => contactsDbFile(join(sources, entry.name)));
    // Match the sync reader's single-store fallback when Sources is empty.
    if (files.length === 0) files = [contactsDbFile(directory)];
  } else {
    files = [contactsDbFile(directory)];
  }
  if (files.length === 0) return { status: "unavailable" };
  let result: SourceReadAccessResult = { status: "readable" };
  for (const file of files) {
    const next = await probeFileReadAccess(file, options);
    if (next.status === "denied") return next;
    if (next.status !== "readable") result = next;
    if (signal.aborted) return { status: "unavailable" };
  }
  return result;
}
