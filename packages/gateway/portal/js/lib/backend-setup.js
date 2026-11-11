// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure helpers for setting up an inference backend from the Models page.
 *
 * A backend (`inference.backends.<key>`) is one provider account with one
 * key. It serves an OpenAI-compatible API (`url`: chat, embedding and other
 * models), a decision API (`decision`), or both, as the provider preset it
 * was made from offers them (`allProviders`). Kept free of the DOM so the
 * name rules, the URL filling and the `PATCH /admin/config` bodies are
 * unit-tested on their own.
 */

/** Names a backend cannot take: the built-in prefixes of an assignment. */
const RESERVED_BACKEND_NAMES = ["local", "anthropic", "codex", "claude-code", "replay", "typesafe"];

/**
 * What a backend or preset serves: "chat" (its OpenAI-compatible API: chat,
 * embedding, transcription and other models), "decision" or "both".
 */
function servesOf({ url, decision }) {
  if (url && decision) return "both";
  return decision ? "decision" : "chat";
}

/** What a configured backend serves. */
export function backendServes(backend) {
  return servesOf({ url: backend?.url, decision: backend?.decision });
}

/** What a provider preset serves. */
export function presetServes(preset) {
  return servesOf({ url: preset?.defaultUrl, decision: preset?.decision });
}

export const SERVES_LABEL = {
  chat: "OpenAI-compatible models",
  decision: "Decision models",
  both: "OpenAI-compatible and decision models",
};

/**
 * Every provider preset `GET /admin/models` serves: `presets` (each with an
 * OpenAI-compatible API, some with a decision API too) and `decisionProviders`
 * (decision APIs only, the built-in TypeSafe among them).
 */
export function allProviders(overview) {
  return [...(overview?.presets ?? []), ...(overview?.decisionProviders ?? [])];
}

/** The presets a backend can be made from: all but the built-in TypeSafe. */
export function addablePresets(overview) {
  return allProviders(overview).filter((preset) => !preset.builtIn);
}

/** The preset a backend was made from, as the gateway reports it. */
export function backendPreset(overview, backend) {
  return backend?.preset ? allProviders(overview).find((preset) => preset.id === backend.preset) : undefined;
}

/**
 * The logo id for a preset: its decision catalog id when it names one
 * (Cloudflare's is `cloudflare-workers-ai`), else its own id.
 */
export function presetLogoId(preset) {
  if (!preset || preset.builtIn) return null;
  return preset.decision?.modelsDevId ?? preset.id;
}

/** A backend's display name: its preset's name when the key is the preset id. */
export function backendDisplayName(key, preset) {
  return preset && key === preset.id ? preset.name : key;
}

/**
 * Why a new backend name cannot be used, or null. Names already taken are
 * refused: saving under one would rewrite that backend.
 */
export function backendNameError(name, overview) {
  const key = String(name ?? "").trim();
  if (!key) return "Enter a name.";
  if (key.length > 64) return "Use at most 64 characters.";
  if (key.includes("/")) return "A name cannot contain \"/\".";
  if (RESERVED_BACKEND_NAMES.includes(key)) return `"${key}" is reserved.`;
  if (overview?.inference?.backends?.[key]) return `"${key}" is already a backend.`;
  return null;
}

/** A free name for a new backend: `base`, then base-2, base-3… */
export function freeBackendName(base, overview) {
  if (!base) return "";
  let candidate = base;
  for (let n = 2; backendNameError(candidate, overview) !== null; n += 1) candidate = `${base}-${n}`;
  return candidate;
}

/** The `{param}` placeholders a URL still contains. */
export function decisionUrlPlaceholders(url) {
  return [...String(url ?? "").matchAll(/\{([a-z][a-z0-9-]*)\}/gi)].map((m) => m[1]);
}

/**
 * Fill a preset's decision URL placeholders with the operator's values, each
 * URL-encoded. Returns `{ url }`, or `{ error }` naming the first value still
 * missing — the same rule as core's `fillDecisionPresetUrl`.
 */
export function fillDecisionUrl(decision, params = {}) {
  let url = decision?.url ?? "";
  for (const param of decision?.urlParams ?? []) {
    const value = String(params[param.key] ?? "").trim();
    if (!value) return { error: `Enter your ${param.label.toLowerCase()}.` };
    url = url.replaceAll(`{${param.key}}`, encodeURIComponent(value));
  }
  const left = decisionUrlPlaceholders(url);
  if (left.length) return { error: `The URL still has {${left[0]}}.` };
  return { url };
}

/**
 * The `decision` block for a backend: the URL with the preset's wire format
 * (protocol, key header, score field). A server no preset describes takes the
 * gateway's defaults.
 */
function decisionBlock(presetDecision, url) {
  const block = { url };
  if (presetDecision) {
    block.protocol = presetDecision.protocol;
    block.auth = presetDecision.auth;
    if (presetDecision.scoreField) block.scoreField = presetDecision.scoreField;
  }
  return block;
}

/**
 * The one body that adds a backend: its OpenAI-compatible URL and its
 * decision API, whichever it has, with one key for both. `decisionModel`
 * assigns the Decision model to it in the same write; `enableRemote` folds the
 * cloud-inference consent in.
 */
export function newBackendPatch({ key, preset, url, apiPathPrefix, decisionUrl, apiKey, decisionModel, enableRemote = false }) {
  const cfg = { type: "http" };
  if (preset) cfg.preset = preset.id;
  if (url) cfg.url = url;
  if (url && apiPathPrefix) cfg.apiPathPrefix = apiPathPrefix;
  const typedKey = String(apiKey ?? "").trim();
  if (typedKey) cfg.apiKey = typedKey;
  if (decisionUrl) cfg.decision = decisionBlock(preset?.decision, decisionUrl);
  const inference = { backends: { [key]: cfg } };
  if (decisionModel) inference.assignments = { decision: `${key}/${decisionModel}` };
  if (enableRemote) inference.allowRemoteInference = true;
  return { inference };
}

/**
 * The body that adds the preset's decision API to an existing backend and
 * assigns the Decision model to it. The backend's own key serves both of its
 * APIs, so the body carries none — unless the backend has no key and the
 * operator typed one, which then becomes its key for both.
 */
export function enableDecisionPatch({ key, preset, decisionUrl, model, apiKey, enableRemote = false }) {
  const backend = { decision: decisionBlock(preset?.decision, decisionUrl) };
  const typedKey = String(apiKey ?? "").trim();
  if (typedKey) backend.apiKey = typedKey;
  const inference = {
    backends: { [key]: backend },
    assignments: { decision: `${key}/${model}` },
  };
  if (enableRemote) inference.allowRemoteInference = true;
  return { inference };
}

/**
 * The body that removes a backend's decision API, keeping its
 * OpenAI-compatible side, and turns the Decision model off when it used it.
 * A backend that serves only decision models is removed whole instead.
 */
export function disableDecisionPatch(key, overview) {
  const inference = { backends: { [key]: { decision: null } } };
  const assigned = overview?.inference?.assignments?.decision;
  if (assigned?.kind === "decision" && assigned.backendKey === key) inference.assignments = { decision: null };
  return { inference };
}
