// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Well-known cloud inference providers with OpenAI-compatible APIs.
 * Used by the portal and CLI to auto-fill backend URLs when adding a new
 * HTTP backend. Presets deliberately carry no model ids: model suggestions
 * come only from a backend's live `/models` probe, so the UI shows nothing
 * rather than a potentially stale hardcoded list.
 */

export interface ProviderPreset {
  /** Short identifier used as the default backend name. */
  id: string;
  /** Models.dev provider ID when it differs from the Omnesis preset ID. */
  modelsDevId?: string;
  /** Human-readable provider name. */
  name: string;
  /** Default base URL for the OpenAI-compatible API (host, without a version path). */
  defaultUrl: string;
  /**
   * Path segment between the base URL and the OpenAI-compatible endpoints,
   * carried onto the backend config when added from this preset. Defaults to
   * `"/v1"` when unset; set it when the provider's compat surface lives under a
   * non-`/v1` path (e.g. Gemini's `"/v1beta/openai"`).
   */
  apiPathPrefix?: string;
  /** Capability roles this provider is typically used for. */
  capabilities: readonly string[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    defaultUrl: "https://api.openai.com",
    capabilities: ["agent", "embed"],
  },
  {
    id: "groq",
    name: "Groq",
    defaultUrl: "https://api.groq.com/openai",
    capabilities: ["agent"],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    defaultUrl: "https://api.cerebras.ai",
    capabilities: ["agent"],
  },
  {
    id: "together",
    modelsDevId: "togetherai",
    name: "Together AI",
    defaultUrl: "https://api.together.xyz",
    capabilities: ["agent", "embed"],
  },
  {
    id: "fireworks",
    modelsDevId: "fireworks-ai",
    name: "Fireworks AI",
    defaultUrl: "https://api.fireworks.ai/inference",
    capabilities: ["agent", "embed"],
  },
  {
    id: "mistral",
    name: "Mistral",
    defaultUrl: "https://api.mistral.ai",
    capabilities: ["agent", "embed"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    defaultUrl: "https://api.deepseek.com",
    capabilities: ["agent"],
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    defaultUrl: "https://integrate.api.nvidia.com",
    capabilities: ["agent"],
  },
  {
    id: "google",
    name: "Google AI (Gemini)",
    // Gemini's OpenAI-compatible surface lives at `…/v1beta/openai`, NOT under
    // `/v1`. The base URL is the bare host; `apiPathPrefix` carries the version
    // path so consumers build `…/v1beta/openai/chat|embeddings|models`.
    defaultUrl: "https://generativelanguage.googleapis.com",
    apiPathPrefix: "/v1beta/openai",
    capabilities: ["agent", "embed"],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    // Standard OpenAI-compatible surface under `/v1`; "change the base_url and
    // api_key" and the OpenAI SDK works unmodified. No embedding models are
    // offered, so no `embed` capability.
    defaultUrl: "https://api.x.ai",
    capabilities: ["agent"],
  },
  {
    id: "meta",
    name: "Meta (Muse Spark)",
    // Meta Model API — the OpenAI-compatible Chat Completions surface for the
    // Muse Spark models, under `/v1`. (Distinct from the older Llama API at
    // `api.llama.com/compat/v1`.) No first-party embedding models, so no
    // `embed` capability.
    defaultUrl: "https://api.meta.ai",
    capabilities: ["agent"],
  },
  {
    id: "moonshot",
    modelsDevId: "moonshotai",
    name: "Moonshot AI (Kimi)",
    // Kimi Open Platform — OpenAI-compatible Chat Completions under `/v1`; set
    // the base URL + key and the OpenAI SDK works unmodified. No embedding
    // models are offered, so no `embed` capability.
    defaultUrl: "https://api.moonshot.ai",
    capabilities: ["agent"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    // Aggregator — one key routes to many upstream providers. The OpenAI
    // compatible surface lives under `/api/v1`, so the base URL carries the
    // `/api` path segment and the default `/v1` prefix completes it. No
    // embeddings endpoint is offered, so no `embed` capability.
    defaultUrl: "https://openrouter.ai/api",
    capabilities: ["agent"],
  },
];

/** Look up a provider preset by its short id. */
export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
