// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Wire types for the gateway's models surface — `/admin/models`, inference
// backends, provider credentials and the local model lifecycle — decoded by
// `AdminClient` and rendered by the Models screen.

/// Display projection of a resolved model assignment — what the UI
/// shows for "which model is configured for this role" / "which model
/// answers now". Computed server-side via `resolveModelDisplay`; mirrors
/// `ModelDisplay` in `@omnesis/core/models/provider-brands.ts`. Served
/// by `GET /agent/model` (current agent model) and inside the
/// `assignmentDisplays` map of `GET /admin/models`.
public struct ModelDisplay: Decodable, Equatable, Sendable {
    /// Provider brand id (a `PROVIDER_BRANDS` key) — drives `ProviderIcon`.
    public let providerId: String
    /// Human-readable provider label, from the brand registry.
    public let providerLabel: String
    /// Friendly model name (catalog display name, else the raw model id).
    public let modelName: String
    /// Whether the assignment is currently usable (file present / key set).
    public let available: Bool
    /// True when something is configured for this role; false when the
    /// role is unresolved / disabled.
    public let configured: Bool

    public init(
        providerId: String,
        providerLabel: String,
        modelName: String,
        available: Bool,
        configured: Bool
    ) {
        self.providerId = providerId
        self.providerLabel = providerLabel
        self.modelName = modelName
        self.available = available
        self.configured = configured
    }
}

/// The slice of `GET /admin/models` the mobile model-management surface decodes.
/// Mirrors the gateway's `ModelsOverview` (`packages/gateway/src/models/`), but
/// only the keys the phone renders; the rest (presets, modelsDir, downloads) are
/// ignored by `JSONDecoder`'s default lenient behaviour.
public struct ModelsOverview: Decodable, Equatable, Sendable {
    /// Per-role display projection (role → friendly label + brand glyph + state).
    public let assignmentDisplays: [String: ModelDisplay]
    /// Ordered capability cards (role, title, description, icon slug).
    public let capabilities: [CapabilityMeta]
    /// Resolved runtime state: per-role assignment + per-backend status.
    public let inference: InferenceOverview
    /// All known models (installed GGUFs + remote API entries) — picker options.
    public let catalog: [CatalogEntry]
    /// Which GGUF catalog ids are downloaded on the gateway host.
    public let installed: [ManifestEntry]
    /// In-flight gateway-side GGUF downloads (each with a live progress snapshot).
    /// Empty when nothing is downloading; the local-model list renders a progress
    /// bar for the matching catalog id and polls the overview while non-empty.
    public let activeDownloads: [ActiveDownload]
    /// Well-known cloud-provider presets the add-backend grid offers (OpenAI,
    /// Groq, …). Each carries the default backend name, URL, optional api-path
    /// prefix, and the catalog roles it's typically used for.
    public let presets: [ProviderPreset]
    /// Models.dev controls keyed by the full active assignment (`backend/model`).
    /// Unknown models have no controls but remain available in the picker.
    public let modelControls: [String: ModelControls]
    /// Saved inference behavior for each capability role.
    public let modelSettings: [String: ModelSettings]

    public init(
        assignmentDisplays: [String: ModelDisplay],
        capabilities: [CapabilityMeta],
        inference: InferenceOverview,
        catalog: [CatalogEntry],
        installed: [ManifestEntry],
        activeDownloads: [ActiveDownload] = [],
        presets: [ProviderPreset] = [],
        modelControls: [String: ModelControls] = [:],
        modelSettings: [String: ModelSettings] = [:]
    ) {
        self.assignmentDisplays = assignmentDisplays
        self.capabilities = capabilities
        self.inference = inference
        self.catalog = catalog
        self.installed = installed
        self.activeDownloads = activeDownloads
        self.presets = presets
        self.modelControls = modelControls
        self.modelSettings = modelSettings
    }

