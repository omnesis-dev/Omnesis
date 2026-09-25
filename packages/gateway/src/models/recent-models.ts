// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * "Recently used" models for one reference capability — the domain service
 * behind `GET /admin/models/recent/:capability`.
 *
 * Merges the live assignments with the persisted per-capability history
 * (core `mergeRecentCandidates`: reference capability first, siblings next,
 * at most two values each, globally deduplicated), resolves every candidate
 * through the inference registry, and projects the usable ones into picker
 * entries. Candidates that no longer resolve (a removed backend, an unknown
 * catalog id) are dropped — the picker must never offer a "Use" button that
 * cannot work. The model already assigned to the reference capability is
 * likewise excluded: re-selecting it would be a no-op.
 *
 * Each entry carries everything a client needs to render the row and apply
 * it with the endpoints it already uses:
 *   - `assign`  → `PATCH /admin/config` with the raw assignment value
 *                 (`"<backend>/<model>"`, a native OCR runtime, …).
 *   - `activate` → `POST /admin/models/activate` with the catalog id, its
 *                 catalog role, and the reference capability. Only emitted
 *                 when the reference role has a catalog mapping; anything
 *                 else falls back to `assign`.
 */

import {
  assertNever,
  mergeRecentCandidates,
  resolveModelDisplay,
  type AssignmentValue,
  type CapabilityRole,
  type ModelRole,
  type RecentModelCurrent,
  type RecentModelHistory,
  type ResolvedAssignment,
} from "@omnesis/core";

/**
 * Reference capability → catalog role for the activate path. Mirrors the
 * capability half of `CAPABILITY_TO_CATALOG` in `routes.ts` (the activate
 * endpoint rejects capabilities outside it). Roles without a mapping here
 * (OCR's native runtimes, …) are served through the assign path instead.
 * The entailment verifier needs no entry: its sibling group is empty, so it
 * never produces candidates.
 */
const REFERENCE_TO_CATALOG_ROLE: Partial<Record<CapabilityRole, ModelRole>> = {
  embedder: "embed",
  agent: "agent",
  "privacy-reviewer": "agent",
  transcriber: "transcribe",
  "background-agent": "agent",
  "watch-judge": "agent",
  "brief-judge": "agent",
};

export type RecentModelApply =
  | { type: "assign"; value: string }
  | { type: "activate"; catalogId: string; catalogRole: ModelRole };

export interface RecentModelEntry {
  /** Raw assignment value (`"<backend>/<model>"`, `"local/<id>"`, …). */
  assignment: string;
  /** Provider brand id for the row's logo. */
  providerId: string;
  /** Human-readable provider label. */
  providerLabel: string;
  /** Friendly model name (catalog name, else the raw model id). */
  modelName: string;
  /** How the client applies this entry. */
  apply: RecentModelApply;
}

export interface RecentModelsResult {
  capability: CapabilityRole;
  entries: RecentModelEntry[];
}

/**
 * Compute the "Recently used" entries for `reference`.
 *
 * `current` is the live `inference.assignments` map, `history` the persisted
 * per-capability memory, `resolveValue` the registry's explicit-value
 * resolver. Pure apart from resolution — no I/O.
 */
export { REFERENCE_TO_CATALOG_ROLE };

export function computeRecentModels(args: {
  reference: CapabilityRole;
  current: RecentModelCurrent;
  history: RecentModelHistory;
  resolveValue: (role: CapabilityRole, value: AssignmentValue | undefined) => ResolvedAssignment;
}): RecentModelsResult {
  const { reference, current, history, resolveValue } = args;
  const candidates = mergeRecentCandidates({ reference, current, history });
  const catalogRole = REFERENCE_TO_CATALOG_ROLE[reference];
  const active = current[reference];
  const entries: RecentModelEntry[] = [];
  for (const { value } of candidates) {
    if (value === active) continue;
    const resolved = resolveValue(reference, value);
    if (resolved.kind === "disabled" || resolved.kind === "unresolved") continue;
    const display = resolveModelDisplay(resolved);
    const apply = toApply(value, resolved, catalogRole);
    if (!apply) continue;
    entries.push({
      assignment: value,
      providerId: display.providerId,
      providerLabel: display.providerLabel,
      modelName: display.modelName,
      apply,
    });
  }
  return { capability: reference, entries };
}

function toApply(
  value: string,
  resolved: ResolvedAssignment,
  catalogRole: ModelRole | undefined,
): RecentModelApply | null {
  switch (resolved.kind) {
    case "local":
    case "anthropic": {
      // The activate endpoint validates catalog membership, role fit, and
      // availability (installed file / API key), so only offer it when the
      // entry is known, serves this capability, and is usable now — anything
      // else would be a "Use" button that 400s. A role-mismatched entry (a
      // transcribe model remembered for the agent — only possible across a
      // catalog change) or a currently-unavailable one is skipped; roles
      // without a catalog mapping fall back to a raw assignment, which the
      // config path resolves best-effort.
      if (catalogRole === undefined) return { type: "assign", value };
      if (!resolved.catalogEntry?.roles.includes(catalogRole)) return null;
      if (!resolved.available) return null;
      return { type: "activate", catalogId: resolved.catalogId, catalogRole };
    }
    case "http":
    case "codex":
    case "replay":
      return { type: "assign", value };
    case "disabled":
    case "unresolved":
      // Filtered by the caller before display; total here so a new union
      // member is a compile error rather than a silent default.
      return null;
    default:
      return assertNever(resolved);
  }
}
