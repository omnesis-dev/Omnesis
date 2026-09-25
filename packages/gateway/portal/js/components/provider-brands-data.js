// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Provider labels for portal fallback copy. This mirrors the canonical core
 * registry (`packages/core/src/models/provider-brands.ts`); logos live in the
 * Models.dev catalog and are served by the gateway at `/model-logos/:id.svg`.
 */
export const PORTAL_PROVIDER_BRANDS = {
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
