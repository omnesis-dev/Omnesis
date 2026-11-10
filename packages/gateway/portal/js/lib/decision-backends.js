// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure helpers for setting up the Decision model on a decision backend: a
 * local decision-model server (Ollaya, Ollama, any other System One server)
 * or a hosted decision API, as `GET /admin/models` advertises them in
 * `decisionPresets`, and the configured ones in
 * `inference.decisionBackends`. Kept free of the DOM so the URL filling,
 * the name rules, the config patch and the status sentences are unit-tested
 * on their own.
 */

/**
 * Names a decision backend cannot take: the first part of a decision
 * assignment, so never a built-in prefix (`typesafe` included).
 */
export const RESERVED_DECISION_BACKEND_NAMES = ["local", "anthropic", "codex", "claude-code", "replay", "typesafe"];

/**
 * "Other server": a System One server the presets do not name. It is not a
 * preset, so a backend made from it records none.
 */
export const CUSTOM_DECISION_PROVIDER = Object.freeze({
  id: "custom",
  name: "Other server",
  kind: "local",
  url: "",
  protocol: "systemone",
  auth: "bearer",
  keyRequired: false,
  custom: true,
  models: [],
  note: "Any server that answers System One decision requests.",
});

/**
 * The logo id for a decision provider: its models.dev id when the preset
 * names one (Cloudflare's is `cloudflare-workers-ai`), else its own id; none
 * for "Other server" and the built-in TypeSafe.
 */
export function decisionLogoId(provider) {
  if (!provider || provider.custom || provider.builtIn) return null;
  return provider.modelsDevId ?? provider.id;
}

/** The decision presets, empty on a gateway that predates them. */
export function decisionPresets(overview) {
  return Array.isArray(overview?.decisionPresets) ? overview.decisionPresets : [];
}

/** The configured decision backends by key, empty on a gateway that predates them. */
export function decisionBackends(overview) {
  const backends = overview?.inference?.decisionBackends;
  return backends && typeof backends === "object" ? backends : {};
}

/** The preset a decision backend was made from, if the gateway names it. */
export function presetForBackend(overview, backend) {
  return backend?.preset ? decisionPresets(overview).find((p) => p.id === backend.preset) : undefined;
}

/**
 * The provider picker's three groups: configured decision backends first (to
 * reuse one and just pick a model), then servers on this machine, then hosted
 * APIs with TypeSafe first. TypeSafe is the built-in reference: it keeps its
 * own pane and never becomes a decision backend.
 */
