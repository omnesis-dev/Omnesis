// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Model management — public exports.
 *
 * Architecture:
 *   - `capabilities.ts` — consumer-facing capability interfaces
 *                         (EmbedCapability, CompleteCapability, …).
 *   - `backends.ts`     — backend types, assignment types, resolved state.
 *   - `types.ts`        — discriminated unions for catalog/manifest entries.
 *   - `catalog.ts`      — bundled list of vetted models.
 *   - `manifest.ts`     — `<modelsDir>/manifest.json` reader/writer.
 *
 * The gateway-side InferenceRegistry (`packages/gateway/src/inference/`)
 * resolves config into concrete capability instances. The ModelManager
 * (`packages/gateway/src/models/manager.ts`) handles GGUF lifecycle
 * (download, install, uninstall, doctor).
 */

export type {
  ModelRole,
  CatalogEntry,
  GgufCatalogEntry,
  AnthropicCatalogEntry,
  Manifest,
  ManifestEntry,
  ModelsOverview,
} from "./types.js";

export { MODEL_ROLES, CATALOG_ROLE_CAPABILITY } from "./types.js";

export type {
  ModelControlKey,
  ModelControlDescriptor,
  ModelBehaviorValues,
  ModelControls,
  ModelSettings,
  ModelSettingsByRole,
} from "./model-behavior.js";

export type {
  EmbedCapability,
  CompleteCapability,
  TranscribeCapability,
  TranscriptionResult,
  OcrCapability,
  OcrResult,
  EntailCapability,
  EntailVerdict,
  CapabilityRole,
  CapabilityMetadata,
} from "./capabilities.js";

export { CAPABILITY_ROLES, CODEX_SUPPORTED_ROLES, CAPABILITY_METADATA } from "./capabilities.js";

export type {
  BackendType,
  ModelTokenLimits,
  HttpBackendConfig,
  AgentProtocol,
  AssignmentValue,
  ResolvedAssignment,
  ResolvedLocal,
  OcrNativeRuntime,
  ResolvedHttp,
  CapabilityVerdict,
  ResolvedAnthropic,
  ResolvedDisabled,
  ResolvedUnresolved,
  ResolvedReplay,
  ResolvedCodex,
  BackendStatus,
  CodexBackendStatus,
  CodexLoginFlow,
  CodexModelStatus,
  CodexRuntimeStatus,
  CodexRuntimeUpdateOperation,
  CodexRuntimeUpdateOperationState,
  CodexRuntimeUpdatePlan,
  CodexRuntimeUpdateSnapshot,
  InferenceOverview,
  InferenceConfig,
  DegradedRole,
  ConfigHealth,
} from "./backends.js";

export {
  normalizeApiPathPrefix,
  extractModelIds,
  CLOUD_EGRESS_DISABLED_REASON,
} from "./backends.js";

export {
  InferenceUrlPolicyError,
  assertInferenceUrlAllowed,
  classifyInferenceIp,
  fetchWithInferenceUrlPolicy,
} from "./inference-url-policy.js";

export type {
  InferenceAddressClass,
  InferenceFetchPolicy,
  InferenceUrlPolicy,
} from "./inference-url-policy.js";

export {
  CATALOG,
  catalogForRole,
  defaultForRole,
  getCatalogEntry,
  getCatalogEntryByFilename,
} from "./catalog.js";

export {
  loadManifest,
  saveManifest,
  upsertManifestEntry,
  removeManifestEntry,
  findManifestEntry,
  findManifestEntryByFilename,
} from "./manifest.js";

export type { LoadResult } from "./manifest.js";

export { ANTHROPIC_CREDENTIALS_SPEC } from "./anthropic-credentials.js";

export type { ProviderPreset } from "./provider-presets.js";
export { PROVIDER_PRESETS, getPreset } from "./provider-presets.js";

export {
  BACKGROUND_RATE_LIMIT_PATIENCE,
  rateLimitRetryDelayMs,
  retryRateLimitedRequest,
  type RateLimitPatience,
} from "./http-rate-limit-retry.js";
export type { HttpRateLimitRetryOptions } from "./http-rate-limit-retry.js";

export type { ProviderBrand, ModelDisplay } from "./provider-brands.js";
export { PROVIDER_BRANDS, getProviderBrand, resolveModelDisplay } from "./provider-brands.js";

export { classifyModelRoles, classifyModels } from "./model-roles.js";

export { fuzzyMatchModelId } from "./fuzzy-match.js";

export {
  MAX_RECENT_MODELS_PER_ROLE,
  siblingRolesForRecentModels,
  mergeRecentCandidates,
  recordRecentHistory,
} from "./recent-models.js";
export type {
  RecentModelHistory,
  RecentModelCurrent,
  RecentModelCandidate,
} from "./recent-models.js";