    /// `activeDownloads` and `presets` are decoded leniently: an older gateway
    /// omits those keys, so they default to empty rather than failing the whole
    /// overview decode.
    private enum CodingKeys: String, CodingKey {
        case assignmentDisplays, capabilities, inference, catalog, installed, activeDownloads, presets,
             modelControls, modelSettings
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        assignmentDisplays = try container.decode([String: ModelDisplay].self, forKey: .assignmentDisplays)
        capabilities = try container.decode([CapabilityMeta].self, forKey: .capabilities)
        inference = try container.decode(InferenceOverview.self, forKey: .inference)
        catalog = try container.decode([CatalogEntry].self, forKey: .catalog)
        installed = try container.decode([ManifestEntry].self, forKey: .installed)
        activeDownloads = try container.decodeIfPresent([ActiveDownload].self, forKey: .activeDownloads) ?? []
        presets = try container.decodeIfPresent([ProviderPreset].self, forKey: .presets) ?? []
        modelControls = try container.decodeIfPresent([String: ModelControls].self, forKey: .modelControls) ?? [:]
        modelSettings = try container.decodeIfPresent([String: ModelSettings].self, forKey: .modelSettings) ?? [:]
    }
}

/// One editable setting the gateway has derived from provider/model metadata.
/// The gateway validates values at save time, including range bounds.
public struct ModelControl: Decodable, Equatable, Sendable, Identifiable {
    public let key: String
    public let type: String
    public let label: String
    public let values: [String]?
    public let min: Int?
    public let max: Int?
    /// Keys that cannot be set at the same time as this control.
    public let exclusiveWith: [String]?
    public var id: String {
        key
    }

    public init(
        key: String,
        type: String,
        label: String,
        values: [String]? = nil,
        min: Int? = nil,
        max: Int? = nil,
        exclusiveWith: [String]? = nil
    ) {
        self.key = key
        self.type = type
        self.label = label
        self.values = values
        self.min = min
        self.max = max
        self.exclusiveWith = exclusiveWith
    }
}

public struct ModelControls: Decodable, Equatable, Sendable {
    public let providerId: String
    public let source: String
    public let reasoning: Bool?
    public let controls: [ModelControl]
    public let logoUrl: String?

    public init(
        providerId: String,
        source: String,
        reasoning: Bool?,
        controls: [ModelControl],
        logoUrl: String? = nil
    ) {
        self.providerId = providerId
        self.source = source
        self.reasoning = reasoning
        self.controls = controls
        self.logoUrl = logoUrl
    }
}

/// Optional fields preserve the backend's default when left unset.
public struct ModelBehaviorValues: Codable, Equatable, Sendable {
    public var reasoningEnabled: Bool?
    public var reasoningEffort: String?
    public var reasoningBudgetTokens: Int?

    public init(
        reasoningEnabled: Bool? = nil,
        reasoningEffort: String? = nil,
        reasoningBudgetTokens: Int? = nil
    ) {
        self.reasoningEnabled = reasoningEnabled
        self.reasoningEffort = reasoningEffort
        self.reasoningBudgetTokens = reasoningBudgetTokens
    }
}

public struct ModelSettings: Decodable, Equatable, Sendable {
    public let assignment: String?
    public let values: ModelBehaviorValues

    public init(assignment: String?, values: ModelBehaviorValues) {
        self.assignment = assignment
        self.values = values
    }
}

/// One well-known cloud-provider preset from `GET /admin/models` (`presets`).
/// Mirrors `ProviderPreset` in `@omnesis/core/models/provider-presets.ts`: the
/// short id (also the default backend name), the human-readable name, the
/// default base URL, an optional non-`/v1` api-path prefix, optional pre-probe
/// model hints, and the catalog roles (`embed`/`agent`/…) this
/// provider is typically used for. The add-backend grid offers one card per
/// preset to prefill the HTTP-backend form.
public struct ProviderPreset: Decodable, Equatable, Sendable, Identifiable {
    /// Short identifier — also the default backend name (e.g. `"openai"`).
    public let id: String
    /// Human-readable provider name (e.g. `"OpenAI"`).
    public let name: String
    /// Default base URL (host, without a version path).
    public let defaultUrl: String
    /// Path segment between the base URL and the OpenAI-compatible endpoints
    /// (e.g. `"/v1beta/openai"` for Google); nil → the gateway default `"/v1"`.
    public let apiPathPrefix: String?
    /// Pre-probe model-id hints (the live `/models` list takes precedence).
    public let knownModels: [String]?
    /// Catalog roles this provider is typically used for.
    public let capabilities: [String]

