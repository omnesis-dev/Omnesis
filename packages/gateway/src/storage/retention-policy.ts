// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Rolling retention is explicit and independent from the source's import maxAge. */
export function retentionCutoff(
  policies: readonly { sourceId: string; maxAgeDays: number }[] | undefined,
  sourceId: string,
  now = Date.now(),
): string | null {
  const policy = policies?.find((item) => item.sourceId === sourceId);
  return policy ? new Date(now - policy.maxAgeDays * 86_400_000).toISOString() : null;
}

/** Destructive age policies preserve ambiguous encodings until a provider normalizes them. */
export function isCanonicalRetentionDate(value: string): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const normalized = new Date(timestamp).toISOString();
  return value === normalized || value === normalized.replace(".000Z", "Z");
}

export function isBeforeRetentionCutoff(value: string, cutoff: string): boolean {
  return isCanonicalRetentionDate(value) && Date.parse(value) < Date.parse(cutoff);
}
