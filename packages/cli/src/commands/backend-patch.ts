// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure helpers for `omnesis backend` and `omnesis decision`: the
 * `PATCH /admin/config` bodies that add a backend from a preset, add or
 * remove a backend's decision API, and the line describing a calibration.
 */

import {
  fillDecisionPresetUrl,
  getPreset,
  type DecisionCalibration,
  type ProviderPreset,
} from "@omnesis/core";

/** Names that are built-in assignment prefixes, so cannot name a backend. */
const RESERVED_BACKEND_NAMES = ["local", "anthropic", "codex", "claude-code", "replay"];

export interface ConfigPatch {
  inference: Record<string, unknown>;
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

function checkUrl(url: string): void {
  try {
    new URL(url);
  } catch {
    throw new Error(`"${url}" is not a URL.`);
  }
}

/**
 * A preset by id. An id the operator named explicitly must be a preset a
 * backend can be made from; a backend name that merely matches TypeSafe, which
 * is built in, picks no preset.
 */
function presetFor(id: string | undefined, explicit: boolean): ProviderPreset | undefined {
  const preset = id ? getPreset(id) : undefined;
  if (explicit && !preset) throw new Error(`Unknown preset "${id}".`);
  if (preset?.builtIn === "typesafe") {
    if (!explicit) return undefined;
    throw new Error(
      'TypeSafe is built in: set its key with "omnesis backend key set typesafe" and assign "typesafe/<model>".',
    );
  }
  return preset;
}

/**
 * The `decision` block for a backend: the preset's decision API (its URL
 * filled with `params`), or `decisionUrl` with the preset's wire details when
 * it has them. Undefined when neither gives a URL.
 */
function decisionBlock(
  preset: ProviderPreset | undefined,
  decisionUrl: string | undefined,
  params: Record<string, string>,
): Record<string, unknown> | undefined {
  const url = decisionUrl ?? (preset?.decision ? fillDecisionPresetUrl(preset, params) : undefined);
  if (!url) return undefined;
  checkUrl(url);
  const block: Record<string, unknown> = { url };
  if (preset?.decision) {
    block.protocol = preset.decision.protocol;
    block.auth = preset.decision.auth;
    if (preset.decision.scoreField) block.scoreField = preset.decision.scoreField;
  }
  return block;
}

export interface BackendAddInput {
  name: string;
  /** A preset id; else the name picks the preset when it is one. */
  presetId?: string;
  /** OpenAI-compatible base URL, for a server no preset describes. */
  url?: string;
  apiPathPrefix?: string;
  /** Decision endpoint URL, for a server no preset describes. */
  decisionUrl?: string;
  /** `key=value` pairs for a preset's decision URL placeholders. */
  params?: Record<string, string>;
  apiKey?: string;
  allowRemote?: boolean;
}

export interface BackendAddPatch {
  patch: ConfigPatch;
  url?: string;
  decisionUrl?: string;
  preset?: ProviderPreset;
}

/**
 * The body that adds (or replaces) a backend: one key for the preset's
 * OpenAI-compatible API and its decision API, whichever it has. Throws a
 * message for the operator when the input cannot make a backend.
 */
export function buildBackendAddPatch(input: BackendAddInput): BackendAddPatch {
  const name = input.name.trim();
  if (!name || RESERVED_BACKEND_NAMES.includes(name) || name.includes("/")) {
    throw new Error(`Backend name "${name}" is reserved or contains '/'.`);
  }
  const preset = presetFor(input.presetId ?? name, input.presetId !== undefined);
  const url = input.url ?? preset?.defaultUrl;
  if (url) checkUrl(url);
  const decision = decisionBlock(preset, input.decisionUrl, input.params ?? {});
  if (!url && !decision) {
    throw new Error(
      `No URL provided and "${name}" is not a known preset. Give the OpenAI-compatible URL, or the decision endpoint with --decision-url.`,
    );
  }
  if (decision && name === "typesafe") {
    throw new Error('A backend named "typesafe" cannot serve decision models; pick another name.');
  }
  const cfg: Record<string, unknown> = { type: "http" };
  if (preset) cfg.preset = preset.id;
  if (url) cfg.url = url;
  // The preset's API path prefix only goes with the preset's own URL.
  const apiPathPrefix = input.apiPathPrefix ?? (input.url ? undefined : preset?.apiPathPrefix);
  if (url && apiPathPrefix) cfg.apiPathPrefix = apiPathPrefix;
  if (input.apiKey) cfg.apiKey = input.apiKey;
  if (decision) cfg.decision = decision;
  const inference: Record<string, unknown> = { backends: { [name]: cfg } };
  if (input.allowRemote) inference.allowRemoteInference = true;
  return {
    patch: { inference },
    ...(url ? { url } : {}),
    ...(decision ? { decisionUrl: decision.url as string } : {}),
    ...(preset ? { preset } : {}),
  };
}

export interface DecisionEnableInput {
  backend: string;
  /** The backend's recorded preset, from the overview. */
  backendPreset?: string;
  /** A preset to use instead, recorded on the backend. */
  presetId?: string;
  decisionUrl?: string;
  params?: Record<string, string>;
  /** Assign this model to the Decision role in the same write. */
  model?: string;
}

/**
 * The body that adds a decision API to an existing backend. It carries no
 * key: the backend's own key is sent to both of its APIs.
 */
export function buildDecisionEnablePatch(input: DecisionEnableInput): {
  patch: ConfigPatch;
  url: string;
  preset?: ProviderPreset;
} {
  if (input.backend === "typesafe") {
    throw new Error('A backend named "typesafe" cannot serve decision models.');
  }
  const preset = presetFor(
    input.presetId ?? input.backendPreset ?? input.backend,
    input.presetId !== undefined,
  );
  const decision = decisionBlock(preset, input.decisionUrl, input.params ?? {});
  if (!decision) {
    throw new Error(
      `"${input.backend}" was not made from a preset with decision models; give the decision endpoint with --url.`,
    );
  }
  const backend: Record<string, unknown> = { decision };
  if (input.presetId && preset) backend.preset = preset.id;
  const inference: Record<string, unknown> = { backends: { [input.backend]: backend } };
  if (input.model) inference.assignments = { decision: `${input.backend}/${input.model}` };
  return {
    patch: { inference },
    url: decision.url as string,
    ...(preset ? { preset } : {}),
  };
}

/**
 * The body that removes a backend's decision API, keeping its
 * OpenAI-compatible side, and unassigns the Decision model when it used it.
 */
export function buildDecisionDisablePatch(input: {
  backend: string;
  servesChat: boolean;
  decisionAssigned: boolean;
}): ConfigPatch {
  if (!input.servesChat) {
    throw new Error(
      `"${input.backend}" serves only decision models; remove it with "omnesis backend remove ${input.backend}".`,
    );
  }
  const inference: Record<string, unknown> = {
    backends: { [input.backend]: { decision: null } },
  };
  if (input.decisionAssigned) inference.assignments = { decision: null };
  return { inference };
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

/** Which APIs a backend serves, as `omnesis backend list` shows it. */
export function backendServes(backend: { url?: string; decision?: unknown }): string {
  if (backend.url && backend.decision) return "openai+decision";
  return backend.decision ? "decision" : "openai";
}