    public init(
        id: String,
        name: String,
        defaultUrl: String,
        apiPathPrefix: String? = nil,
        knownModels: [String]? = nil,
        capabilities: [String] = []
    ) {
        self.id = id
        self.name = name
        self.defaultUrl = defaultUrl
        self.apiPathPrefix = apiPathPrefix
        self.knownModels = knownModels
        self.capabilities = capabilities
    }
}

/// One capability card's presentation metadata. Mirrors `CapabilityMetadata`
/// in `@omnesis/core/models/capabilities.ts`.
public struct CapabilityMeta: Decodable, Equatable, Sendable, Identifiable {
    public let role: String
    public let title: String
    public let description: String
    public let icon: String
    /// Whether this capability only serves an experimental feature. The
    /// gateway only includes it in the capability grid in experimental mode;
    /// the card carries an "Experimental" tag. Absent on older gateways → false.
    public let experimental: Bool
    /// Ordering hint ("core" | "cognition") — core capabilities appear before
    /// cognition roles in the unified capability list. Absent on older gateways
    /// → nil (treated as core).
    public let section: String?
    public var id: String {
        role
    }

    public init(
        role: String,
        title: String,
        description: String,
        icon: String,
        experimental: Bool = false,
        section: String? = nil
    ) {
        self.role = role
        self.title = title
        self.description = description
        self.icon = icon
        self.experimental = experimental
        self.section = section
    }

    private enum CodingKeys: String, CodingKey {
        case role
        case title
        case description
        case icon
        case experimental
        case section
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        role = try values.decode(String.self, forKey: .role)
        title = try values.decode(String.self, forKey: .title)
        description = try values.decode(String.self, forKey: .description)
        icon = try values.decode(String.self, forKey: .icon)
        experimental = try values.decodeIfPresent(Bool.self, forKey: .experimental) ?? false
        section = try values.decodeIfPresent(String.self, forKey: .section)
    }
}

/// Resolved inference state. Backends keyed by backend key (or `"anthropic"`).
public struct InferenceOverview: Decodable, Equatable, Sendable {
    public let backends: [String: BackendStatus]
    /// Experimental Codex backend status. Present only when the gateway exposes
    /// experimental model-management surfaces; `configured == false` means it is
    /// addable but not an installed backend row.
    public let codex: CodexBackendStatus?
    public let assignments: [String: ResolvedAssignment]

    public init(
        backends: [String: BackendStatus],
        codex: CodexBackendStatus? = nil,
        assignments: [String: ResolvedAssignment]
    ) {
        self.backends = backends
        self.codex = codex
        self.assignments = assignments
    }
}

/// One HTTP / Anthropic backend's probed status. Only the keys the picker +
/// backends list need are decoded.
public struct BackendStatus: Decodable, Equatable, Hashable, Sendable {
    public let type: String
    public let status: String
    public let url: String?
    public let `protocol`: String?
    public let models: [String]?
    /// Model id → the capability roles that model can serve (from the probe).
    public let modelRoles: [String: [String]]?
    public let hasApiKey: Bool?

    public init(
        type: String,
        status: String,
        url: String? = nil,
        protocol: String? = nil,
        models: [String]? = nil,
        modelRoles: [String: [String]]? = nil,
        hasApiKey: Bool? = nil
    ) {
        self.type = type
        self.status = status
        self.url = url
        self.protocol = `protocol`
        self.models = models
        self.modelRoles = modelRoles
        self.hasApiKey = hasApiKey
    }
}

/// One Codex model from Codex model discovery, exposed by the gateway only after
/// the dedicated Codex home is logged in.
public struct CodexModelStatus: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String?
    public let description: String?
    public let recommended: Bool?

    public init(id: String, name: String? = nil, description: String? = nil, recommended: Bool? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.recommended = recommended
    }
}

