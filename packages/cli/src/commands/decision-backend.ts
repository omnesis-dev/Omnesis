// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure helpers for `omnesis decision`: build the config patch that adds a
 * decision backend from a preset, and describe a calibration.
 */

import {
  fillDecisionPresetUrl,
  getDecisionPreset,
  type DecisionCalibration,
  type DecisionProviderPreset,
} from "@omnesis/core";
import { RESERVED_DECISION_BACKEND_NAMES } from "@omnesis/config";

export interface DecisionBackendInput {
  name: string;
  presetId?: string;
  /** An explicit URL, for a server that matches no preset. */
  url?: string;
  /** `key=value` pairs for a preset's URL placeholders. */
  params?: Record<string, string>;
  apiKey?: string;
  allowRemote?: boolean;
  /** Assign this model to the Decision role in the same write. */
  model?: string;
}

export interface DecisionBackendPatch {
  patch: { inference: Record<string, unknown> };
  url: string;
  preset?: DecisionProviderPreset;
}

/** Parse repeated `--param key=value` flags. */
export function parseParams(raw: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new Error(`--param needs key=value, got "${item}"`);
    out[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
  }
  return out;
}

/**
 * The `PATCH /admin/config` body that adds (or replaces) a decision backend,
 * and optionally assigns one of its models. Throws a message for the operator
 * when the input cannot make a backend.
 */
export function buildDecisionBackendPatch(input: DecisionBackendInput): DecisionBackendPatch {
  const name = input.name.trim();
  if (!name || RESERVED_DECISION_BACKEND_NAMES.includes(name) || name.includes("/")) {
    throw new Error(
      `"${name}" cannot name a decision backend: it is empty, contains "/", or is one of ${RESERVED_DECISION_BACKEND_NAMES.join(", ")}.`,
    );
  }
  const preset = getDecisionPreset(input.presetId ?? name);
  if (input.presetId && !preset) throw new Error(`Unknown decision preset "${input.presetId}".`);
  if (preset?.builtIn === "typesafe") {
    throw new Error(
      'TypeSafe is built in: set its key with "omnesis backend key set typesafe" and assign "typesafe/<model>".',
    );
  }
  const url = input.url ?? (preset ? fillDecisionPresetUrl(preset, input.params ?? {}) : undefined);
  if (!url) {
    throw new Error(`"${name}" is not a decision preset; give the server's URL with --url.`);
  }
  try {
    new URL(url);
  } catch {
    throw new Error(`"${url}" is not a URL.`);
  }
  const backend: Record<string, unknown> = { url };
  if (preset) {
    backend.preset = preset.id;
    backend.protocol = preset.protocol;
    backend.auth = preset.auth;
    if (preset.scoreField) backend.scoreField = preset.scoreField;
  }
  if (input.apiKey) backend.apiKey = input.apiKey;
  const inference: Record<string, unknown> = { decisionBackends: { [name]: backend } };
  if (input.allowRemote) inference.allowRemoteInference = true;
  if (input.model) inference.assignments = { decision: `${name}/${input.model}` };
  return { patch: { inference }, url, ...(preset ? { preset } : {}) };
}

/** One line describing a stored calibration. */
export function describeCalibration(calibration: DecisionCalibration | undefined): string {
  if (!calibration) {
    return "not calibrated — thresholds tuned on TypeSafe's Jev may not fit this model";
  }
  const date = calibration.fittedAt.slice(0, 10);
  const pct = (v: number | undefined) => (v === undefined ? "?" : `${Math.round(v * 100)}%`);
  if (calibration.keeps !== undefined && calibration.skips !== undefined) {
    return `calibrated ${date}: keeps ${pct(calibration.keeps)} of the reference emails Jev keeps and skips ${pct(calibration.skips)} of those it skips (was ${pct(calibration.keepsBefore)} and ${pct(calibration.skipsBefore)})`;
  }
  return `calibrated ${date}: agrees with Jev on ${pct(calibration.agreement)} of the reference emails (was ${pct(calibration.agreementBefore)})`;
}
