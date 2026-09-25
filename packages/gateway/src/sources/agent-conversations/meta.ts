// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Identity for the pushed agent-conversation sources. A harness plugin pushes
 * to `POST /agent-messages`; the projected documents use `providerId = <harness>`
 * and `sourceId = <harness>:local` — deliberately the same triple the
 * collector-hosted reader sources use, so the plugin transport and the reader
 * transport are interchangeable in the corpus.
 *
 * The push path has no collector-loaded descriptor to supply a display
 * icon/label, so the gateway seeds `sync_state` directly — but lazily, only once
 * a harness actually has data (see `seedHarnessSourceMeta`), so a gateway with
 * no plugin pushing shows no phantom source.
 */

import type { WriteGate } from "../../write-gate.js";

/** Harnesses whose plugins may push. */
export const KNOWN_HARNESSES = ["openclaw", "hermes"] as const;
export type Harness = (typeof KNOWN_HARNESSES)[number];

const DISPLAY: Record<string, { name: string; accent: string; bg: string }> = {
  openclaw: { name: "OpenClaw", accent: "#F97316", bg: "#2A1B10" },
  hermes: { name: "Hermes", accent: "#8B5CF6", bg: "#1E1B2E" },
};

export function isKnownHarness(h: string): h is Harness {
  return (KNOWN_HARNESSES as readonly string[]).includes(h);
}

/** Display name of the agent, e.g. `OpenClaw`; capitalizes an unknown id. */
export function harnessDisplayName(harness: string): string {
  return DISPLAY[harness]?.name ?? harness.charAt(0).toUpperCase() + harness.slice(1);
}

export function providerIdFor(harness: string): string {
  return harness;
}

export function sourceIdFor(harness: string): string {
  return `${harness}:local`;
}

/**
 * Seed one pushed source's display identity (label + brand colors). Called
 * lazily the first time a harness has ledger data — a fresh push, or an existing
 * bucket found during boot reconciliation — so a harness that never pushed leaves
 * no phantom source behind. `setSourceMeta` COALESCEs, so repeat calls never
 * clobber. No icon — the push path owns no asset bundle; label + brand colors are
 * enough for the source to surface in the portal/CLI source lists.
 */
export async function seedHarnessSourceMeta(writeGate: WriteGate, harness: string): Promise<void> {
  const d = DISPLAY[harness] ?? {
    name: harnessDisplayName(harness),
    accent: "#6B7280",
    bg: "#1F2937",
  };
  const display = { label: d.name, accentColor: d.accent, bgColor: d.bg };
  // The id is account-qualified (`<harness>:local`), so a client that looks a
  // source up by type finds nothing unless the family is declared too. There
  // is exactly one account per harness, so the family is that account's
  // identity — declared rather than copied from it by whoever reads the table.
  await writeGate.setSourceMeta(sourceIdFor(harness), { ...display, family: display });
}