/// Codex runtime source/path/version reported by the gateway.
public struct CodexRuntimeStatus: Decodable, Equatable, Hashable, Sendable {
    public let source: String
    public let command: String
    public let packageName: String?
    public let packageVersion: String?
    public let version: String?
    public let supported: Bool
    public let reason: String?

    public init(
        source: String = "",
        command: String = "",
        packageName: String? = nil,
        packageVersion: String? = nil,
        version: String? = nil,
        supported: Bool = false,
        reason: String? = nil
    ) {
        self.source = source
        self.command = command
        self.packageName = packageName
        self.packageVersion = packageVersion
        self.version = version
        self.supported = supported
        self.reason = reason
    }
}

/// Experimental Codex backend status. Unlike `BackendStatus`, this is not a
/// user-declared HTTP backend and has no URL/API-key fields.
public struct CodexBackendStatus: Decodable, Equatable, Hashable, Sendable {
    public let type: String
    public let configured: Bool
    public let status: String
    public let loggedIn: Bool
    public let runtime: CodexRuntimeStatus?
    public let models: [String]
    public let modelDetails: [CodexModelStatus]?
    public let discovery: String?
    public let modelRoles: [String: [String]]?
    public let reason: String?
    public let refreshedAt: String?

    public init(
        type: String = "codex",
        configured: Bool,
        status: String,
        loggedIn: Bool,
        runtime: CodexRuntimeStatus? = nil,
        models: [String],
        modelDetails: [CodexModelStatus]? = nil,
        discovery: String? = nil,
        modelRoles: [String: [String]]? = nil,
        reason: String? = nil,
        refreshedAt: String? = nil
    ) {
        self.type = type
        self.configured = configured
        self.status = status
        self.loggedIn = loggedIn
        self.runtime = runtime
        self.models = models
        self.modelDetails = modelDetails
        self.discovery = discovery
        self.modelRoles = modelRoles
        self.reason = reason
        self.refreshedAt = refreshedAt
    }
}

/// Active Codex device-login flow state.
public struct CodexLoginFlow: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let status: String
    public let verificationUri: String?
    public let userCode: String?
    public let expiresAt: String?
    public let reason: String?

    public init(
        id: String,
        status: String,
        verificationUri: String? = nil,
        userCode: String? = nil,
        expiresAt: String? = nil,
        reason: String? = nil
    ) {
        self.id = id
        self.status = status
        self.verificationUri = verificationUri
        self.userCode = userCode
        self.expiresAt = expiresAt
        self.reason = reason
    }
}

public struct CodexCancelLoginResult: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let canceled: Bool
    public let flow: CodexLoginFlow?
}

public struct CodexRemoveResult: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let status: CodexBackendStatus
    public let clearedAssignments: [String]
}

/// A resolved per-role assignment, flattened to the fields the phone needs:
/// the discriminant kind (`local`/`http`/`anthropic`/`replay`/`disabled`/
/// `unresolved`), availability, and the unavailable reason.
public struct ResolvedAssignment: Decodable, Equatable, Sendable {
    public let kind: String
    public let available: Bool?
    public let reason: String?

    public init(kind: String, available: Bool? = nil, reason: String? = nil) {
        self.kind = kind
        self.available = available
        self.reason = reason
    }
}

/// One catalog entry (a known model). `kind` is `"gguf"` or `"anthropic-api"`;
/// `roles` are CATALOG roles (`embed`/`agent`/`transcribe`).
/// The GGUF-only fields (`sizeBytes`, `minRamGb`, …) drive the local-model
/// install list's size/RAM labels and system-fit badge; they're absent on
/// `anthropic-api` entries.
public struct CatalogEntry: Decodable, Equatable, Sendable, Identifiable {
    public let kind: String
    public let id: String
    public let name: String
    public let roles: [String]
    /// Approx file size in bytes (gguf only). Drives the "needs N free" label.
    public let sizeBytes: Int?
    /// Hard floor on free RAM in GB (gguf only) — surfaced as a fit warning.
    public let minRamGb: Double?
    /// Recommended free RAM in GB (gguf only).
    public let recommendedRamGb: Double?
    /// Quantization label ("Q4_K_M", "Q8_0", …) for display (gguf only).
    public let quant: String?
    /// Approx parameter count ("1.5B", "137M", …) for display.
    public let params: String?
    /// Recommended for first-time users — surfaced first with a tag.
    public let recommended: Bool?

