// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/core/config` — unified `omnesisConfigSchema` (zod-validated)
 * + RFC-7396 patch helpers + per-source resolution.
 *
 * This is the **canonical** config surface — the legacy JSON loader
 * helpers it used to coexist with have been removed; the unified schema
 * subsumes them.
 *
 * Stable contract surface; consumers that bind to it can rely on
 * zod validation + change-path tracking via `applyMergePatch` /
 * `changedPathsFromPatch`.
 */

export {
  omnesisConfigSchema,
  validateConfig,
  toJsonPointer,
  applyMergePatch,
  changedPathsFromPatch,
  resolveSourceSettings,
  pickSourceSettings,
  SOURCE_SETTINGS_KEYS,
} from "../config-schema.js";

export type { OmnesisConfig, SourceSettings, ConfigValidationError } from "../config-schema.js";
