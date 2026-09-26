// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Backend and assignment types for the inference layer.
 *
 * A "backend" is where inference runs: local GGUF, an HTTP server,
 * or a cloud API. An "assignment" maps a capability slot (embedder,
 * agent, transcriber, …) to a specific backend + model.
 *
 * Backend types:
 *   - `local`     — in-process GGUF via node-llama-cpp. Always
 *                   implicitly available; uses the catalog + manifest.
 *   - `http`      — OpenAI-compatible HTTP server (vLLM, Ollama,
 *                   llama-server, text-embeddings-inference).
 *                   User-declared in `inference.backends`.
 *   - `anthropic` — Anthropic Messages API. Well-known; implicit
 *                   like local (just needs an API key).
 *   - `replay`    — Scripted fixture playback (agent only; dev/demo).
 *   - `codex`     — Codex app-server subprocess for text and image inference.
 */

import type { GgufCatalogEntry, AnthropicCatalogEntry } from "./types.js";
import type { CapabilityRole } from "./capabilities.js";
import type { ModelSettingsByRole, ModelControls, ModelBehaviorValues } from "./model-behavior.js";

// ── Backend types ─────────────────────────────────────────────────────

export type BackendType = "local" | "http" | "anthropic";

/**
 * Wire protocol an HTTP agent backend speaks:
 *   - `chat-completions` — the OpenAI `POST /v1/chat/completions` protocol
 *     (`{messages, tools}` → `choices[].delta`). The default; every
 *     OpenAI-compatible server (vLLM, Ollama, Mistral, Gemini's shim, …)
 *     speaks it.
 *   - `responses` — the OpenAI `POST /v1/responses` protocol
 *     (`{input, instructions, tools}` → typed output items). Some OpenAI
 *     chat-capable models (e.g. `o1-pro`, `gpt-5-pro`, the deep-research
 *     models) are served *only* here and 404 on chat-completions.
 * Used only by the agent role; every other capability speaks its own
 * fixed endpoint.
 */
export type AgentProtocol = "chat-completions" | "responses";

/**
 * Token ceilings for one concrete model. The three limits remain distinct:
 * providers may advertise an input-only ceiling, a combined context window,
 * an output ceiling, or any subset of them.
 */
export interface ModelTokenLimits {
  maxInputTokens?: number;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export interface HttpBackendConfig {
  type: "http";
  url: string;
  apiKey?: string;
  /** Reference to a gateway-local config secret containing the bearer token. */
  apiKeySecret?: string;
  /**
   * Path segment between the base URL and the OpenAI-compatible endpoints
   * (`/chat/completions`, `/embeddings`, `/models`). Defaults to `"/v1"`.
   * Most providers serve at `host + /v1`, but some bake a different version
   * path into their base (e.g. Gemini's OpenAI shim lives at
   * `…/v1beta/openai`, which takes `apiPathPrefix: "/v1beta/openai"` with the
   * host as `url`). Always starts with `/`.
   */
  apiPathPrefix?: string;
  /**
   * Wire protocol for the agent role. When unset the agent backend defaults
   * to `chat-completions` and transparently retries a single turn against the
   * Responses API if the model 404s as "not a chat model" — so a
   * Responses-only model works without configuration. Set it explicitly to
   * pin a protocol and skip that detection. See {@link AgentProtocol}.
   */
  protocol?: AgentProtocol;
  /**
   * Operator-declared limits keyed by the exact served model id. OpenAI's
   * machine-readable Models API does not advertise these values, and arbitrary
   * compatible endpoints must never inherit facts guessed from a model name.
   */
  modelLimits?: Record<string, ModelTokenLimits>;
  /** Per-request agent generation timeout. */
  agentTimeoutMs?: number;
}

/**
 * Normalize a backend API path prefix into the form the request builders
 * expect: a leading slash, no trailing slash. Falls back to `"/v1"` when
 * unset/blank. Shared by the registry probe and the HTTP capability clients so
 * every inference endpoint URL is assembled the same way.
 */
export function normalizeApiPathPrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "/v1").trim();
  if (!trimmed) return "/v1";
  const withLead = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLead.replace(/\/+$/, "") || "/v1";
}

