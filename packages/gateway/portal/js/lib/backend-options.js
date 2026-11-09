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
  // A decision is read from a chat model's next token.
  decision: "agent",
  transcriber: "transcribe",
  ocr: undefined,
  "speech-to-speech": undefined,
};

/**
 * TypeSafe model the Decision picker offers first. The operator can edit it;
 * the gateway accepts any `typesafe/<model>` id TypeSafe serves.
 */
export const TYPESAFE_DEFAULT_MODEL = "jev-1.13.0";

/**
 * Whether a capability is the Decision model. The gateway serves it from
 * TypeSafe, a local chat model, or an OpenAI-compatible HTTP backend that
 * returns token probabilities, and refuses the cloud chat runtimes (Codex,
 * Claude Code, Anthropic), which return none; it refuses TypeSafe for every
 * other role. The picker mirrors both halves.
 */
export function isDecisionRole(role) {
  return role === "decision";
}

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

/**
 * Card summary for a configured HTTP backend: how many models it serves for
 * the role, or that it doesn't list them. A server that answers but has no
 * model list (whisper.cpp's server, for one) would otherwise read as serving
 * none, though it serves the model id typed into its picker.
 */
export function httpBackendModelSummary(opt) {
  if (opt.status === "reachable") return "Doesn't list its models";
  return `${opt.fitCount} model${opt.fitCount !== 1 ? "s" : ""}`;
}

/** Models a built-in CLI backend (Codex, Claude Code) advertises for a role. */
function cliBackendFitCount(status, role) {
  if (!status?.models?.length) return 0;
  const rolesByModel = status.modelRoles ?? {};
  return status.models.filter((model) => rolesByModel[model]?.includes(role)).length;
}

/** Whether Claude Code can serve assignments: signed in with a model catalog. */
export function isClaudeCodeReady(claudeCode) {
  return claudeCode?.status === "ok" && claudeCode?.loggedIn === true;
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
 * Codex and Claude Code for roles they advertise, Anthropic, then "add a
 * custom HTTP backend".
 * Local/Anthropic cards appear only when the role has bundled catalog entries
 * for them. A decision role gets the TypeSafe card first, then Local and the
 * Chat Completions HTTP backends; Codex, Claude Code and Anthropic return no
 * token probabilities, so they are withheld, and TypeSafe serves nothing else.
 *
 * Each option carries the data a card needs: `configured` (is the backend set
 * up), `fitCount` (role-matching models it serves, when configured), and the
 * probe `status`.
 *
 * @returns {Array<object>} option descriptors keyed by `kind`:
 *   "local" | "preset" | "custom" | "codex" | "claude-code" | "anthropic" |
 *   "add-custom" | "typesafe".
 */
export function buildModelPickerOptions(overview, role) {
  const decision = isDecisionRole(role);
  // Roles that need a Chat Completions backend (the Responses API has no
  // single-token judgement shape they use).
  const needsChatCompletions = decision || role === "watch-judge";

  const presets = overview.presets ?? [];
  const backends = overview.inference?.backends ?? {};
  const codex = overview.inference?.codex;
  const claudeCode = overview.inference?.claudeCode;
  const catalog = overview.catalog ?? [];
  const catalogRole = CAPABILITY_TO_CATALOG[role];
  if (role === "speech-to-speech") {
    const options = Object.entries(backends)
      .filter(([, backend]) => backend.type === "http" && Object.values(backend.modelRoles ?? {}).some((roles) => roles.includes(role)))
      .map(([key, backend]) => ({kind:"custom",id:key,logoProviderId:"openai",configured:true,fitCount:httpFitCount(backend,role),status:backend.status}));
    const preset = presets.find((item) => item.id === "openai");
    if (preset && !options.some((option) => option.id === "openai")) {
      let key = "openai";
      let suffix = 2;
      while (backends[key]) key = `openai-${suffix++}`;
      options.unshift({kind:"preset",id:key,preset:{...preset,id:key},providerId:"openai",configured:false,fitCount:0});
    }
    return options;
  }


  const options = decision ? [{ kind: "typesafe" }] : [];

  const localCount = localCatalogCount(catalog, catalogRole);
  if (localCount > 0) options.push({ kind: "local", count: localCount });

  const presetIds = new Set(presets.map((p) => p.id));
  for (const preset of presets) {
    const backend = backends[preset.id];
    if (needsChatCompletions && backend?.protocol === "responses") continue;
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
    if (needsChatCompletions && backend.protocol === "responses") continue;
    options.push({
      kind: "custom",
      id: key,
      logoProviderId: catalogProviderForBackend(overview, key),
      configured: true,
      fitCount: httpFitCount(backend, role),
      status: backend.status,
    });
  }

  const codexCount = decision ? 0 : cliBackendFitCount(codex, role);
  if (codex?.configured === true && codexCount > 0) {
    options.push({
      kind: "codex",
      configured: codex.status === "ok" && codex.loggedIn === true,
      fitCount: codexCount,
      status: codex.status,
      loggedIn: codex.loggedIn === true,
    });
  }

  const claudeCodeCount = decision ? 0 : cliBackendFitCount(claudeCode, role);
  if (claudeCode?.installed === true && claudeCodeCount > 0) {
    options.push({
      kind: "claude-code",
      configured: isClaudeCodeReady(claudeCode),
      fitCount: claudeCodeCount,
      status: claudeCode.status,
      loggedIn: claudeCode.loggedIn === true,
      installed: true,
    });
  }

  const anthropicCount = decision ? 0 : anthropicCatalogCount(catalog, catalogRole);
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
 * always last. Claude Code is offered whenever the gateway reports on it, even
 * when the CLI is missing, so its pane can explain how to install it.
 */
export function buildAddBackendOptions(overview) {
  const presets = overview.presets ?? [];
  const backends = overview.inference?.backends ?? {};
  const codex = overview.inference?.codex;
  const claudeCode = overview.inference?.claudeCode;
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
  if (claudeCode) {
    options.push({
      kind: "claude-code",
      configured: isClaudeCodeReady(claudeCode),
      fitCount: claudeCode.models?.length ?? 0,
      status: claudeCode.status,
      loggedIn: claudeCode.loggedIn === true,
      installed: claudeCode.installed === true,
    });
  }
  options.push({ kind: "add-custom" });
  return options;
}
