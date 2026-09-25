// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/config` — unified `omnesisConfigSchema` (zod-validated)
 * + RFC-7396 patch helpers + per-source resolution.
 *
 * This is the **canonical** config surface — the legacy JSON loader
 * helpers it used to coexist with have been removed; the unified schema
 * subsumes them.
 *
 * Stable contract surface; consumers that bind to it can rely on
 * zod validation + change-path tracking via `applyMergePatch` /
 * `changedPathsFromPatch`.
 *
 * `@omnesis/core` re-exports the same symbols for back-compat.
 */

export * from "./config-schema.js";
export * from "./config-diff.js";
export * from "./config-describe.js";
export * from "./config-defaults.js";
export * from "./load-dotenv.js";
