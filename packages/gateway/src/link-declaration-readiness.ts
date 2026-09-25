// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const readyKeys = new Set<string>();
let expectedKeys: ReadonlySet<string> = new Set();

export function setExpectedLinkDeclarationKeys(keys: readonly string[]): void {
  expectedKeys = new Set(keys);
  for (const key of readyKeys) {
    if (key !== "admin" && !expectedKeys.has(key)) readyKeys.delete(key);
  }
}

export function markLinkDeclarationBundleReady(key: string): void {
  readyKeys.add(key);
}

export function invalidateLinkDeclarationBundle(key: string): void {
  readyKeys.delete(key);
}

export function linkDeclarationBundlesReady(): boolean {
  // An admin may publish a bundle for diagnostics/bootstrap, but background
  // graph work needs a live collector's authoritative source descriptors.
  if (expectedKeys.size === 0) return false;
  for (const key of expectedKeys) if (!readyKeys.has(key)) return false;
  return true;
}

export function resetLinkDeclarationBundleReadiness(): void {
  readyKeys.clear();
  expectedKeys = new Set();
}