export function decisionProviderGroups(overview) {
  const presets = decisionPresets(overview);
  const existing = Object.entries(decisionBackends(overview))
    .map(([key, backend]) => ({ key, backend, preset: presetForBackend(overview, backend) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const local = [...presets.filter((p) => p.kind === "local"), CUSTOM_DECISION_PROVIDER];
  const cloud = presets.filter((p) => p.kind === "cloud");
  cloud.sort((a, b) => (a.builtIn === "typesafe" ? -1 : b.builtIn === "typesafe" ? 1 : 0));
  return { existing, local, cloud };
}

/** The `{param}` placeholders a URL still contains. */
export function decisionUrlPlaceholders(url) {
  return [...String(url ?? "").matchAll(/\{([a-z][a-z0-9-]*)\}/gi)].map((m) => m[1]);
}

/**
 * Fill a preset's URL placeholders with the operator's values, each
 * URL-encoded. Returns `{ url }`, or `{ error }` naming the first value still
 * missing — the same rule as the gateway's `fillDecisionPresetUrl`.
 */
export function fillDecisionUrl(preset, params = {}) {
  let url = preset?.url ?? "";
  for (const param of preset?.urlParams ?? []) {
    const value = String(params[param.key] ?? "").trim();
    if (!value) return { error: `Enter your ${param.label.toLowerCase()}.` };
    url = url.replaceAll(`{${param.key}}`, encodeURIComponent(value));
  }
  const left = decisionUrlPlaceholders(url);
  if (left.length) return { error: `The URL still has {${left[0]}}.` };
  return { url };
}

/**
 * Why a decision backend name cannot be used, or null. `existingKey` is the
 * backend being edited, whose own name is of course allowed.
 */
export function decisionBackendNameError(name, overview, { existingKey } = {}) {
  const key = String(name ?? "").trim();
  if (!key) return "Enter a name.";
  if (key.length > 64) return "Use at most 64 characters.";
  if (key.includes("/")) return "A name cannot contain \"/\".";
  if (RESERVED_DECISION_BACKEND_NAMES.includes(key)) return `"${key}" is reserved.`;
  if (key === existingKey) return null;
  if (overview?.inference?.backends?.[key]) return `"${key}" is already an HTTP backend.`;
  if (decisionBackends(overview)[key]) return `"${key}" is already a decision backend.`;
  return null;
}

/** A free name for a new backend made from a provider: its id, then id-2, id-3… */
export function defaultDecisionBackendName(provider, overview) {
  const base = provider?.custom ? "decision-server" : provider?.id ?? "decision";
  let candidate = base;
  for (let n = 2; decisionBackendNameError(candidate, overview) !== null; n += 1) candidate = `${base}-${n}`;
  return candidate;
}

/**
 * The one `PATCH /admin/config` body that saves a decision backend and,
 * when `model` is given, assigns the Decision model to it — or null when
 * nothing would change.
 *
 * A NEW backend (`existing` absent) records the preset and its wire format:
 * protocol, auth and score field. An EXISTING backend sends only what the
 * operator changed — its URL, a newly typed key — so its stored wire format,
 * which the form never shows, is kept whatever preset it was made from. A
 * blank key is left out, so a stored one is kept. The assignment is written
 * only when it differs from `currentAssignment`; `enableRemote` folds the
 * cloud-inference consent into the same write.
 */
export function decisionBackendPatch({ key, provider, url, apiKey, model, existing, currentAssignment, enableRemote = false }) {
  const typedKey = String(apiKey ?? "").trim();
  let backend;
  if (existing) {
    backend = {};
    if (url && url !== existing.url) backend.url = url;
  } else {
    backend = {
      ...(provider && !provider.custom ? { preset: provider.id } : {}),
      url,
      protocol: provider?.protocol ?? "systemone",
      auth: provider?.auth ?? "bearer",
      ...(provider?.scoreField ? { scoreField: provider.scoreField } : {}),
    };
  }
  if (typedKey) backend.apiKey = typedKey;
  const inference = {};
  if (Object.keys(backend).length) inference.decisionBackends = { [key]: backend };
  if (model && `${key}/${model}` !== currentAssignment) inference.assignments = { decision: `${key}/${model}` };
  if (enableRemote) return { inference: { allowRemoteInference: true, ...inference } };
  if (!Object.keys(inference).length) return null;
  return { inference };
}

/** The Decision model's current assignment as `<backend>/<model>`, when it is on a decision backend. */
export function currentDecisionAssignment(overview) {
  const assigned = assignedDecisionBackend(overview);
  return assigned ? `${assigned.key}/${assigned.model}` : null;
}

/**
 * The patch that removes a decision backend, disabling the Decision model in
 * the same write when it is assigned there.
 */
export function removeDecisionBackendPatch(key, overview) {
  const inference = { decisionBackends: { [key]: null } };
  if (assignedDecisionBackend(overview)?.key === key) inference.assignments = { decision: null };
  return { inference };
}

/**
 * The Decision model's assignment when it is on a decision backend:
 * `{ key, model, backend, preset, assignment }`, or null.
 */
export function assignedDecisionBackend(overview) {
  const assignment = overview?.inference?.assignments?.decision;
  if (assignment?.kind !== "decision") return null;
  const backend = decisionBackends(overview)[assignment.backendKey];
  return {
    key: assignment.backendKey,
    model: assignment.model,
    backend,
    preset: presetForBackend(overview, backend) ?? (assignment.preset ? decisionPresets(overview).find((p) => p.id === assignment.preset) : undefined),
    assignment,
  };
}

/**
 * Whether listing a backend's models is worth asking: only a server of the
 * operator's own (a local preset or "Other server") lists them; hosted
 * providers mix chat and decision models, so their presets name theirs.
 */
export function canProbeDecisionBackend(provider) {
  return !provider || provider.custom === true || provider.kind === "local";
}

/**
 * The model suggestions for a provider: the ids the server reported first
 * (they are installed), then the preset's own with their context and price.
 */
export function decisionModelOptions(provider, probed = []) {
  const out = [];
  const seen = new Set();
  for (const id of probed ?? []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const known = (provider?.models ?? []).find((m) => m.id === id);
    out.push({ ...(known ?? {}), id, installed: true });
  }
  for (const model of provider?.models ?? []) {
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

/** "Calibrated against Jev on <date>: agrees with Jev on 91% of the reference emails (was 78%)." */
export function calibrationSummary(calibration) {
  if (!calibration) return "";
  const date = calibration.fittedAt ? shortDate(calibration.fittedAt) : null;
  const head = `Calibrated against Jev${date ? ` on ${date}` : ""}`;
  if (typeof calibration.agreement !== "number") return `${head}.`;
  const before = typeof calibration.agreementBefore === "number" ? ` (was ${percent(calibration.agreementBefore)})` : "";
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
 * "running", "failed", "cancelled" (for this assignment's last run),
 * "other-running" (a run for another assignment, started before the model
 * changed or from the CLI), "calibrated" or "uncalibrated".
 */
export function calibrationPanelState(status, assigned) {
  const mine = status?.assignment && assigned && status.assignment === `${assigned.key}/${assigned.model}`;
  if (status?.state === "running") return mine ? "running" : "other-running";
  if (mine && (status.state === "failed" || status.state === "cancelled")) return status.state;
  return assigned?.assignment?.calibrated ? "calibrated" : "uncalibrated";
}

/** The stored calibration for the assigned model, if any. */
export function assignedCalibration(assigned) {
  return assigned?.backend?.calibrations?.[assigned.model];
}

/** A short location label for a backend: "On this host" or the URL's host. */
export function decisionBackendWhere(backend) {
  if (!backend) return "";
  if (backend.onHost) return "On this host";
  try {
    return new URL(backend.url).host;
  } catch {
    return backend.url ?? "";
  }
}
