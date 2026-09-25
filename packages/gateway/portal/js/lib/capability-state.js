// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure derivation of a capability's card/detail state from its resolved
 * assignment. Kept here (not inline in the view) so the three-way mapping —
 * enabled (green tick) / needs-attention / not-configured — is unit-testable
 * without a DOM and shared verbatim by the landing grid card and the detail
 * page (one source of truth, no drift between the two surfaces).
 */

/** A capability is "enabled" when something resolved and is available. */
export function isEnabled(assignment) {
  if (!assignment) return false;
  if (assignment.kind === "disabled" || assignment.kind === "unresolved") return false;
  if (assignment.kind === "replay") return true;
  return assignment.available === true;
}

/** True when a model is assigned at all — even if it's not currently available. */
export function isConfigured(assignment) {
  return !!assignment && assignment.kind !== "disabled" && assignment.kind !== "unresolved";
}

/**
 * Three-way card state:
 *   "on"   — enabled and available (green tick),
 *   "warn" — configured but unavailable (e.g. a local model not downloaded,
 *            or an HTTP backend unreachable) → needs attention,
 *   "off"  — nothing configured.
 */
export function capabilityCardState(assignment) {
  if (isEnabled(assignment)) return "on";
  if (isConfigured(assignment)) return "warn";
  return "off";
}
