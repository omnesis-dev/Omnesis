// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure helpers for the Decision model's setup: the backends its picker
 * offers, the model suggestions, and the verify and calibration sentences.
 * A backend serves decisions through its `decision` block (see
 * `backend-setup.js`); TypeSafe is built in and never a backend.
 */

import { allProviders, backendPreset } from "./backend-setup.js";

/** The configured HTTP backends, sorted by key. */
function httpBackends(overview) {
  return Object.entries(overview?.inference?.backends ?? {})
    .filter(([, backend]) => backend?.type === "http")
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The Decision model picker's backends: `ready` serve decisions already;
 * `enable` are backends whose preset offers decisions they do not use yet,
 * so choosing one adds the preset's decision API with the backend's own key.
 */
export function decisionPickerGroups(overview) {
  const ready = [];
  const enable = [];
  for (const [key, backend] of httpBackends(overview)) {
    const preset = backendPreset(overview, backend);
    if (backend.decision) ready.push({ key, backend, preset });
    else if (backend.url && preset?.decision && !preset.builtIn && key !== "typesafe") enable.push({ key, backend, preset });
  }
  return { ready, enable };
}

/**
 * The presets the Decision model's "Add a provider" offers: those with
 * decisions that no backend was made from yet. A backend made from one is
 * offered above it, with its own key.
 */
export function newDecisionPresets(overview) {
  const used = new Set(Object.values(overview?.inference?.backends ?? {}).map((backend) => backend?.preset).filter(Boolean));
  return allProviders(overview).filter((preset) => preset.decision && !preset.builtIn && !used.has(preset.id));
}

/** The Decision model's current assignment as `<backend>/<model>`, when it is on a backend's decision API. */
export function currentDecisionAssignment(overview) {
  const assigned = assignedDecisionBackend(overview);
  return assigned ? `${assigned.key}/${assigned.model}` : null;
}

/**
 * The Decision model's assignment when it is on a backend's decision API:
 * `{ key, model, backend, preset, assignment }`, or null.
 */
export function assignedDecisionBackend(overview) {
  const assignment = overview?.inference?.assignments?.decision;
  if (assignment?.kind !== "decision") return null;
  const backend = overview?.inference?.backends?.[assignment.backendKey];
  const presetId = backend?.preset ?? assignment.preset;
  return {
    key: assignment.backendKey,
    model: assignment.model,
    backend,
    preset: presetId ? backendPreset(overview, { preset: presetId }) : undefined,
    assignment,
  };
}

/**
 * Whether listing a decision server's models is worth asking: only a server
 * of the operator's own (a local preset, or none) lists them; hosted
 * providers mix chat and decision models, so their presets name theirs.
 */
export function canProbeDecisionModels(preset) {
  return !preset || preset.kind === "local";
}

/**
 * The model suggestions for a preset's decision API: the ids the server
 * reported first (they are installed), then the preset's own with their
 * context and price.
 */
export function decisionModelOptions(preset, probed = []) {
  const known = preset?.decision?.models ?? [];
  const out = [];
  const seen = new Set();
  for (const id of probed ?? []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...(known.find((m) => m.id === id) ?? {}), id, installed: true });
  }
  for (const model of known) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push({ ...model });
  }
  return out;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function formatPrice(n) {
  if (n === 0) return "free";
  const digits = n < 0.01 ? 3 : 2;
  return `$${n.toFixed(digits)}/M input tokens`;
}

/** "128k context · $0.10/M input tokens", or "" when neither is known. */
export function decisionModelHint(option) {
  const parts = [];
  if (typeof option?.contextTokens === "number" && option.contextTokens > 0) parts.push(`${formatTokens(option.contextTokens)} context`);
  if (typeof option?.inputCostPerMillion === "number" && option.inputCostPerMillion >= 0) parts.push(formatPrice(option.inputCostPerMillion));
  return parts.join(" · ");
}

/**
 * The sentence a verify result shows: the answer time, or the server's reason
 * verbatim. The answering model is named only when it is not the one asked
 * (an alias the server resolved).
 */
