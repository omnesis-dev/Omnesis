// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Anthropic API-key credentials spec.
 *
 * Model-provider credentials live on the **gateway host** (the gateway
 * makes the API calls), not on the collector. They share the same file
 * format and helpers as source credentials — a JSON file at
 * `${OMNESIS_CONFIG_DIR}/anthropic-credentials.json` with mode 0600 — but
 * are surfaced via `/admin/model-credentials/*` (gateway-local) instead
 * of `/admin/credentials/*` (which proxies to the collector).
 */
import type { ProviderCredentialsSpec } from "../credentials.js";

export const ANTHROPIC_CREDENTIALS_SPEC: ProviderCredentialsSpec = {
  fileKey: "anthropic",
  required: true,
  fields: [
    {
      name: "apiKey",
      label: "API Key",
      placeholder: "sk-ant-…",
      secret: true,
      pattern: "^sk-ant-[A-Za-z0-9_-]+$",
      patternHint:
        "API keys start with sk-ant- followed by letters, numbers, dashes or underscores.",
    },
  ],
  wizard: {
    intro:
      "Configure an Anthropic API key so the gateway can assign Claude models to its reasoning capabilities.",
    why: "A key unlocks the Claude models in the Agent capability — the model that answers questions over your corpus and runs Deep Research — and in every capability that offers the same model choices: the privacy reviewer, the background agent, the entailment verifier and the brief judge. A local GGUF or your own OpenAI-compatible server is the alternative if you'd rather keep everything offline.",
    estMinutes: 1,
    steps: [
      {
        kind: "open-url",
        title: "Create an API key",
        body: "Sign in to the Anthropic console and create a new API key under Settings → API Keys. Copy the key — you'll only see it once.",
        url: "https://console.anthropic.com/settings/keys",
      },
    ],
  },
};
