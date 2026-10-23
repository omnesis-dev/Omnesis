// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Root certificates Mozilla has removed from NSS that a Node.js release the
 * `engines` range still admits bundles (Node 24.22.1 and 26.12.1 dropped the
 * emSign ones). Node checks no revocation and reads no OneCRL, so a
 * root Mozilla distrusts stays trusted by every Omnesis process until it runs
 * on a Node with a newer store — this module closes that gap.
 *
 * Importing it removes the roots from the current thread's default CA store.
 * The store is per thread, so the `@omnesis/core` barrel imports this module
 * first: every process and worker thread that loads the barrel drops them
 * before it opens a socket. Code that passes its own `ca:` list bypasses the
 * default store and must take `publicRoots()` instead of the bundled set.
 *
 * Remove an entry once the `engines` floor excludes every release that
 * bundles it.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { pathToFileURL } from "node:url";

/** SHA-256 of each distrusted root's DER encoding, lowercase hex. */
export const DISTRUSTED_ROOT_SHA256: ReadonlySet<string> = new Set([
  // NSS 3.131.1: eMudhra issuing-CA keys were recoverable from their certificates.
  "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b", // emSign ECC Root CA - G3
  "125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f", // emSign Root CA - C1
  "bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3", // emSign ECC Root CA - C3
]);

const PEM_ARMOR = /-----(?:BEGIN|END) CERTIFICATE-----|\s/gu;

export function isDistrustedRoot(pem: string): boolean {
  const der = Buffer.from(pem.replace(PEM_ARMOR, ""), "base64");
  return DISTRUSTED_ROOT_SHA256.has(createHash("sha256").update(der).digest("hex"));
}

/** Node's bundled public roots without the distrusted ones. */
export function publicRoots(): string[] {
  return getCACertificates("bundled").filter((pem) => !isDistrustedRoot(pem));
}

/** Drop the distrusted roots from this thread's default CA store. Idempotent. */
export function distrustCompromisedRoots(): void {
  const current = getCACertificates("default");
  const kept = current.filter((pem) => !isDistrustedRoot(pem));
  if (kept.length !== current.length) setDefaultCACertificates(kept);
}

/**
 * A child Node process — npm above all — builds its own CA store from the
 * same bundled set. This preload drops the same roots there. It filters the
 * default store only, so a `ca`/`cafile` the user configured for npm still
 * wins, and it is a no-op on a Node without `setDefaultCACertificates`.
 */
const PRELOAD_SOURCE = `import { createHash } from "node:crypto";
import tls from "node:tls";
const distrusted = new Set(${JSON.stringify([...DISTRUSTED_ROOT_SHA256])});
const keep = (pem) => !distrusted.has(createHash("sha256").update(Buffer.from(pem.replace(/-----(?:BEGIN|END) CERTIFICATE-----|\\s/gu, ""), "base64")).digest("hex"));
if (typeof tls.setDefaultCACertificates === "function") {
  const current = tls.getCACertificates("default");
  if (!current.every(keep)) tls.setDefaultCACertificates(current.filter(keep));
}
`;

let preloadUrl: string | undefined;

/**
 * `NODE_OPTIONS` for a child Node process that should not trust the
 * distrusted roots: `current` with the preload appended. The preload is
 * written once per process into a private temporary directory, so no other
 * user can swap what the child imports.
 */
export function distrustingNodeOptions(
  current: string | undefined = process.env.NODE_OPTIONS,
): string {
  if (preloadUrl === undefined) {
    const file = join(mkdtempSync(join(tmpdir(), "omnesis-tls-")), "distrust-roots.mjs");
    writeFileSync(file, PRELOAD_SOURCE, { mode: 0o600 });
    preloadUrl = pathToFileURL(file).href;
  }
  const flag = `--import=${preloadUrl}`;
  return current?.trim() ? `${current} ${flag}` : flag;
}

distrustCompromisedRoots();