export function decisionVerifyText(result, model) {
  if (!result) return "";
  if (result.ok) {
    const via = result.answeredBy && result.answeredBy !== model ? ` by ${result.answeredBy}` : "";
    return typeof result.latencyMs === "number"
      ? `Answered${via} in ${Math.round(result.latencyMs)} ms.`
      : `Answered${via}.`;
  }
  return result.reason ?? "The model did not answer.";
}

const percent = (share) => `${Math.round(share * 100)}%`;

function shortDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The calibrated summary. A calibration that records what it keeps and
 * skips — the share of the reference emails Jev keeps that the calibrated
 * model keeps too, and likewise for those Jev skips — says so, with the
 * uncalibrated shares for comparison; an older one reports its agreement.
 */
export function calibrationSummary(calibration) {
  if (!calibration) return "";
  const date = calibration.fittedAt ? shortDate(calibration.fittedAt) : null;
  const head = `Calibrated against Jev${date ? ` on ${date}` : ""}`;
  const isShare = (v) => typeof v === "number";
  if (isShare(calibration.keeps) && isShare(calibration.skips)) {
    const before = isShare(calibration.keepsBefore) && isShare(calibration.skipsBefore)
      ? ` (before: ${percent(calibration.keepsBefore)} and ${percent(calibration.skipsBefore)})`
      : "";
    return `${head}: keeps ${percent(calibration.keeps)} of the reference emails Jev keeps and skips ${percent(calibration.skips)} of those it skips${before}.`;
  }
  if (!isShare(calibration.agreement)) return `${head}.`;
  const before = isShare(calibration.agreementBefore) ? ` (was ${percent(calibration.agreementBefore)})` : "";
  return `${head}: agrees with Jev on ${percent(calibration.agreement)} of the reference emails${before}.`;
}

/** Progress of a running calibration: "120 of 300 reference emails" (+ failures). */
export function calibrationProgressText(status) {
  const total = status?.total ?? 0;
  const done = status?.done ?? 0;
  const failed = status?.failed ?? 0;
  const base = total > 0 ? `${done} of ${total} reference emails` : "Starting…";
  return failed > 0 ? `${base} · ${failed} failed` : base;
}

/** Share of a running calibration finished, 0–1. */
export function calibrationFraction(status) {
  const total = status?.total ?? 0;
  return total > 0 ? Math.min(1, Math.max(0, (status.done ?? 0) / total)) : 0;
}

/**
 * Which calibration panel state to show for the assigned model:
 * "running", "failed", "cancelled" (this assignment's last run, when no
 * calibration is stored),
 * "other-running" (a run for another assignment, started before the model
 * changed or from the CLI), "calibrated" or "uncalibrated".
 */
export function calibrationPanelState(status, assigned) {
  const mine = status?.assignment && assigned && status.assignment === `${assigned.key}/${assigned.model}`;
  if (status?.state === "running") return mine ? "running" : "other-running";
  // A finished run counts before the reloaded overview says so; a failed or
  // cancelled recalibration leaves the stored calibration in force.
  if (assigned?.assignment?.calibrated || (mine && status.state === "done" && status.result)) return "calibrated";
  if (mine && (status.state === "failed" || status.state === "cancelled")) return status.state;
  return "uncalibrated";
}

/**
 * The calibration to summarise for the assigned model: the stored one, else
 * the result of this assignment's finished run (shown until the reloaded
 * overview carries it).
 */
export function assignedCalibration(assigned, status) {
  const stored = assigned?.backend?.decision?.calibrations?.[assigned.model];
  if (stored) return stored;
  const mine = assigned && status?.assignment === `${assigned.key}/${assigned.model}`;
  return mine && status.state === "done" ? status.result : undefined;
}

/** Where a backend's decision API runs: "On this host" or the URL's host. */
export function decisionWhere(decision) {
  if (!decision) return "";
  if (decision.onHost) return "On this host";
  try {
    return new URL(decision.url).host;
  } catch {
    return decision.url ?? "";
  }
}