/**
 * Extract served-model ids from an OpenAI-compatible `GET /models` response.
 *
 * The OpenAI spec returns `{ object: "list", data: [{ id }, …] }`, and most
 * providers (OpenAI, Fireworks, vLLM, Gemini, …) follow it. Some — notably
 * Together AI — instead return a bare top-level array `[{ id }, …]`. Accept
 * both shapes so a single backend probe works across providers without
 * branching on provider identity (a bare array would otherwise parse to zero
 * models, hiding the live catalogue and silently falling back to stale
 * preset hints). List items may be `{ id: string }` objects or bare id
 * strings; anything without a usable id is skipped.
 */
export function extractModelIds(json: unknown): string[] {
  const list = Array.isArray(json)
    ? json
    : Array.isArray((json as { data?: unknown } | null)?.data)
      ? (json as { data: unknown[] }).data
      : [];
  const ids: string[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      if (item) ids.push(item);
    } else if (item && typeof (item as { id?: unknown }).id === "string") {
      ids.push((item as { id: string }).id);
    }
  }
  return ids;
}

// ── Assignment value (config shape) ───────────────────────────────────

/**
 * What goes in `inference.assignments.<role>`:
 *   - `"local/<catalogId>"`        → local GGUF model
 *   - `"anthropic/<apiModelId>"`   → Anthropic API model
 *   - `"<httpBackendKey>/<model>"` → model on a named HTTP backend
 *   - `"replay"`                   → replay backend (agent only)
 *   - `null`                       → explicitly disabled
 *   - omitted                      → use the catalog default for the role
 */
export type AssignmentValue = string | null;

// ── Resolved assignment (runtime state) ──────────────────────────────

interface ResolvedBase {
  role: CapabilityRole;
}

/**
 * A built-in OCR runtime that needs no downloadable model file:
 *   - `apple-vision` — Apple's Vision framework (macOS only).
 *   - `tesseract`    — the Tesseract OCR engine (optional dependency).
 *   - `gguf`         — a llama.cpp vision GGUF run via the `llama-mtmd-cli`
 *                      subprocess; model/projector paths come from the
 *                      `inference.ocr.gguf` config block, not the catalog.
 * Selected by a bare assignment string (e.g. `inference.assignments.ocr =
 * "apple-vision"`), so these never appear in the model catalog/manifest.
 */
export type OcrNativeRuntime = "apple-vision" | "tesseract" | "gguf";

export interface ResolvedLocal extends ResolvedBase {
  kind: "local";
  catalogId: string;
  catalogEntry?: GgufCatalogEntry;
  modelPath: string;
  embedDim?: number;
  available: boolean;
  reason?: string;
  /**
   * Set when this resolves to a built-in OCR runtime rather than a catalog
   * GGUF model (`modelPath` is then empty). The OCR loader dispatches on it.
   */
  nativeRuntime?: OcrNativeRuntime;
}

export interface ResolvedHttp extends ResolvedBase {
  kind: "http";
  backendKey: string;
  url: string;
  /** API path prefix for this backend (see {@link HttpBackendConfig}); `"/v1"` when unset. */
  apiPathPrefix?: string;
  model: string;
  /** Exact serving-provider/model catalog controls, when the gateway has a verified match. */
  modelControls?: ModelControls;
  /** Per-role explicit values, applied only if saved for this exact assignment. */
  modelBehavior?: ModelBehaviorValues;
  /** Limits explicitly configured for this exact model, when present. */
  modelLimits?: ModelTokenLimits;
  /** Configured per-request agent generation timeout, when present. */
  agentTimeoutMs?: number;
  /** Configured agent wire protocol; `undefined` means auto-detect. See {@link AgentProtocol}. */
  protocol?: AgentProtocol;
  /**
   * Whether this config explicitly permits non-loopback HTTP inference. When
   * false, HTTP clients may only call loopback backends.
   */
  allowRemoteInference: boolean;
  available: boolean;
  reason?: string;
  reasonCode?: "remote_inference_disabled";
}