    public init(
        kind: String,
        id: String,
        name: String,
        roles: [String],
        sizeBytes: Int? = nil,
        minRamGb: Double? = nil,
        recommendedRamGb: Double? = nil,
        quant: String? = nil,
        params: String? = nil,
        recommended: Bool? = nil
    ) {
        self.kind = kind
        self.id = id
        self.name = name
        self.roles = roles
        self.sizeBytes = sizeBytes
        self.minRamGb = minRamGb
        self.recommendedRamGb = recommendedRamGb
        self.quant = quant
        self.params = params
        self.recommended = recommended
    }
}

/// One in-flight gateway-side GGUF download. Mirrors `ActiveDownload` in
/// `packages/gateway/src/models/manager.ts`: the server-assigned `downloadId`,
/// the catalog `modelId` being installed, the filename, and a live progress
/// snapshot. The phone matches it to a catalog row by `modelId`.
public struct ActiveDownload: Decodable, Equatable, Sendable, Identifiable {
    public let downloadId: String
    public let modelId: String
    public let filename: String
    public let progress: DownloadProgress
    public let startedAt: String

    public var id: String {
        downloadId
    }

    public init(
        downloadId: String,
        modelId: String,
        filename: String,
        progress: DownloadProgress,
        startedAt: String
    ) {
        self.downloadId = downloadId
        self.modelId = modelId
        self.filename = filename
        self.progress = progress
        self.startedAt = startedAt
    }
}

/// A download progress snapshot. Mirrors `DownloadProgress` in
/// `packages/gateway/src/models/downloader.ts`. `etaMs` is `-1` when the total
/// size is unknown.
public struct DownloadProgress: Decodable, Equatable, Sendable {
    public let downloadedBytes: Int
    public let totalBytes: Int
    public let speedBytesPerSec: Int
    public let etaMs: Int

    public init(downloadedBytes: Int, totalBytes: Int, speedBytesPerSec: Int, etaMs: Int) {
        self.downloadedBytes = downloadedBytes
        self.totalBytes = totalBytes
        self.speedBytesPerSec = speedBytesPerSec
        self.etaMs = etaMs
    }
}

/// Host capacity snapshot from `GET /admin/system-info`. Only the fields the
/// local-model fit badge needs are decoded (free RAM + free model-dir disk);
/// mirrors `SystemInfo` in `packages/gateway/src/system-info.ts`.
public struct SystemInfo: Decodable, Equatable, Sendable {
    public let totalRamGb: Double
    public let freeRamGb: Double
    public let modelsDirFreeGb: Double

    public init(totalRamGb: Double, freeRamGb: Double, modelsDirFreeGb: Double) {
        self.totalRamGb = totalRamGb
        self.freeRamGb = freeRamGb
        self.modelsDirFreeGb = modelsDirFreeGb
    }
}

/// Result of `POST /admin/inference/backends/:key/probe`. Mirrors the route's
/// envelope in `packages/gateway/src/models/routes.ts`: `ok` is true when the
/// backend answered its `/v1/models` probe, `status` is `"ok"`/`"unreachable"`,
/// `models` is the served-model list, and `reason` carries the failure text
/// when unreachable.
public struct ProbeResult: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let status: String
    public let models: [String]
    public let reason: String?

    public init(ok: Bool, status: String, models: [String] = [], reason: String? = nil) {
        self.ok = ok
        self.status = status
        self.models = models
        self.reason = reason
    }
}

/// Result of `POST /admin/inference/backends/:key/verify` — the behavioral
/// verdict for one (backend, model, role). Mirrors `CapabilityVerdict` in
/// `@omnesis/core`: `supported` is true when the backend served the role's
/// minimal capability call, and `detail` is a one-line human-readable
/// explanation (endpoint hit, embedding dim, or the upstream error text).
public struct CapabilityVerdict: Decodable, Equatable, Sendable {
    public let role: String
    public let model: String
    public let supported: Bool
    public let detail: String

