// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Codex runtime contract tested by this Omnesis release.
 *
 * Managed installations are exact so every gateway runs the artifact exercised
 * by the release tests. The previous minor remains accepted long enough for an
 * already-running gateway to drain its turns and replace that runtime in place.
 */
export const CODEX_RUNTIME_COMPAT = Object.freeze({
  packageName: "@openai/codex",
  testedVersion: "0.151.0",
  supportedVersionPrefixes: ["0.142.", "0.151."] as const,
});

export function isSupportedCodexCliVersion(version: string): boolean {
  return CODEX_RUNTIME_COMPAT.supportedVersionPrefixes.some((prefix) => version.startsWith(prefix));
}

export function isTestedCodexCliVersion(version: string): boolean {
  return version === CODEX_RUNTIME_COMPAT.testedVersion;
}
