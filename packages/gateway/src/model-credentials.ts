// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-host credentials registry.
 *
 * Mirrors the collector's per-source credentials registry
 * (`packages/collector/src/source-ws-handlers.ts:listCredentialEntries`)
 * but for *model-provider* credentials (Anthropic and TypeSafe). Lives on
 * the gateway because the gateway is the process that makes these API calls;
 * in multi-host deployments,
 * model-provider credentials must reside on the gateway host even when
 * sources reside on a remote collector.
 *
 * File format, atomic write, and 0600 perms are reused from
 * `@omnesis/core`'s shared `readProviderCredentials` /
 * `writeProviderCredentials` helpers — same shape as source-credentials
 * files, just persisted under a different fileKey on a different host.
 */
import {
  ANTHROPIC_CREDENTIALS_SPEC,
  TYPESAFE_CREDENTIALS_SPEC,
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
  /** Environment variables that supply the key ahead of the file, in precedence order. */
  envVars: readonly string[];
}> = [
  {
    spec: ANTHROPIC_CREDENTIALS_SPEC,
    providerType: "anthropic",
    providerName: "Anthropic",
    envVars: ["OMNESIS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
  },
  {
    spec: TYPESAFE_CREDENTIALS_SPEC,
    providerType: "typesafe",
    providerName: "TypeSafe",
    envVars: ["OMNESIS_TYPESAFE_API_KEY", "TYPESAFE_API_KEY"],
  },
];

export interface ModelCredentialEntry {
  fileKey: string;
  providerType: string;
  providerName: string;
  spec: SerializedProviderCredentialsSpec;
  /** A key is stored in the gateway-host credentials file. */
  configured: boolean;
  /** A key is supplied by the gateway process's environment (it wins over the file). */
  environment: boolean;
}

/** All model-provider credential entries plus current configured-state. */
export function listModelCredentialEntries(configDir: string): ModelCredentialEntry[] {
  return MODEL_PROVIDER_SPECS.map(({ spec, providerType, providerName, envVars }) => ({
    fileKey: spec.fileKey,
    providerType,
    providerName,
    spec: serializeCredentialsSpec(spec),
    configured: hasProviderCredentials(spec.fileKey, configDir),
    environment: envVars.some((name) => (process.env[name]?.trim() ?? "") !== ""),
  }));
}

/** Look up a spec by fileKey for server-side validation. */
export function getModelProviderSpec(fileKey: string): ProviderCredentialsSpec | null {
  return MODEL_PROVIDER_SPECS.find((e) => e.spec.fileKey === fileKey)?.spec ?? null;
}

/** The first non-empty environment value among a provider's key variables. */
function envApiKey(fileKey: string): string | null {
  const entry = MODEL_PROVIDER_SPECS.find((e) => e.spec.fileKey === fileKey);
  for (const name of entry?.envVars ?? []) {
    const apiKey = process.env[name]?.trim();
    if (apiKey) return apiKey;
  }
  return null;
}

/**
 * Synchronous read of the Anthropic API key from the credentials file
 * for hot-path callers (expansion loader, model resolver). Returns null
 * if the file is absent or malformed. Sync IO is fine here — the file
 * is tiny and only read at provider-init / availability-check time, not
 * per-request.
 */
export function readAnthropicApiKey(configDir: string): string | null {
  return readProviderApiKey(ANTHROPIC_CREDENTIALS_SPEC.fileKey, configDir);
}

function readProviderApiKey(fileKey: string, configDir: string): string | null {
  const path = providerCredentialsPath(fileKey, configDir);
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
  const envKey = envApiKey(ANTHROPIC_CREDENTIALS_SPEC.fileKey);
  if (envKey) return { apiKey: envKey, source: "environment" };
  const fileKey = readAnthropicApiKey(configDir)?.trim();
  return fileKey ? { apiKey: fileKey, source: "file" } : null;
}

/** True iff a usable Anthropic key is available to the gateway process. */
export function hasAnthropicApiKey(configDir: string): boolean {
  return resolveAnthropicApiKey(configDir) !== null;
}

/**
 * Resolve the effective TypeSafe key: `OMNESIS_TYPESAFE_API_KEY`, then the
 * standard `TYPESAFE_API_KEY` the TypeSafe SDKs read, then the gateway-host
 * credentials file written from Settings → Models.
 */
export function resolveTypeSafeApiKey(configDir: string): string | null {
  return (
    envApiKey(TYPESAFE_CREDENTIALS_SPEC.fileKey) ??
    (readProviderApiKey(TYPESAFE_CREDENTIALS_SPEC.fileKey, configDir)?.trim() || null)
  );
}

/** True iff a usable TypeSafe key is available to the gateway process. */
export function hasTypeSafeApiKey(configDir: string): boolean {
  return resolveTypeSafeApiKey(configDir) !== null;
}
