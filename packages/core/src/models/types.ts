// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Model management types — shared by gateway, CLI, and portal.
 *
 * Capability roles (`embedder`, `agent`, `transcriber`, …) define what
 * Omnesis needs inference for. Each role is served by a backend
 * (local GGUF, HTTP server, Anthropic API) configured in the
 * `inference` config block. See `capabilities.ts` and `backends.ts`
 * for the full type system.
 *
 * Catalog entries describe models the system knows about. Two flavours:
 *   - `gguf`           — a local model file downloaded to the models
 *                        directory and tracked in the manifest. Text models
 *                        (embed/agent) are GGUF run via node-llama-cpp;
 *                        transcribers are whisper.cpp GGML `.bin` files. The
 *                        `kind` discriminates the download/lifecycle path
 *                        (which is format-agnostic); the inference runtime is
 *                        chosen per capability role, not per `kind`.
 *   - `anthropic-api`  — remote model accessed through the Anthropic
 *                        Messages API. No file on disk.
 *
 * The manifest is the *local* record of what model files are on disk.
 */

import type { InferenceOverview } from "./backends.js";
import type { CapabilityMetadata, CapabilityRole } from "./capabilities.js";
import type { ProviderPreset } from "./provider-presets.js";
import type { ModelDisplay } from "./provider-brands.js";
import type { ModelControls, ModelSettingsByRole } from "./model-behavior.js";

/**
 * Catalog role — which catalog entries can serve which capability.
 * Maps to capability roles: `embed` → `embedder`, `agent` → `agent`,
 * `transcribe` → `transcriber`.
 */
export type ModelRole = "embed" | "agent" | "transcribe";

export const MODEL_ROLES = ["embed", "agent", "transcribe"] as const;

/**
 * The capability role a catalog role assigns to. Catalog roles say what a
 * model can do; capability roles name the independent assignment slot in
 * `inference.assignments`. Capability roles with no catalog role of their own
 * (the privacy reviewer, OCR, the background agent, the gates) are assigned by
 * capability alone and are deliberately absent here.
 */
export const CATALOG_ROLE_CAPABILITY: Readonly<Record<ModelRole, CapabilityRole>> = {
  embed: "embedder",
  agent: "agent",
  transcribe: "transcriber",
};

interface CatalogEntryBase {
  /**
   * Stable identifier. For GGUF entries: the filename without `.gguf`
   * (e.g. `nomic-embed-text-v1.5.Q8_0`). For Anthropic entries: the
   * provider/model form (e.g. `anthropic/claude-haiku-4-5-20251001`).
   * Used in CLI, config, and HTTP routes.
   */
  id: string;
  /** Display name surfaced in CLI/portal. */
  name: string;
  /** Roles this model can serve. */
  roles: readonly ModelRole[];
  /** Org or maintainer of the underlying weights. */
  author: string;
  /** SPDX-style license identifier (e.g. "Apache-2.0", "MIT"). */
  license: string;
  /** One-paragraph description for the model picker. */
  description: string;
  /** Embedding dimension when `roles` includes `embed`. */
  embedDim?: number;
  /** Context length in tokens. */
  contextLength?: number;
  /** Approx parameter count for display ("1.5B", "137M", …). */
  params?: string;
  /**
   * Recommended for first-time users. The picker surfaces these first
   * and the gateway falls back to `recommended` when no active model is
   * configured for a role.
   */
  recommended?: boolean;
}

export interface GgufCatalogEntry extends CatalogEntryBase {
  kind: "gguf";
  /** Filename on disk under the models directory. */
  filename: string;
  /** Direct download URL — typically a HuggingFace `resolve/main/...` link. */
  downloadUrl: string;
  /** Approx file size in bytes. Used for "needs N MB free" UI. */
  sizeBytes: number;
  /** SHA-256 hex of the GGUF blob. Optional — verified when present. */
  sha256?: string;
  /** Quantization label ("Q4_K_M", "Q8_0", …) for display. */
  quant?: string;
  /** Recommended free RAM in GB. */
  recommendedRamGb?: number;
  /** Hard floor on free RAM in GB — UI disables install below this. */
  minRamGb?: number;
}

export interface AnthropicCatalogEntry extends CatalogEntryBase {
  kind: "anthropic-api";
  /** The Anthropic model id (without the `anthropic/` prefix). */
  apiModelId: string;
  /** Maximum input-token value reported by the live Anthropic Models API. */
  maxInputTokens?: number;
  /** Maximum output-token value accepted by the Messages API. */
  maxOutputTokens?: number;
  /**
   * Whether the Models API reports support for adaptive thinking.
   * Undefined for bundled fallback entries whose capability metadata is
   * unavailable; runtimes may then fall back to model-family detection.
   */
  adaptiveThinking?: boolean;
}

export type CatalogEntry = GgufCatalogEntry | AnthropicCatalogEntry;

/**
 * Local manifest entry — one per model file actually present on disk.
 * Anthropic entries live in the catalog only and don't appear here.
 */
export interface ManifestEntry {
  /** Catalog id this file maps to, when known. */
  id: string;
  /** Filename relative to the models directory. */
  filename: string;
  /** Bytes on disk. */
  sizeBytes: number;
  /** SHA-256 hex computed when the file was downloaded or verified. */
  sha256: string;
  /** ISO timestamp of download/install. */
  downloadedAt: string;
  /** URL it was fetched from, when known. */
  downloadedFrom?: string;
  /**
   * True for files installed via the (future) HuggingFace browse path
   * — i.e. not in the bundled catalog. See #21.
   */
  unverified?: boolean;
}

export interface Manifest {
  version: 1;
  models: ManifestEntry[];
}

/**
 * Snapshot the gateway publishes via `GET /admin/models`. Combines the
 * full catalog, the local manifest, and the inference overview so the
 * portal/CLI can render without further round-trips.
 */
export interface ModelsOverview {
  catalog: CatalogEntry[];
  installed: ManifestEntry[];
  inference: InferenceOverview;
  modelsDir: string;
  /**
   * Well-known provider presets (id, name, default URL, known models).
   * Served so the portal renders the add-backend form and model
   * suggestions from one source of truth rather than a hardcoded copy.
   */
  presets: ProviderPreset[];
  /**
   * Per-role display projection of the resolved assignments — provider
   * brand id + label + friendly model name for each capability role.
   * Computed server-side via `resolveModelDisplay`
   * so clients that can't run that resolver (the iOS Models view, the
   * portal Models tab) render a provider+model label and brand glyph
   * without mapping raw model ids themselves.
   */
  assignmentDisplays: Partial<Record<CapabilityRole, ModelDisplay>>;
  /**
   * Presentation metadata (title, description, icon slug) for every
   * capability, in display order. Served so the portal's capability-card
   * grid renders one card per capability without a hardcoded copy of the
   * descriptions — single source of truth in `CAPABILITY_METADATA`.
   */
  capabilities: CapabilityMetadata[];
  /** Provider/model-specific controls for candidate assignments. Unmatched models remain selectable. */
  modelControls?: Record<string, ModelControls>;
  /** Per-capability values saved for the currently assigned model. */
  modelSettings?: ModelSettingsByRole;
}
