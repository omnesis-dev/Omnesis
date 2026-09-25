// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * "Recently used" models for the capability model picker.
 *
 * When the operator opens "Choose a <capability> model", the picker offers a
 * flat list of models recently used for the same or a similar capability
 * above the backend grid — so reusing the agent model for the privacy
 * reviewer (or switching back to yesterday's model) is one tap instead of a
 * dig through every backend's model list.
 *
 * Similarity is a fixed grouping over capability roles: the chat roles can
 * serve each other (`agent`, `privacy-reviewer`, `background-agent`,
 * `watch-judge`, `brief-judge`), while `ocr`, `transcriber` and `embedder`
 * only ever reuse their own. The entailment verifier is deliberately
 * excluded — a special case left unhandled for now.
 *
 * This module is pure: it merges the live assignments with a small
 * per-capability history (at most two values each, most-recent-first) into
 * an ordered, deduplicated candidate list. The gateway persists the history
 * and resolves candidates into displayable entries; see
 * `packages/gateway/src/models/recent-models.ts`.
 */

import type { CapabilityRole } from "./capabilities.js";

/** At most this many candidates per capability (current + previous). */
export const MAX_RECENT_MODELS_PER_ROLE = 2;

/**
 * Capabilities whose recent models feed the picker for `reference`, in
 * display order — the reference itself first. Empty when the reference
 * shows no "Recently used" section at all.
 */
const RECENT_MODEL_REFERENCE_GROUPS: Readonly<Record<CapabilityRole, readonly CapabilityRole[]>> = {
  agent: ["agent", "privacy-reviewer", "background-agent", "watch-judge", "brief-judge"],
  "privacy-reviewer": [
    "agent",
    "privacy-reviewer",
    "background-agent",
    "watch-judge",
    "brief-judge",
  ],
  "background-agent": [
    "agent",
    "privacy-reviewer",
    "background-agent",
    "watch-judge",
    "brief-judge",
  ],
  "watch-judge": ["agent", "privacy-reviewer", "background-agent", "watch-judge", "brief-judge"],
  "brief-judge": ["agent", "privacy-reviewer", "background-agent", "watch-judge", "brief-judge"],
  ocr: ["ocr"],
  transcriber: ["transcriber"],
  embedder: ["embedder"],
  "entailment-verifier": [],
};

/** Roles consulted for `reference`, reference first. */
export function siblingRolesForRecentModels(reference: CapabilityRole): readonly CapabilityRole[] {
  return RECENT_MODEL_REFERENCE_GROUPS[reference] ?? [];
}

/** Persisted per-capability model history: role → recent assignment values. */
export type RecentModelHistory = Partial<Record<CapabilityRole, string[]>>;

/** Live assignment values by role (null = cleared, undefined = never set). */
export type RecentModelCurrent = Partial<Record<CapabilityRole, string | null>>;

export interface RecentModelCandidate {
  role: CapabilityRole;
  value: string;
}

/**
 * Ordered, deduplicated recent-model candidates for `reference`: each
 * consulted capability contributes its current assignment followed by its
 * history (at most two per role), the reference capability first, with
 * globally deduped values. Cleared/unconfigured capabilities contribute
 * nothing. Pure — resolution into displayable entries happens gateway-side.
 */
export function mergeRecentCandidates(args: {
  reference: CapabilityRole;
  current: RecentModelCurrent;
  history: RecentModelHistory;
}): RecentModelCandidate[] {
  const { reference, current, history } = args;
  const roles = siblingRolesForRecentModels(reference);
  // The group lists the reference among its siblings for the symmetric chat
  // roles; hoist it first so its own models always lead.
  const ordered = [reference, ...roles.filter((r) => r !== reference)];
  const seen = new Set<string>();
  const out: RecentModelCandidate[] = [];
  for (const role of ordered) {
    if (!roles.includes(role)) continue;
    // Dedupe before capping: a history echo of the current value must not
    // eat the slot that the genuinely previous model deserves.
    const values = [
      ...new Set(
        [current[role], ...(history[role] ?? [])].filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        ),
      ),
    ].slice(0, MAX_RECENT_MODELS_PER_ROLE);
    for (const value of values) {
      if (seen.has(value)) continue;
      seen.add(value);
      out.push({ role, value });
    }
  }
  return out;
}

/**
 * Fold one assignment change into the persisted history, returning the new
 * history object (the input is never mutated). The new value leads, the
 * replaced value follows, everything past the per-role cap is dropped.
 * Nulls are never stored — a clear just preserves what was there. A no-op
 * change returns the input unchanged.
 */
export function recordRecentHistory(
  history: RecentModelHistory,
  role: CapabilityRole,
  before: string | null | undefined,
  after: string | null | undefined,
): RecentModelHistory {
  if (before === after) return history;
  const stored = [after, before, ...(history[role] ?? [])].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const deduped = [...new Set(stored)].slice(0, MAX_RECENT_MODELS_PER_ROLE);
  if (deduped.length === 0) return history;
  // A recomputed list equal to the stored one is a semantic no-op (e.g. a
  // clear when history already leads with the replaced value) — keep the
  // input identity so file-backed stores can skip a pointless rewrite.
  const previous = history[role] ?? [];
  if (deduped.length === previous.length && deduped.every((v, i) => v === previous[i])) {
    return history;
  }
  return { ...history, [role]: deduped };
}
