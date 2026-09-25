// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * The slice of `GET /admin/models` the mobile model-management surface renders.
 * Mirrors the gateway's `ModelsOverview` (`packages/gateway/src/models/`), but
 * only the keys the phone needs; the rest (presets, modelsDir, downloads) are
 * dropped by `ignoreUnknownKeys`. Keys are capability roles ("embedder",
 * "agent", "transcriber", "ocr").
 */
@Serializable
data class ModelsOverview(
    /** Per-role display projection (role -> friendly label + brand glyph + state). */
    val assignmentDisplays: Map<String, ModelDisplay> = emptyMap(),
    /** Ordered capability cards (role, title, description, icon slug). */
    val capabilities: List<CapabilityMeta> = emptyList(),
    /** Resolved runtime state: per-role assignment + per-backend status. */
    val inference: InferenceOverview = InferenceOverview(),
    /** All known models (installed GGUFs + remote API entries) - picker options. */
    val catalog: List<CatalogEntry> = emptyList(),
    /** Which GGUF catalog ids are downloaded on the gateway host. */
    val installed: List<ManifestEntry> = emptyList(),
    /**
     * In-flight gateway-side GGUF downloads, each with a live progress snapshot.
     * Empty when nothing is downloading; the local-model list renders a progress
     * bar for the matching catalog id and polls the overview while non-empty.
     * Defaults to empty so an older gateway that omits the key still decodes.
     */
    val activeDownloads: List<ActiveDownload> = emptyList(),
    /**
     * Well-known cloud-provider presets the add-backend grid offers (OpenAI,
     * Groq, …). Each carries the default backend name, URL, optional api-path
     * prefix, and the catalog roles it's typically used for. Defaults to empty
     * so an older gateway that omits the key still decodes.
     */
    val presets: List<ProviderPreset> = emptyList(),
    /** Provider-specific inference controls keyed by the full HTTP assignment. */
    val modelControls: Map<String, ModelControlInfo> = emptyMap(),
    /** Saved behavior for each capability, bound to its current assignment. */
    val modelSettings: Map<String, ModelBehaviorSettings> = emptyMap(),
    /**
     * Recent choices keyed by capability. New gateways include these in the
     * overview so the picker receives its assigned model, controls, and
     * history in one coherent response. Older gateways omit the key and the
     * app falls back to the dedicated recent-models endpoint.
     */
    val recentModels: Map<String, List<RecentModelEntry>> = emptyMap(),
)

/** The catalog-backed options for one backend/model pair. */
@Serializable
data class ModelControlInfo(
    val providerId: String = "",
    val source: String = "unknown",
    val reasoning: Boolean? = null,
    val controls: List<ModelControlDescriptor> = emptyList(),
    val logoUrl: String? = null,
)

/** One dynamic input shown by the model behavior picker. */
@Serializable
data class ModelControlDescriptor(
    val key: String = "",
    val type: String = "",
    val label: String = "",
    val values: List<String> = emptyList(),
    val min: Int? = null,
    val max: Int? = null,
    /** Controls the gateway reports as mutually exclusive with this value. */
    val exclusiveWith: List<String> = emptyList(),
)

/** Current saved values for one capability and the assignment they belong to. */
@Serializable
data class ModelBehaviorSettings(
    val assignment: String? = null,
    val values: ModelBehaviorValues = ModelBehaviorValues(),
)

@Serializable
data class ModelBehaviorValues(
    val reasoningEnabled: Boolean? = null,
    val reasoningEffort: String? = null,
    val reasoningBudgetTokens: Int? = null,
)

/** PATCH /admin/models/behavior/:role body. */
@Serializable
data class SaveModelBehaviorBody(
    val assignment: String,
    val values: ModelBehaviorValues,
    /** Optional for older clients; current mobile editors use a confirmed GET/PATCH baseline. */
    val expectedValues: ModelBehaviorValues? = null,
)

