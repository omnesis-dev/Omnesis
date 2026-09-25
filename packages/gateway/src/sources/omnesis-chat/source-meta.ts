// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Display identity (icon, label, colors) for the in-gateway Omnesis chat
 * source. The Omnesis agent's conversations are persisted as JSON
 * transcripts and projected into the document corpus by `upsert.ts`; this
 * module only deals with how that source surfaces in portal / iOS source
 * lists.
 *
 * This source has no `defineSource()` descriptor, no auth flow, no sync
 * engine — it's gateway-internal. The display fields live in
 * `sync_state.icon/label/bg_color/accent_color` and are seeded directly at
 * boot rather than during a sync cycle.
 *
 * The icon is the Omnesis brand PNG (`portal/img/omnesis-logo.png`)
 * loaded from disk, base64-encoded, and run through the standard
 * `normalizeIcon` pipeline so portal / iOS / iTerm CLI inline-image
 * consumers all receive the same pre-decoded raster.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { normalizeIcon } from "../../icon-normalizer.js";
import type { WriteGate } from "../../write-gate.js";

export { OMNESIS_CHAT_SOURCE_ID, OMNESIS_CHAT_PROVIDER_ID } from "./ids.js";
import { OMNESIS_CHAT_SOURCE_ID } from "./ids.js";

export const OMNESIS_CHAT_LABEL = "Omnesis";
/** Brand blue — matches the Omnesis mark's primary fill. */
export const OMNESIS_CHAT_ACCENT_COLOR = "#1F6FEB";
export const OMNESIS_CHAT_BG_COLOR = "#0D1117";

/**
 * Resolves the absolute path of the brand PNG, anchored on this file's
 * compiled location. Both `src/sources/omnesis-chat/source-meta.ts` and
 * `dist/sources/omnesis-chat/source-meta.js` sit four directories below
 * `packages/gateway/`, so the relative jump is the same either way.
 */
function brandPngPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "portal", "img", "omnesis-logo.png");
}

async function readBrandIconDataUri(): Promise<string | null> {
  try {
    const bytes = await readFile(brandPngPath());
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Idempotent boot-time seed. `setSourceMeta` COALESCEs each field, so
 * repeated calls never clobber state. Safe to invoke on every gateway
 * start.
 */
export async function seedOmnesisChatSourceMeta(writeGate: WriteGate): Promise<void> {
  const raw = await readBrandIconDataUri();
  const icon = raw ? ((await normalizeIcon(raw)) ?? undefined) : undefined;
  await writeGate.setSourceMeta(OMNESIS_CHAT_SOURCE_ID, {
    icon,
    label: OMNESIS_CHAT_LABEL,
    bgColor: OMNESIS_CHAT_BG_COLOR,
    accentColor: OMNESIS_CHAT_ACCENT_COLOR,
  });
}
