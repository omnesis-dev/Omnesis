// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ConflictError } from "./http/errors.js";

/** Provider-declared plain-text display metadata, republished on collector boot. */
const declarations = new Map<string, Readonly<Record<string, string>>>();

function merge(
  candidate: ReadonlyMap<string, Readonly<Record<string, string>>>,
): Record<string, string> {
  const merged = new Map<string, string>();
  for (const declaration of candidate.values()) {
    for (const [sourceType, footer] of Object.entries(declaration)) {
      const existing = merged.get(sourceType);
      if (existing !== undefined && existing !== footer) {
        throw new ConflictError("conflicting source attribution declarations");
      }
      merged.set(sourceType, footer);
    }
  }
  return Object.fromEntries(merged);
}

/** Preflight before any part of the atomic declaration bundle is published. */
export function validateSourceAttributions(
  declarationKey: string,
  values: Readonly<Record<string, string>>,
): void {
  const candidate = new Map(declarations);
  candidate.set(declarationKey, values);
  merge(candidate);
}

export function setSourceAttributions(
  declarationKey: string,
  values: Readonly<Record<string, string>>,
): void {
  validateSourceAttributions(declarationKey, values);
  declarations.set(declarationKey, Object.freeze({ ...values }));
}

export function setExpectedSourceAttributionDeclarers(keys: readonly string[]): void {
  const expected = new Set(keys);
  for (const key of declarations.keys()) {
    if (key !== "admin" && !expected.has(key)) declarations.delete(key);
  }
}

export function getSourceAttributions(): Record<string, string> {
  return merge(declarations);
}

export function resetSourceAttributions(): void {
  declarations.clear();
}