/**
 * One well-known cloud-provider preset from `GET /admin/models` (`presets`).
 * Mirrors `ProviderPreset` in `@omnesis/core/models/provider-presets.ts`: the
 * short id (also the default backend name), the human-readable name, the
 * default base URL, an optional non-`/v1` api-path prefix, optional pre-probe
 * model hints, and the catalog roles (`embed`/`agent`/…) this provider
 * is typically used for. The add-backend grid offers one card per preset to
 * prefill the HTTP-backend form.
 */
@Serializable
data class ProviderPreset(
    /** Short identifier — also the default backend name (e.g. "openai"). */
    val id: String = "",
    /** Human-readable provider name (e.g. "OpenAI"). */
    val name: String = "",
    /** Default base URL (host, without a version path). */
    val defaultUrl: String = "",
    /**
     * Path segment between the base URL and the OpenAI-compatible endpoints
     * (e.g. "/v1beta/openai" for Google); null → the gateway default "/v1".
     */
    val apiPathPrefix: String? = null,
    /** Pre-probe model-id hints (the live `/models` list takes precedence). */
    val knownModels: List<String>? = null,
    /** Catalog roles this provider is typically used for. */
    val capabilities: List<String> = emptyList(),
)

/**
 * One capability card's presentation metadata. Mirrors `CapabilityMetadata` in
 * `@omnesis/core/models/capabilities.ts`.
 */
@Serializable
data class CapabilityMeta(
    val role: String = "",
    val title: String = "",
    val description: String = "",
    val icon: String = "",
    /**
     * Whether this capability only serves an experimental feature. The gateway
     * only sends it in the grid in experimental mode; the card carries an
     * "Experimental" tag. Defaults false for older gateways that omit it.
     */
    val experimental: Boolean = false,
    /**
     * Ordering hint ("core" | "cognition") — core capabilities appear before
     * cognition roles in the unified capability list. Null on older gateways
     * is treated as core.
     */
    val section: String? = null,
)

/** Resolved inference state. Backends keyed by backend key (or "anthropic"). */
@Serializable
data class InferenceOverview(
    val backends: Map<String, BackendStatus> = emptyMap(),
    /** Experimental Codex backend status; present only when the gateway exposes it. */
    val codex: CodexBackendStatus? = null,
    val assignments: Map<String, ResolvedAssignment> = emptyMap(),
)

/**
 * One HTTP / Anthropic backend's probed status. Only the keys the picker + the
 * backends list need are decoded.
 */
@Serializable
data class BackendStatus(
    val type: String = "",
    val status: String = "",
    val url: String? = null,
    val protocol: String? = null,
    val models: List<String>? = null,
    /** Model id -> the capability roles that model can serve (from the probe). */
    val modelRoles: Map<String, List<String>>? = null,
    val hasApiKey: Boolean? = null,
)

/** One Codex model from Codex model discovery. */
@Serializable
data class CodexModelStatus(
    val id: String = "",
    val name: String? = null,
    val description: String? = null,
    val recommended: Boolean? = null,
)

/** Codex runtime source/path/version reported by the gateway. */
@Serializable
data class CodexRuntimeStatus(
    val source: String = "",
    val command: String = "",
    val packageName: String? = null,
    val packageVersion: String? = null,
    val version: String? = null,
    val supported: Boolean = false,
    val reason: String? = null,
)

/** Experimental Codex backend status. Not a user-declared HTTP backend. */
@Serializable
data class CodexBackendStatus(
    val type: String = "codex",
    val configured: Boolean = false,
    val status: String = "",
    val loggedIn: Boolean = false,
    val runtime: CodexRuntimeStatus? = null,
    val models: List<String> = emptyList(),
    val modelDetails: List<CodexModelStatus>? = null,
    val discovery: String? = null,
    val modelRoles: Map<String, List<String>>? = null,
    val reason: String? = null,
    val refreshedAt: String? = null,
)

