// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Invented boundary errors never leave an actual process or provider task unjoined. */
export function cleanupMarker(nested: boolean): unknown {
  const marker = { cleanupFailure: undefined };
  return nested ? new Error("Invented nested probe refusal", { cause: marker }) : marker;
}
export interface ProbeOwner {
  cleanupFailure?: () => unknown;
  close?: () => Promise<void>;
}
export async function closeFixture(owner: ProbeOwner, expected?: unknown): Promise<void> {
  try {
    await owner.close?.();
  } catch (error) {
    if (error !== expected) throw error;
  }
}
