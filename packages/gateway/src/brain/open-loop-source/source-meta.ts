// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Identity of the gateway-internal "open loops" system source — the
 * omnesis-chat pattern: no `defineSource()` descriptor, no auth flow, no
 * sync engine. Open loops are mirrored into the document corpus under
 * this identity (`provider "system"`, type `open-loop`) so they get the
 * search INDEX for free — but never user-facing visibility:
 *
 * The source is registered as a cognition-authored source (`cognition-authored.ts`),
 * which makes it hidden from general search — ordinary search and document
 * listings exclude its documents at the candidate choke points, and only a
 * query that explicitly names this source or its document type (the
 * `open_loop_search` agent tool does) reaches them — and invisible to the
 * reactive plane, which never treats one of its documents as a corpus event.
 * Read surfaces never use this mirror — dedicated `/loops` routes read the
 * loop tables directly, and briefs carry everything the agent pushes.
 *
 * Display identity is boot-seeded into `sync_state` like omnesis-chat's;
 * the boot wiring that calls the seeder is gated on the feature being
 * active (experimental + background-agent model assigned).
 */

import type { WriteGate } from "../../write-gate.js";

export const OPEN_LOOP_SOURCE_ID = "open-loops";
export const OPEN_LOOP_PROVIDER_ID = "system";
export const OPEN_LOOP_DOCUMENT_TYPE = "open-loop";

export const OPEN_LOOP_SOURCE_LABEL = "Omnesis Cognition Steward";
/** Brand blue — matches the omnesis-chat system source. */
const OPEN_LOOP_SOURCE_ACCENT_COLOR = "#1F6FEB";
const OPEN_LOOP_SOURCE_BG_COLOR = "#0D1117";

/**
 * Idempotent boot-time seed of the display identity. `setSourceMeta`
 * COALESCEs each field, so repeated calls never clobber state.
 */
export async function seedOpenLoopSourceMeta(writeGate: WriteGate): Promise<void> {
  await writeGate.setSourceMeta(OPEN_LOOP_SOURCE_ID, {
    label: OPEN_LOOP_SOURCE_LABEL,
    bgColor: OPEN_LOOP_SOURCE_BG_COLOR,
    accentColor: OPEN_LOOP_SOURCE_ACCENT_COLOR,
  });
}