/** Active Codex device-login flow state. */
@Serializable
data class CodexLoginFlow(
    val id: String = "",
    val status: String = "",
    val verificationUri: String? = null,
    val userCode: String? = null,
    val expiresAt: String? = null,
    val reason: String? = null,
)

@Serializable
data class CodexLoginFlowEnvelope(
    val flow: CodexLoginFlow? = null,
)

@Serializable
data class CodexCancelLoginResult(
    val ok: Boolean = true,
    val canceled: Boolean = false,
    val flow: CodexLoginFlow? = null,
)

@Serializable
data class CodexRemoveResult(
    val ok: Boolean = true,
    val status: CodexBackendStatus = CodexBackendStatus(),
    val clearedAssignments: List<String> = emptyList(),
)

/**
 * A resolved per-role assignment, flattened to the fields the phone needs: the
 * discriminant kind ("local"/"http"/"anthropic"/"replay"/"disabled"/
 * "unresolved"), availability, and the unavailable reason.
 */
@Serializable
data class ResolvedAssignment(
    val kind: String = "",
    val available: Boolean? = null,
    val reason: String? = null,
)

/**
 * One catalog entry (a known model). `kind` is "gguf" or "anthropic-api";
 * `roles` are CATALOG roles ("embed"/"agent"/"transcribe").
 * The GGUF-only fields (`sizeBytes`, `minRamGb`, …) drive the local-model
 * install list's size/RAM labels and system-fit badge; they're absent on
 * `anthropic-api` entries.
 */
@Serializable
data class CatalogEntry(
    val kind: String = "",
    val id: String = "",
    val name: String = "",
    val roles: List<String> = emptyList(),
    /** Approx file size in bytes (gguf only). Drives the "needs N free" label. */
    val sizeBytes: Long? = null,
    /** Hard floor on free RAM in GB (gguf only) — surfaced as a fit warning. */
    val minRamGb: Double? = null,
    /** Recommended free RAM in GB (gguf only). */
    val recommendedRamGb: Double? = null,
    /** Quantization label ("Q4_K_M", "Q8_0", …) for display (gguf only). */
    val quant: String? = null,
    /** Approx parameter count ("1.5B", "137M", …) for display. */
    val params: String? = null,
    /** Recommended for first-time users — surfaced first with a tag. */
    val recommended: Boolean? = null,
)

/**
 * One in-flight gateway-side GGUF download. Mirrors `ActiveDownload` in
 * `packages/gateway/src/models/manager.ts`: the server-assigned `downloadId`,
 * the catalog `modelId` being installed, the filename, and a live progress
 * snapshot. The phone matches it to a catalog row by `modelId`.
 */
@Serializable
data class ActiveDownload(
    val downloadId: String = "",
    val modelId: String = "",
    val filename: String = "",
    val progress: DownloadProgress = DownloadProgress(),
    val startedAt: String = "",
)

/**
 * A download progress snapshot. Mirrors `DownloadProgress` in
 * `packages/gateway/src/models/downloader.ts`. `etaMs` is `-1` when the total
 * size is unknown.
 */
@Serializable
data class DownloadProgress(
    val downloadedBytes: Long = 0,
    val totalBytes: Long = 0,
    val speedBytesPerSec: Long = 0,
    val etaMs: Long = -1,
)

/**
 * Host capacity snapshot from `GET /admin/system-info`. Only the fields the
 * local-model fit badge needs are decoded (free RAM + free model-dir disk);
 * mirrors `SystemInfo` in `packages/gateway/src/system-info.ts`.
 */
@Serializable
data class SystemInfo(
    val totalRamGb: Double = 0.0,
    val freeRamGb: Double = 0.0,
    val modelsDirFreeGb: Double = 0.0,
)

/** `POST /admin/models/install` request body — the catalog id to download. */
@Serializable
data class InstallModelBody(
    val id: String,
)

/** `POST /admin/models/install` reply — the server-assigned download id. */
@Serializable
data class InstallModelReply(
    val ok: Boolean = true,
    val downloadId: String = "",
)