/**
 * Reason surfaced when a cloud chat backend (Anthropic, Codex) is
 * selected but `inference.allowRemoteInference` is off. These backends send the
 * corpus off-host unconditionally — there is no loopback variant to fall back
 * to — so they stay disabled until remote inference is explicitly enabled.
 */
export const CLOUD_EGRESS_DISABLED_REASON =
  "This is a cloud backend that would send data off your machine. Set inference.allowRemoteInference: true in omnesis.json to use it.";

export interface ResolvedAnthropic extends ResolvedBase {
  kind: "anthropic";
  catalogId: string;
  catalogEntry?: AnthropicCatalogEntry;
  apiModelId: string;
  /**
   * Whether config permits sending data to this cloud backend. When false the
   * backend is never constructed. Anthropic is unconditionally off-host, so
   * `inference.allowRemoteInference` is the only gate.
   */
  allowRemoteInference: boolean;
  available: boolean;
  reason?: string;
}

export interface ResolvedDisabled extends ResolvedBase {
  kind: "disabled";
}

export interface ResolvedUnresolved extends ResolvedBase {
  kind: "unresolved";
  reason: string;
}

export interface ResolvedReplay extends ResolvedBase {
  kind: "replay";
  fixture?: string;
}

export interface ResolvedCodex extends ResolvedBase {
  kind: "codex";
  /** Codex model id, from a `"codex/<model>"` capability assignment. */
  model: string;
  /**
   * Whether config permits sending data to this cloud backend. When false the
   * backend is never constructed. The Codex runtime reaches OpenAI's cloud with
   * no in-process URL gate, so `inference.allowRemoteInference` is the only gate.
   */
  allowRemoteInference: boolean;
  /** Provider-native settings saved for this exact Codex assignment. */
  modelBehavior?: ModelBehaviorValues;
  available: boolean;
  reason?: string;
}

export type ResolvedAssignment =
  | ResolvedLocal
  | ResolvedHttp
  | ResolvedAnthropic
  | ResolvedDisabled
  | ResolvedUnresolved
  | ResolvedReplay
  | ResolvedCodex;

// ── Backend status (for portal/CLI) ──────────────────────────────────

export interface BackendStatus {
  type: BackendType;
  url?: string;
  /** Wire protocol used by an HTTP backend. */
  protocol?: "chat-completions" | "responses";
  /**
   * - `ok` — the backend answered `/v1/models` with a model list.
   * - `reachable` — the host responded, but listing models failed (e.g. a 500
   *   or 404 from `/v1/models`). The backend may still serve inference; the
   *   user assigns a model id manually. Distinct from `unreachable` so a
   *   working backend whose model-list endpoint is broken (Fireworks returns
   *   HTTP 500 there) isn't mislabelled as down. An auth failure (401/403) is
   *   still `unreachable` — the credentials must be fixed before it's usable.
   * - `unreachable` — the host couldn't be reached, or rejected the credentials.
   * - `probing` — a probe is in flight.
   */
  status: "ok" | "reachable" | "unreachable" | "probing";
  /** Raw served-model ids reported by the backend's `/v1/models` probe. */
  models?: string[];
  /** Why the last probe wasn't fully `ok` (e.g. `"HTTP 500"`); set for `reachable`/`unreachable`. */
  reason?: string;
  reasonCode?: "remote_inference_disabled";
  /**
   * Capability roles each candidate model can serve, keyed by model id —
   * covering both probed models and any provider-preset known-models for
   * this backend. Lets the portal/CLI suggest only role-appropriate models
   * per capability tab. Derived from the model id (see `classifyModelRoles`),
   * since `/v1/models` never advertises purpose.
   */
  modelRoles?: Record<string, CapabilityRole[]>;
  /** Whether an API key is configured for this backend (value never exposed). */
  hasApiKey?: boolean;
  /** Where the effective API key came from, when the backend can report it. */
  credentialSource?: "environment" | "file";
  /**
   * Configured API path prefix (see {@link HttpBackendConfig}). Surfaced so the
   * portal's edit form can round-trip it — a backend config is replaced
   * wholesale per key, so the prefix would otherwise be dropped on edit.
   */
  apiPathPrefix?: string;
}

