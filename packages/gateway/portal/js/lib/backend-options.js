// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Backend-option derivation for the Models flows — the grid of "where can a
 * model for this capability come from" cards, and the grid of "what backend do
 * you want to add" cards. Both are pure projections of the `/admin/models`
 * overview, so they're unit-testable without a DOM.
 *
 * Backends are GLOBAL (an HTTP backend or the Anthropic key, once configured,
 * is shared by every capability) — so these helpers read the same backend set
 * regardless of which capability the user is on. Configuring OpenAI while
 * enabling the Agent makes it available the moment you open the Embedder
 * picker; that "intent-based" sharing is the data model, surfaced here.
 */

import { filterBackendModels } from "./backend-model-filter.js";

/**
 * Capability role → bundled-catalog role. A capability with no bundled catalog
 * (ocr) maps to `undefined`: it has no Local or Anthropic-catalog card, only
 * HTTP backends.
 */
export const CAPABILITY_TO_CATALOG = {
  embedder: "embed",
  agent: "agent",
  "privacy-reviewer": "agent",
  "entailment-verifier": "agent",
  "watch-judge": "agent",
  transcriber: "transcribe",
  ocr: undefined,
};

/** Effective Anthropic key presence, including environment-backed credentials. */
export function isAnthropicConfigured(backends) {
  const anthropic = backends?.anthropic;
  return (
    anthropic?.hasApiKey === true ||
    (anthropic?.hasApiKey === undefined && anthropic?.status === "ok")
  );
}

/** Count of bundled GGUF catalog entries fit for a capability's catalog role. */
function localCatalogCount(catalog, catalogRole) {
  if (!catalogRole) return 0;
  return catalog.filter((e) => e.kind === "gguf" && (e.roles ?? []).includes(catalogRole)).length;
}

/** Count of Anthropic-API catalog entries fit for a capability's catalog role. */
function anthropicCatalogCount(catalog, catalogRole) {
  if (!catalogRole) return 0;
  return catalog.filter((e) => e.kind === "anthropic-api" && (e.roles ?? []).includes(catalogRole)).length;
}

/** Role-matching ("suggested") model count a configured HTTP backend serves. */
function httpFitCount(backend, role) {
  return filterBackendModels(backend?.modelRoles ?? {}, role).suggestedCount;
}

function codexFitCount(codex, role) {
  if (!codex?.models?.length) return 0;
  const rolesByModel = codex.modelRoles ?? {};
  return codex.models.filter((model) => rolesByModel[model]?.includes(role)).length;
}

/** Exact serving-provider logo identity for a configured HTTP backend. */
export function catalogProviderForBackend(overview, backendKey) {
  const prefix = `${backendKey}/`;
  for (const [assignment, facts] of Object.entries(overview?.modelControls ?? {})) {
    if (assignment.startsWith(prefix) && facts?.source === "models.dev") {
      return facts.providerId;
    }
  }
  return null;
}

/**
 * Options for the capability model picker — the grid the user picks a model
 * source from. Ordered: Local, each preset, each existing custom HTTP backend,
 * Codex for roles it advertises, Anthropic, then "add a custom HTTP backend".
 * Local/Anthropic cards appear only when the role has bundled catalog entries
 * for them.
 *
 * Each option carries the data a card needs: `configured` (is the backend set
 * up), `fitCount` (role-matching models it serves, when configured), and the
 * probe `status`.
 *
 * @returns {Array<object>} option descriptors keyed by `kind`:
 *   "local" | "preset" | "custom" | "codex" | "anthropic" | "add-custom".
 */
export function buildModelPickerOptions(overview, role) {
  const presets = overview.presets ?? [];
  const backends = overview.inference?.backends ?? {};
  const codex = overview.inference?.codex;
  const catalog = overview.catalog ?? [];
  const catalogRole = CAPABILITY_TO_CATALOG[role];

  const options = [];

  const localCount = localCatalogCount(catalog, catalogRole);
  if (localCount > 0) options.push({ kind: "local", count: localCount });

  const presetIds = new Set(presets.map((p) => p.id));
  for (const preset of presets) {
    const backend = backends[preset.id];
    if (role === "watch-judge" && backend?.protocol === "responses") continue;
    const configured = !!backend && backend.type === "http";
    options.push({
      kind: "preset",
      id: preset.id,
      preset,
      configured,
      fitCount: configured ? httpFitCount(backend, role) : 0,
      status: backend?.status,
    });
  }

  for (const [key, backend] of Object.entries(backends)) {
    if (backend.type !== "http" || presetIds.has(key)) continue;
    if (role === "watch-judge" && backend.protocol === "responses") continue;
    options.push({
      kind: "custom",
      id: key,
      logoProviderId: catalogProviderForBackend(overview, key),
      configured: true,
      fitCount: httpFitCount(backend, role),
      status: backend.status,
    });
  }

  const codexCount = codexFitCount(codex, role);
  if (codex?.configured === true && codexCount > 0) {
    options.push({
      kind: "codex",
      configured: codex.status === "ok" && codex.loggedIn === true,
      fitCount: codexCount,
      status: codex.status,
      loggedIn: codex.loggedIn === true,
    });
  }

  const anthropicCount = anthropicCatalogCount(catalog, catalogRole);
  if (anthropicCount > 0) {
    options.push({
      kind: "anthropic",
      configured: isAnthropicConfigured(backends),
      count: anthropicCount,
    });
  }

  options.push({ kind: "add-custom" });
  return options;
}

/**
 * Options for the "Add a backend" grid — not capability-scoped, so no Local
 * card and no per-role counts. Each preset and Anthropic carry a `configured`
 * flag so the grid can mark backends you've already set up; "add-custom" is
 * always last.
 */
export function buildAddBackendOptions(overview) {
  const presets = overview.presets ?? [];
  const backends = overview.inference?.backends ?? {};
  const codex = overview.inference?.codex;
  const options = presets.map((preset) => ({
    kind: "preset",
    id: preset.id,
    preset,
    configured: backends[preset.id]?.type === "http",
    status: backends[preset.id]?.status,
  }));
  options.push({
    kind: "anthropic",
    configured: isAnthropicConfigured(backends),
  });
  if (codex) {
    options.push({
      kind: "codex",
      configured: codex.configured === true,
      fitCount: codex.models?.length ?? 0,
      status: codex.status,
      loggedIn: codex.loggedIn === true,
    });
  }
  options.push({ kind: "add-custom" });
  return options;
}