/** `POST /admin/models/cancel-download` request body — the catalog id. */
@Serializable
data class CancelDownloadBody(
    val id: String,
)

/** `POST /admin/models/cancel-download` reply — whether a download was cancelled. */
@Serializable
data class CancelDownloadReply(
    val ok: Boolean = true,
    val cancelled: Boolean = false,
)

/**
 * One installed-manifest entry - just the catalog id, so the picker can tell
 * which GGUFs are downloaded (and thus activatable) on the gateway host.
 */
@Serializable
data class ManifestEntry(
    val id: String = "",
)

/** `POST /admin/models/activate` request body. `role` is the CATALOG role. */
@Serializable
data class ActivateModelBody(
    val id: String,
    val role: String,
    /** Independent assignment target; omitted for legacy gateways/callers. */
    val capability: String? = null,
)

/**
 * `PATCH /admin/config` body for an assign/clear (the portal's assignCapability).
 * The assignment value is a [JsonElement] (`JsonPrimitive` for a model id,
 * `JsonNull` to clear) so the clear case serializes as an explicit
 * `{"<role>": null}` — `OmnesisJson` has `explicitNulls = false`, which would
 * otherwise DROP a `String?` null key and turn a clear into a no-op patch.
 */
@Serializable
data class AssignCapabilityBody(
    val inference: AssignInference,
) {
    @Serializable
    data class AssignInference(
        val assignments: Map<String, JsonElement>,
    )
}

/** Throwaway 2xx envelope for mutations whose response the UI ignores. */
@Serializable
data class OkResponse(
    val ok: Boolean = true,
)

/**
 * `GET /admin/models/recent/:capability` — the "Recently used" picker entries
 * for the capability being configured: deduplicated models recently used for
 * it or a similar capability, the reference's own first. An empty list means
 * the picker hides the section. Mirrors `RecentModelsResult` in
 * `packages/gateway/src/models/recent-models.ts`.
 */
@Serializable
data class RecentModelsResponse(
    val capability: String = "",
    val entries: List<RecentModelEntry> = emptyList(),
)

/**
 * One "Recently used" entry: the raw assignment value, its provider display
 * (brand id + label + friendly model name), and how to apply it. `assign`
 * applies via `PATCH /admin/config` with the raw value; `activate` via
 * `POST /admin/models/activate` with the catalog id + role.
 */
@Serializable
data class RecentModelEntry(
    val assignment: String = "",
    val providerId: String = "",
    val providerLabel: String = "",
    val modelName: String = "",
    val apply: RecentModelApply = RecentModelApply(),
)

/**
 * How to apply a [RecentModelEntry]. Kept flat (nullable per-type fields)
 * instead of a polymorphic hierarchy so no custom serializer is needed:
 * `type` is "assign" (with `value`) or "activate" (with `catalogId` +
 * `catalogRole`).
 */
@Serializable
data class RecentModelApply(
    val type: String = "",
    val value: String? = null,
    val catalogId: String? = null,
    val catalogRole: String? = null,
)

/**
 * `PATCH /admin/config` body for adding (or replacing) a named HTTP inference
 * backend — `{inference:{backends:{<key>:{type:"http",url,apiKey?,apiPathPrefix?}}}}`.
 * The backends map has a dynamic key (the backend name). `apiKey` is write-only:
 * it's sent here but never read back (the gateway only ever surfaces a
 * `hasApiKey` bool), so it is never rendered or logged.
 */
@Serializable
data class AddBackendBody(
    val inference: AddBackendInference,
) {
    @Serializable
    data class AddBackendInference(
        val backends: Map<String, HttpBackendConfig>,
    )

    @Serializable
    data class HttpBackendConfig(
        // `type` is declared first and WITHOUT a default so it's always on the
        // wire: `OmnesisJson` has `encodeDefaults = false` (its default), which
        // would drop a defaulted `type` and the gateway's zod requires it.
        val type: String,
        val url: String,
        val apiKey: String? = null,
        val apiPathPrefix: String? = null,
    )
}

