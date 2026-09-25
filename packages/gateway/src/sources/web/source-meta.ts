// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Display identity (icon, label, colors) for the gateway-hosted Web Pages
 * source. `web` is hosted by the gateway — its documents arrive via the
 * browser extension's HTTP push and no collector ever syncs it — so the usual
 * collector-driven `sync.status` that seeds
 * `sync_state.icon/label/colors` never fires for it. Without a gateway-side
 * seed, `/portal/source-meta.json` returns an empty icon and native clients
 * (iOS / Android), which render source icons from that endpoint, fall back to a
 * placeholder glyph.
 *
 * Mirrors the `omnesis-chat` gateway-internal source: read the descriptor's
 * declared icon, run it through the shared `normalizeIcon` pipeline (which
 * rasterizes the SVG glyph to PNG — iOS `UIImage` can't decode SVG bytes), and
 * seed it idempotently at boot.
 */

import webDefinition from "@omnesis/provider-web";
import { normalizeIcon } from "../../icon-normalizer.js";
import { WEB_SOURCE_ID } from "../../web-dataset.js";
import type { WriteGate } from "../../write-gate.js";

/**
 * Idempotent boot-time seed of `web`'s display identity. `setSourceMeta`
 * COALESCEs each field, so repeated calls never clobber state.
 */
export async function seedWebSourceMeta(writeGate: WriteGate): Promise<void> {
  const declared = webDefinition.icon;
  const icon = declared?.imageDataUri
    ? ((await normalizeIcon(declared.imageDataUri)) ?? undefined)
    : undefined;
  await writeGate.setSourceMeta(WEB_SOURCE_ID, {
    icon,
    label: webDefinition.name,
    bgColor: declared?.bgColor,
    accentColor: declared?.color,
  });
}