export interface CodexModelStatus {
  /** Supported input kinds; older catalogs omit this and support text and images. */
  inputModalities?: Array<"text" | "image">;
  /** Model id accepted by `codex app-server` (used as `codex/<id>` in assignments). */
  id: string;
  /** Human-readable label from the Codex catalog, when available. */
  name?: string;
  /** Short catalog description, when available. */
  description?: string;
  /** True when Codex marks this model as preferred in the catalog. */
  recommended?: boolean;
  /** Provider-native default, reported by Codex app-server. */
  defaultReasoningEffort?: string;
  /** Exact effort values accepted by this Codex model. */
  supportedReasoningEfforts?: string[];
}

export interface CodexRuntimeStatus {
  /** `managed` means Omnesis' pinned @openai/codex package; `override` means OMNESIS_CODEX_COMMAND. */
  source: "managed" | "override";
  /** Executable path/command used for Codex CLI and app-server calls. */
  command: string;
  /** Managed package name, when source is `managed`. */
  packageName?: string;
  /** Managed package version, when source is `managed`. */
  packageVersion?: string;
  /** Runtime version reported by `codex --version`, when the probe succeeded. */
  version?: string;
  /** Whether the version probe succeeded and passed Omnesis' supported range. */
  supported: boolean;
  /** Probe failure reason when `supported` is false. */
  reason?: string;
}

/** The gateway's read-only assessment of its managed Codex runtime. */
export interface CodexRuntimeUpdatePlan {
  state: "up-to-date" | "update-available" | "repair-needed" | "externally-managed";
  action: "none" | "update" | "repair" | "external";
  currentVersion?: string;
  targetVersion?: string;
  canUpdate: boolean;
  /** Runtime replacement never touches the dedicated Codex login home. */
  preservesLogin: true;
  /** Model-role assignments remain unchanged across a runtime replacement. */
  preservesAssignments: true;
  /** Codex subprocesses are replaced without restarting the gateway. */
  requiresGatewayRestart: false;
  reason?: string;
}

export type CodexRuntimeUpdateOperationState =
  | "checking"
  | "downloading"
  | "verifying"
  | "waiting-for-turns"
  | "activating"
  | "refreshing-models"
  | "complete"
  | "failed"
  | "rolled-back"
  | "canceled";

/** One asynchronous, gateway-hosted Codex runtime update. */
export interface CodexRuntimeUpdateOperation {
  id: string;
  state: CodexRuntimeUpdateOperationState;
  fromVersion?: string;
  toVersion: string;
  /** Turns still draining before activation. */
  activeTurns: number;
  startedAt: string;
  finishedAt?: string;
  reason?: string;
  /** Model ids that appeared after the new runtime became active. */
  newModels?: string[];
}

/** Wire response shared by runtime update plan, start, poll, and cancel routes. */
export interface CodexRuntimeUpdateSnapshot {
  plan: CodexRuntimeUpdatePlan;
  operation: CodexRuntimeUpdateOperation | null;
}