    public init(role: String, model: String, supported: Bool, detail: String) {
        self.role = role
        self.model = model
        self.supported = supported
        self.detail = detail
    }
}

/// One row of `GET /admin/model-credentials` — a model-provider credential
/// entry. Mirrors `ModelCredentialEntry` in
/// `packages/gateway/src/model-credentials.ts`: the stable `fileKey`, the
/// provider's type/name, the field spec the form renders, and whether
/// credentials are currently configured. No secret value is ever included —
/// only `configured`.
public struct ModelCredentialEntry: Decodable, Equatable, Sendable, Identifiable {
    public let fileKey: String
    public let providerType: String
    public let providerName: String
    public let spec: CredentialSpec
    public let configured: Bool

    public var id: String {
        fileKey
    }

    public init(
        fileKey: String,
        providerType: String,
        providerName: String,
        spec: CredentialSpec,
        configured: Bool
    ) {
        self.fileKey = fileKey
        self.providerType = providerType
        self.providerName = providerName
        self.spec = spec
        self.configured = configured
    }
}

/// The JSON-safe credential spec from a provider entry. Only the fields the
/// credential form renders are decoded; the setup `wizard` blob is ignored
/// (the phone shows a compact inline form, not the full CLI/portal wizard).
/// Mirrors `SerializedProviderCredentialsSpec` in `@omnesis/core`.
public struct CredentialSpec: Decodable, Equatable, Sendable {
    public let fields: [CredentialField]

    public init(fields: [CredentialField]) {
        self.fields = fields
    }
}

/// One field a provider's credentials require (e.g. `apiKey`). Mirrors
/// `ProviderCredentialsField` in `@omnesis/core`. `secret` fields render as
/// masked inputs and their values are never read back or logged.
public struct CredentialField: Decodable, Equatable, Sendable, Identifiable {
    public let name: String
    public let label: String
    public let placeholder: String?
    public let secret: Bool?
    public let pattern: String?
    public let patternHint: String?

    public var id: String {
        name
    }

    public init(
        name: String,
        label: String,
        placeholder: String? = nil,
        secret: Bool? = nil,
        pattern: String? = nil,
        patternHint: String? = nil
    ) {
        self.name = name
        self.label = label
        self.placeholder = placeholder
        self.secret = secret
        self.pattern = pattern
        self.patternHint = patternHint
    }
}

/// One installed-manifest entry — just the catalog id, so the picker can tell
/// which GGUFs are downloaded (and thus activatable) on the gateway host.
public struct ManifestEntry: Decodable, Equatable, Sendable {
    public let id: String

    public init(id: String) {
        self.id = id
    }
}

/// `GET /admin/models/recent/:capability` — the "Recently used" picker entries
/// for the capability being configured: deduplicated models recently used for
/// it or a similar capability, the reference's own first. An empty list means
/// the picker hides the section. Mirrors `RecentModelsResult` in
/// `packages/gateway/src/models/recent-models.ts`.
public struct RecentModelsResponse: Decodable, Equatable, Sendable {
    public var capability = ""
    public var entries: [RecentModelEntry] = []
}

/// One "Recently used" entry: the raw assignment value, its provider display
/// (brand id + label + friendly model name), and how to apply it. `assign`
/// applies via `PATCH /admin/config` with the raw value; `activate` via
/// `POST /admin/models/activate` with the catalog id + role.
public struct RecentModelEntry: Decodable, Equatable, Sendable, Identifiable {
    public var assignment = ""
    public var providerId = ""
    public var providerLabel = ""
    public var modelName = ""
    public var apply = RecentModelApply()

    public var id: String {
        assignment
    }
}

/// How to apply a `RecentModelEntry`. Kept flat (nullable per-type fields)
/// instead of a polymorphic hierarchy: `type` is `assign` (with `value`) or
/// `activate` (with `catalogId` + `catalogRole`).
public struct RecentModelApply: Decodable, Equatable, Sendable {
    public var type = ""
    public var value: String?
    public var catalogId: String?
    public var catalogRole: String?
}
