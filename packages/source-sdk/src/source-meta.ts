// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Canonical shape of the per-source metadata blob the gateway ships
 * to the portal + CLI for icon/label rendering. One source of truth
 * so the gateway's HTTP response, the CLI's cache, and any future
 * iOS Codable mirror don't drift on the value shape.
 *
 * The map is keyed by both full sourceId (e.g. `gmail:user@gmail.com`)
 * and bare sourceType (e.g. `gmail`). Per-source-type entries are the
 * fallback for sources whose icon doesn't differ across accounts; the
 * full-id entry wins when both are present. See
 * `gateway/src/data/repositories/SyncStateRepository.ts:getSourceMeta`
 * for the producer logic.
 *
 * Values are pre-rasterised PNG `data:image/png;base64,…` URIs as of
 * the icon-normalizer rollout — the consumer (CLI, portal `<img>`,
 * iOS UIImage) can decode whatever shape the data URI declares
 * without needing an SVG renderer.
 *
 * Pre-fix the entry type was duplicated in three places:
 *   - `cli-shared/src/terminal-fx.ts` (loose union with string +
 *     undefined branches that the producer doesn't actually emit).
 *   - `gateway/src/data/repositories/SyncStateRepository.ts` (strict
 *     object form, what the gateway actually emits).
 *   - inline `Record<string, { icon?: string; label?: string }>` at
 *     several other call sites.
 *
 * Now both TS sites import from here. iOS keeps its Codable mirror
 * by hand (no shared codegen yet) but the TS contract is one type.
 */

export interface SourceMetaEntry {
  /** Icon as a `data:image/png;base64,…` URI. */
  icon?: string;
  /** Human-readable display label. */
  label?: string;
  /** Brand accent color hex (mirrors `SourceIcon.color`). */
  accentColor?: string;
  /** Brand dark-mode background tint hex (mirrors `SourceIcon.bgColor`). */
  bgColor?: string;
}

export type SourceMeta = Record<string, SourceMetaEntry>;