/**
 * `PATCH /admin/config` body for removing an HTTP backend — sets the key to an
 * explicit `null`. The value is a [JsonElement] (`JsonNull`) so the remove
 * serializes as `{"<key>": null}`; `OmnesisJson` has `explicitNulls = false`,
 * which would otherwise DROP a `String?` null key and turn a remove into a
 * no-op patch.
 */
@Serializable
data class RemoveBackendBody(
    val inference: RemoveBackendInference,
) {
    @Serializable
    data class RemoveBackendInference(
        val backends: Map<String, JsonElement>,
    )
}

/**
 * Result of `POST /admin/inference/backends/:key/probe`. Mirrors the route's
 * envelope in `packages/gateway/src/models/routes.ts`: `ok` is true when the
 * backend answered its `/v1/models` probe, `status` is "ok"/"unreachable",
 * `models` is the served-model list, and `reason` carries the failure text
 * when unreachable.
 */
@Serializable
data class BackendProbeResult(
    val ok: Boolean = false,
    val status: String = "",
    val models: List<String> = emptyList(),
    val reason: String? = null,
)

/**
 * `POST /admin/inference/backends/:key/verify` body. `model` + `role` are
 * required (the verifiable role: embedder/agent/privacy-reviewer); `force`
 * bypasses the gateway's per-(backend, model, role) verdict cache. `force`
 * defaults to false and `OmnesisJson` has `encodeDefaults = false`, so a
 * non-forced verify simply omits it (the gateway treats a missing `force` as
 * false) — only a forced re-verify (a non-default `true`) reaches the wire.
 */
@Serializable
data class VerifyBackendBody(
    val model: String,
    val role: String,
    val force: Boolean = false,
)

/**
 * Result of `POST /admin/inference/backends/:key/verify` — the behavioral
 * verdict for one (backend, model, role). Mirrors `CapabilityVerdict` in
 * `@omnesis/core`: `supported` is true when the backend served the role's
 * minimal capability call, and `detail` is a one-line human-readable
 * explanation (endpoint hit, embedding dim, or the upstream error text).
 */
@Serializable
data class CapabilityVerdict(
    val role: String = "",
    val model: String = "",
    val supported: Boolean = false,
    val detail: String = "",
)

/**
 * One row of `GET /admin/model-credentials` — a model-provider credential entry.
 * Mirrors `ModelCredentialEntry` in `packages/gateway/src/model-credentials.ts`:
 * the stable `fileKey`, the provider's type/name, the field spec the form
 * renders, and whether credentials are currently configured. No secret value is
 * ever included — only `configured`.
 */
@Serializable
data class ModelCredentialEntry(
    val fileKey: String = "",
    val providerType: String = "",
    val providerName: String = "",
    val spec: CredentialSpec = CredentialSpec(),
    val configured: Boolean = false,
)

/**
 * The JSON-safe credential spec from a provider entry. Only the `fields` the
 * credential form renders are decoded; the setup `wizard` blob is dropped by
 * `ignoreUnknownKeys` (the phone shows a compact inline form, not the full
 * CLI/portal wizard). Mirrors `SerializedProviderCredentialsSpec` in
 * `@omnesis/core`.
 */
@Serializable
data class CredentialSpec(
    val fields: List<CredentialField> = emptyList(),
)

/**
 * One field a provider's credentials require (e.g. `apiKey`). Mirrors
 * `ProviderCredentialsField` in `@omnesis/core`. `secret` fields render as
 * masked inputs and their values are never read back or logged.
 */
@Serializable
data class CredentialField(
    val name: String = "",
    val label: String = "",
    val placeholder: String? = null,
    val secret: Boolean? = null,
    val pattern: String? = null,
    val patternHint: String? = null,
)

/** `POST /admin/model-credentials/:fileKey` request body — the field map. */
@Serializable
data class SetModelCredentialsBody(
    val fields: Map<String, String>,
)
