// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Provider labels for inference surfaces. Provider logos are retrieved from
 * Models.dev by the gateway and served to clients through /model-logos/:id.svg.
 * Non-cloud runtimes use a neutral client glyph.
 */

import { assertNever } from "../utils.js";
import { getPreset } from "./provider-presets.js";
import type { ResolvedAssignment } from "./backends.js";

export interface ProviderBrand {
  /** Stable provider identity carried on the wire. */
  id: string;
  /** Human-readable fallback label. */
  label: string;
}

/** Labels for preset providers and non-cloud runtime fallbacks. */
export const PROVIDER_BRANDS: Readonly<Record<string, ProviderBrand>> = {
  anthropic: { id: "anthropic", label: "Anthropic" },
  openai: { id: "openai", label: "OpenAI" },
  google: { id: "google", label: "Google Gemini" },
  mistral: { id: "mistral", label: "Mistral" },
  groq: { id: "groq", label: "Groq" },
  cerebras: { id: "cerebras", label: "Cerebras" },
  together: { id: "together", label: "Together AI" },
  fireworks: { id: "fireworks", label: "Fireworks AI" },
  deepseek: { id: "deepseek", label: "DeepSeek" },
  nvidia: { id: "nvidia", label: "NVIDIA" },
  xai: { id: "xai", label: "xAI" },
  meta: { id: "meta", label: "Meta" },
  moonshot: { id: "moonshot", label: "Moonshot AI" },
  openrouter: { id: "openrouter", label: "OpenRouter" },
  ollama: { id: "ollama", label: "Ollama" },
  local: { id: "local", label: "Local" },
  replay: { id: "replay", label: "Replay" },
  codex: { id: "codex", label: "Codex" },
  http: { id: "http", label: "HTTP" },
  none: { id: "none", label: "Not configured" },
};

/** Look up a brand by id; `none` if unknown so callers never get undefined. */
export function getProviderBrand(id: string): ProviderBrand {
  return PROVIDER_BRANDS[id] ?? PROVIDER_BRANDS.none;
}

/**
 * Display projection of a resolved capability assignment — what the UI
 * shows for "which model is configured for this role". Computed
 * server-side and shipped to portal/iOS so neither has to know how to
 * map a raw model id to a friendly name or a provider brand.
 */
export interface ModelDisplay {
  /** Provider brand id (a `PROVIDER_BRANDS` key). */
  providerId: string;
  /** Human-readable provider label, from the brand registry. */
  providerLabel: string;
  /** Friendly model name (catalog display name, else the raw model id). */
  modelName: string;
  /** Whether the assignment is currently usable (file present / key set). */
  available: boolean;
  /** True when nothing is configured for this role (disabled/unresolved). */
  configured: boolean;
}

/**
 * Resolve the provider brand id for an HTTP backend. An HTTP backend
 * added from a preset keeps the preset id as its key by default, so a
 * direct key→preset lookup covers the common case; we fall back to the
 * generic `http` brand for user-renamed or ad-hoc backends.
 */
function httpProviderId(backendKey: string): string {
  const preset = getPreset(backendKey);
  if (preset && PROVIDER_BRANDS[preset.id]) return preset.id;
  return "http";
}

/**
 * Project a `ResolvedAssignment` into a `ModelDisplay`. Pure and
 * source-agnostic: it reads the discriminated union and the catalog
 * entry the registry already attached, never branching on a specific
 * model id. The single place that knows how to turn an assignment into
 * a provider+model label for any surface.
 */
export function resolveModelDisplay(assignment: ResolvedAssignment): ModelDisplay {
  switch (assignment.kind) {
    case "anthropic": {
      const brand = getProviderBrand("anthropic");
      return {
        providerId: brand.id,
        providerLabel: brand.label,
        modelName: assignment.catalogEntry?.name ?? assignment.apiModelId,
        available: assignment.available,
        configured: true,
      };
    }
    case "local": {
      const brand = getProviderBrand("local");
      return {
        providerId: brand.id,
        providerLabel: brand.label,
        modelName: assignment.catalogEntry?.name ?? assignment.catalogId,
        available: assignment.available,
        configured: true,
      };
    }
    case "http": {
      const brand = getProviderBrand(httpProviderId(assignment.backendKey));
      const catalogProvider =
        assignment.modelControls?.source === "models.dev" ? assignment.modelControls : undefined;
      return {
        providerId: catalogProvider?.providerId ?? brand.id,
        providerLabel: catalogProvider?.providerName ?? brand.label,
        modelName: assignment.model,
        available: assignment.available,
        configured: true,
      };
    }
    case "replay": {
      const brand = getProviderBrand("replay");
      return {
        providerId: brand.id,
        providerLabel: brand.label,
        modelName: assignment.fixture ?? "replay",
        available: true,
        configured: true,
      };
    }
    case "codex": {
      const brand = getProviderBrand("codex");
      return {
        providerId: brand.id,
        providerLabel: brand.label,
        modelName: assignment.model,
        available: assignment.available,
        configured: true,
      };
    }
    case "disabled":
    case "unresolved": {
      const brand = getProviderBrand("none");
      return {
        providerId: brand.id,
        providerLabel: brand.label,
        modelName: "",
        available: false,
        configured: false,
      };
    }
    default:
      return assertNever(assignment);
  }
}