export interface CodexBackendStatus {
  type: "codex";
  /**
   * Whether the dedicated Omnesis Codex home currently has stored auth. A
   * configured Codex backend can still be unreachable when the token is
   * revoked; an unconfigured one is offered from "Add backend" but not shown as
   * an existing backend row.
   */
  configured: boolean;
  /**
   * - `ok` — Codex CLI is installed, logged in, and returned a model catalog.
   * - `unreachable` — Codex CLI is missing, unsupported, not logged in, or the
   *   model catalog could not be read.
   * - `probing` — a refresh is in flight.
   */
  status: "ok" | "unreachable" | "probing";
  /** Whether `codex login status` reports a ChatGPT/account login. */
  loggedIn: boolean;
  /** Managed-runtime maintenance state, populated after the gateway probe. */
  runtimeUpdate?: CodexRuntimeUpdatePlan;
  /** Runtime source/path/version details for operator diagnostics. */
  runtime?: CodexRuntimeStatus;
  /** Model ids returned by Codex discovery, already filtered for selection. */
  models: string[];
  /** Richer details for the same models, preserving the served order. */
  modelDetails?: CodexModelStatus[];
  /** Which Codex discovery path produced `models`. */
  discovery?: "app-server" | "debug-models";
  /** Codex chat models can serve interactive, privacy-review, and background roles. */
  modelRoles?: Record<string, CapabilityRole[]>;
  /** Why the last refresh was not fully usable. */
  reason?: string;
  /** ISO timestamp for the latest completed refresh attempt. */
  refreshedAt?: string;
}

export interface CodexLoginFlow {
  id: string;
  status: "pending" | "complete" | "failed" | "canceled";
  verificationUri?: string;
  userCode?: string;
  expiresAt?: string;
  reason?: string;
}

// ── Behavioral capability verdict ────────────────────────────────────

/**
 * Outcome of a behavioral probe that confirms whether a specific HTTP-backend
 * model can actually serve a given role. The `/v1/models` protocol advertises
 * no purpose, so model→role classification is otherwise a name heuristic; this
 * is the authoritative confirm, issued on demand (never auto-probed per model
 * on page load) and cached per `(backend, model, role)`.
 */
export interface CapabilityVerdict {
  role: CapabilityRole;
  model: string;
  /** True when the backend served the role's minimal capability call. */
  supported: boolean;
  /** One-line human-readable explanation (endpoint hit, dim, or error). */
  detail: string;
}

// ── Inference overview (API response snapshot) ────────────────────────

export interface InferenceOverview {
  /**
   * Global network policy for user-declared HTTP inference backends. When
   * false/omitted, non-loopback HTTP inference URLs are blocked before fetch.
   */
  allowRemoteInference?: boolean;
  backends: Record<string, BackendStatus>;
  /** Built-in Codex backend status. Separate from HTTP backends because it is
   * backed by the local Codex CLI/ChatGPT login, not an OpenAI-compatible URL. */
  codex?: CodexBackendStatus;
  assignments: Record<CapabilityRole, ResolvedAssignment>;
}

// ── Config health (fail-loud degraded-assignment signal) ──────────────

/**
 * A capability role whose assignment is *degraded* — it names a model or
 * backend that doesn't resolve (a typo, a removed backend, a stale id). This
 * is distinct from an intentionally-unset/null role, which is a normal
 * (non-degraded) state: an unset role simply leaves that capability off.
 *
 * Surfaced on `/status` so an operator (and an autonomous agent) can see
 * exactly *which* role did nothing and *why*, instead of a capability
 * silently disabling itself behind a buried log line.
 */
export interface DegradedRole {
  role: CapabilityRole;
  /** Why the assignment failed to resolve (e.g. an unknown backend name). */
  reason: string;
}

/**
 * Health of the resolved inference configuration. Empty `degradedRoles` (and
 * a null `lastConfigError`) means every assigned role resolved cleanly;
 * intentionally-unset roles never appear here.
 */
export interface ConfigHealth {
  /** Roles whose assignment points at a non-existent model/backend. */
  degradedRoles: DegradedRole[];
  /**
   * A single one-line summary of the degraded assignments (naming the roles
   * and the first reason), or null when nothing is degraded. Lets a client
   * surface the problem without iterating `degradedRoles`.
   */
  lastConfigError: string | null;
}

// ── Config shape ─────────────────────────────────────────────────────

export interface InferenceConfig {
  backends?: Record<string, HttpBackendConfig>;
  assignments?: Partial<Record<CapabilityRole, AssignmentValue>>;
  modelSettings?: ModelSettingsByRole;
  allowRemoteInference?: boolean;
}
