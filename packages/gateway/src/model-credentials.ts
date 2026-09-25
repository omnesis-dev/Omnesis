// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-host credentials registry.
 *
 * Mirrors the collector's per-source credentials registry
 * (`packages/collector/src/source-ws-handlers.ts:listCredentialEntries`)
 * but for *model-provider* credentials — Anthropic today, OpenAI / Mistral
 * later. Lives on the gateway because the gateway is the process that
 * makes these API calls; in multi-host deployments, model-provider
 * credentials must reside on the gateway host even when sources reside
 * on a remote collector.
 *
 * File format, atomic write, and 0600 perms are reused from
 * `@omnesis/core`'s shared `readProviderCredentials` /
 * `writeProviderCredentials` helpers — same shape as source-credentials
 * files, just persisted under a different fileKey on a different host.
 */
import {
  ANTHROPIC_CREDENTIALS_SPEC,
  hasProviderCredentials,
  providerCredentialsPath,
  readSecretTextFileSync,
  serializeCredentialsSpec,
  type ProviderCredentialsSpec,
  type SerializedProviderCredentialsSpec,
} from "@omnesis/core";

/**
 * The set of model-provider credential specs known to the gateway.
 * Adding a new provider is a one-line append once its spec is defined.
 */
const MODEL_PROVIDER_SPECS: ReadonlyArray<{
  spec: ProviderCredentialsSpec;
  providerType: string;
  providerName: string;
}> = [
  {
    spec: ANTHROPIC_CREDENTIALS_SPEC,
    providerType: "anthropic",
    providerName: "Anthropic",
  },
];

export interface ModelCredentialEntry {
  fileKey: string;
  providerType: string;
  providerName: string;
  spec: SerializedProviderCredentialsSpec;
  configured: boolean;
}

/** All model-provider credential entries plus current configured-state. */
export function listModelCredentialEntries(configDir: string): ModelCredentialEntry[] {
  return MODEL_PROVIDER_SPECS.map(({ spec, providerType, providerName }) => ({
    fileKey: spec.fileKey,
    providerType,
    providerName,
    spec: serializeCredentialsSpec(spec),
    configured: hasProviderCredentials(spec.fileKey, configDir),
  }));
}

/** Look up a spec by fileKey for server-side validation. */
export function getModelProviderSpec(fileKey: string): ProviderCredentialsSpec | null {
  return MODEL_PROVIDER_SPECS.find((e) => e.spec.fileKey === fileKey)?.spec ?? null;
}

/**
 * Synchronous read of the Anthropic API key from the credentials file
 * for hot-path callers (expansion loader, model resolver). Returns null
 * if the file is absent or malformed. Sync IO is fine here — the file
 * is tiny and only read at provider-init / availability-check time, not
 * per-request.
 */
export function readAnthropicApiKey(configDir: string): string | null {
  const path = providerCredentialsPath(ANTHROPIC_CREDENTIALS_SPEC.fileKey, configDir);
  try {
    const raw = readSecretTextFileSync(path, { configDir });
    if (raw === null) return null;
    const json = JSON.parse(raw) as Record<string, unknown>;
    const v = json.apiKey;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective Anthropic key using the same precedence as every
 * gateway runtime: Omnesis-specific env, standard Anthropic env, then the
 * gateway-host credentials file.
 */
export function resolveAnthropicApiKey(configDir: string): string | null {
  return resolveAnthropicCredential(configDir)?.apiKey ?? null;
}

export interface ResolvedAnthropicCredential {
  apiKey: string;
  source: "environment" | "file";
}

/** Resolve both the effective key and its operator-visible source. */
export function resolveAnthropicCredential(configDir: string): ResolvedAnthropicCredential | null {
  for (const value of [process.env.OMNESIS_ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY]) {
    const apiKey = value?.trim();
    if (apiKey) return { apiKey, source: "environment" };
  }
  const fileKey = readAnthropicApiKey(configDir)?.trim();
  return fileKey ? { apiKey: fileKey, source: "file" } : null;
}

/** True iff a usable Anthropic key is available to the gateway process. */
export function hasAnthropicApiKey(configDir: string): boolean {
  return resolveAnthropicApiKey(configDir) !== null;
}
