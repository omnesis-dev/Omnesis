// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Pure model-management derivations shared by the Models surface. Kept out of
/// the view so the three-way capability state, the capability→catalog role
/// mapping, and the per-role picker-option list are unit-testable without a
/// gateway and stay in lockstep with the portal (`capability-state.js` +
/// `models.js`).
enum ModelManagement {
    /// Three-way capability state, mirroring the portal's `capabilityCardState`.
    enum CapabilityState {
        /// Enabled and currently usable (green tick).
        case on
        /// Configured but not available right now (e.g. model not downloaded,
        /// backend unreachable, API key missing) — needs attention.
        case warn
        /// Nothing assigned.
        case off
    }

    /// Mirrors `isEnabled` in `capability-state.js`.
    static func isEnabled(_ assignment: ResolvedAssignment?) -> Bool {
        guard let assignment else { return false }
        if assignment.kind == "disabled" || assignment.kind == "unresolved" { return false }
        if assignment.kind == "replay" { return true }
        return assignment.available == true
    }

    /// Mirrors `isConfigured` in `capability-state.js`.
    static func isConfigured(_ assignment: ResolvedAssignment?) -> Bool {
        guard let assignment else { return false }
        return assignment.kind != "disabled" && assignment.kind != "unresolved"
    }

    /// Known bug: #67 — a local GGUF on a chat role reads as enabled here
    /// while the gateway's readiness check refuses it.
    static func state(_ assignment: ResolvedAssignment?) -> CapabilityState {
        if isEnabled(assignment) { return .on }
        if isConfigured(assignment) { return .warn }
        return .off
    }

    /// Capability role → catalog role, the inverse of the gateway's
    /// `CATALOG_TO_CAPABILITY`. `ocr` has no catalog role (its
    /// catalog/local lifecycle is out of this surface's scope); it returns nil.
    static func catalogRole(for capabilityRole: String) -> String? {
        switch capabilityRole {
        case "embedder": "embed"
        case "agent": "agent"
        case "privacy-reviewer": "agent"
        case "watch-judge": "agent"
        case "transcriber": "transcribe"
        default: nil
        }
    }

    /// How the gateway is told to assign a `PickerOption`.
    enum PickerApply: Equatable {
        /// `POST /admin/models/activate` with this catalog id + catalog role.
        case activate(catalogId: String, catalogRole: String, capabilityRole: String)
        /// `PATCH /admin/config` with this assignment value (`<backend>/<model>`).
        case assign(value: String)
    }

    /// One choosable model for a capability, with how to apply it.
    struct PickerOption: Identifiable, Equatable {
        let id: String
        /// Provider brand id for the glyph (`local`, `anthropic`, the backend key).
        let providerId: String
        /// Display name (catalog name, or the raw backend model id).
        let label: String
        /// Short qualifier line ("Local · downloaded", "Cloud", the backend URL).
        let detail: String
        let apply: PickerApply
    }

    /// The models the gateway already knows about that can serve `capabilityRole`,
    /// grouped/ordered as: installed local GGUFs, Anthropic API entries, then each
    /// HTTP backend's role-matching models. Mirrors the portal's picker sources,
    /// minus the not-yet-installed GGUFs / add-backend / credential steps (those
    /// are a later iteration).
    static func pickerOptions(
        capabilityRole: String,
        overview: ModelsOverview
    )
        -> [PickerOption] {
        var out: [PickerOption] = []
        let catalogRole = catalogRole(for: capabilityRole)
        let installedIds = Set(overview.installed.map(\.id))

        if let catalogRole {
            // Installed local GGUFs for this role.
            for entry in overview.catalog where entry.kind == "gguf"
                && entry.roles.contains(catalogRole) && installedIds.contains(entry.id) {
                out.append(PickerOption(
                    id: "local/\(entry.id)",
                    providerId: "local",
                    label: entry.name,
                    detail: "Local · downloaded",
                    apply: .activate(
                        catalogId: entry.id,
                        catalogRole: catalogRole,
                        capabilityRole: capabilityRole
                    )
                ))
            }
            // Anthropic API entries for this role (key state shown by availability).
            for entry in overview.catalog where entry.kind == "anthropic-api"
                && entry.roles.contains(catalogRole) {
                out.append(PickerOption(
                    id: "anthropic/\(entry.id)",
                    providerId: "anthropic",
                    label: entry.name,
                    detail: "Cloud",
                    apply: .activate(
                        catalogId: entry.id,
                        catalogRole: catalogRole,
                        capabilityRole: capabilityRole
                    )
                ))
            }
        }

        if let codex = overview.inference.codex, codex.configured {
            let detailsById = Dictionary(uniqueKeysWithValues: (codex.modelDetails ?? []).map { ($0.id, $0) })
            for model in codex.models where codex.modelRoles?[model]?.contains(capabilityRole) == true {
                let detail = detailsById[model]
                out.append(PickerOption(
                    id: "codex/\(model)",
                    providerId: "codex",
                    label: detail?.name ?? model,
                    detail: "Codex",
                    apply: .assign(value: "codex/\(model)")
                ))
            }
        }

        // HTTP-backend models whose probe says they can serve this capability.
        for (key, backend) in overview.inference.backends.sorted(by: { $0.key < $1.key })
            where backend.type == "http"
            && !(capabilityRole == "watch-judge" && backend.protocol == "responses") {
            let roles = backend.modelRoles ?? [:]
            let models = (backend.models ?? []).filter { roles[$0]?.contains(capabilityRole) == true }
            for model in models {
                out.append(PickerOption(
                    id: "\(key)/\(model)",
                    providerId: key,
                    label: model,
                    detail: backend.url ?? key,
                    apply: .assign(value: "\(key)/\(model)")
                ))
            }
        }

        return out
    }

    /// One backend tile in the model picker's first-level grid: the brand glyph
    /// id, a title (Local / Anthropic / the backend key), a subtitle (the backend
    /// URL or a "N models" count), the count of role-matching picker options, and
    /// whether it's a user-managed HTTP backend (those allow a typed custom model
    /// id and group their options by the backend key rather than `local` /
    /// `anthropic`).
    struct PickerBackend: Identifiable, Equatable {
        /// `local`, `anthropic`, or the HTTP backend key — also the brand glyph id.
        let providerId: String
        let title: String
        /// The backend URL for an HTTP backend; nil for the built-in `local` /
        /// `anthropic` tiles (they show a "N models" count instead).
        let url: String?
        /// Number of role-matching `PickerOption`s grouped under this backend.
        let optionCount: Int
        /// True for a user-managed HTTP backend (enables the typed custom model id).
        let isHttp: Bool
        var id: String {
            providerId
        }
    }

    /// The first-level grid for the model picker: the `local` tile (if any local
    /// option serves this role), the `anthropic` tile (if any), then one tile per
    /// configured HTTP backend — including HTTP backends with zero role-matching
    /// models, so the user can still open one and type a custom model id. Counts
    /// come from `pickerOptions`, grouped by `providerId`.
    static func pickerBackends(
        capabilityRole: String,
        overview: ModelsOverview
    )
        -> [PickerBackend] {
        let options = pickerOptions(capabilityRole: capabilityRole, overview: overview)
        var counts: [String: Int] = [:]
        for option in options {
            counts[option.providerId, default: 0] += 1
        }

        var out: [PickerBackend] = []
        if let localCount = counts["local"], localCount > 0 {
            out.append(PickerBackend(
                providerId: "local",
                title: "Local",
                url: nil,
                optionCount: localCount,
                isHttp: false
            ))
        }
        if let codex = overview.inference.codex, codex.configured, (counts["codex"] ?? 0) > 0 {
            out.append(PickerBackend(
                providerId: "codex",
                title: "Codex",
                url: nil,
                optionCount: counts["codex"] ?? 0,
                isHttp: false
            ))
        }
        if let anthropicCount = counts["anthropic"], anthropicCount > 0 {
            out.append(PickerBackend(
                providerId: "anthropic",
                title: "Anthropic",
                url: nil,
                optionCount: anthropicCount,
                isHttp: false
            ))
        }
        // Each configured HTTP backend, even with zero role-matching models.
        for backend in httpBackends(overview)
            where !(capabilityRole == "watch-judge" && backend.status.protocol == "responses") {
            out.append(PickerBackend(
                providerId: backend.key,
                title: backend.key,
                url: backend.status.url,
                optionCount: counts[backend.key] ?? 0,
                isHttp: true
            ))
        }
        return out
    }

    /// The role-matching picker options grouped under one backend tile (its
    /// `providerId`), filtered by a fuzzy search over the option label + id:
    /// every whitespace-separated query token must occur in either (same rule
    /// as the portal's `fuzzy-match.js`, so "deepseek flash" finds
    /// `deepseek-ai/DeepSeek-V4-Flash-0731`).
    ///
    /// Deliberate scope gap vs the portal's Codex list (which also matches the
    /// model description): options here carry no description, so only label +
    /// id participate. Codex option ids are prefixed (`"codex/<model>"`), so a
    /// bare `codex` token matches every Codex row — harmless, arguably useful.
    static func pickerOptions(
        capabilityRole: String,
        overview: ModelsOverview,
        forProviderId providerId: String,
        search: String
    )
        -> [PickerOption] {
        pickerOptions(capabilityRole: capabilityRole, overview: overview)
            .filter { $0.providerId == providerId }
            .filter { fuzzyMatchFields([$0.label, $0.id], query: search) }
    }

    /// Fuzzy model-id matching for the picker search box. Splits the query on
    /// whitespace and requires every token to appear in the id
    /// (case-insensitive); a blank query matches everything, and a
    /// single-token query behaves exactly like the old substring filter.
    /// Case folding is locale-invariant (POSIX): model ids are ASCII, and the
    /// device-locale fold would miss them on e.g. tr-TR devices.
    static func fuzzyMatchModelId(_ id: String, query: String) -> Bool {
        let tokens = query.foldedTokens
        guard !tokens.isEmpty else { return true }
        let haystack = id.lowercased(with: String.foldLocale)
        return tokens.allSatisfy { haystack.contains($0) }
    }

    /// Token match across several fields — every query token must occur in at
    /// least one field, so tokens may match different fields (a name token and
    /// an id token). Missing fields are skipped.
    static func fuzzyMatchFields(_ fields: [String?], query: String) -> Bool {
        let tokens = query.foldedTokens
        guard !tokens.isEmpty else { return true }
        let haystacks = fields.map { ($0 ?? "").lowercased(with: String.foldLocale) }
        return tokens.allSatisfy { token in haystacks.contains { $0.contains(token) } }
    }

    /// Fetch the "Recently used" entries for a capability. Never throws: any
    /// failure — including an HTTP 404 from an older gateway without the
    /// route — yields an empty list so the picker hides the section while the
    /// backend grid below still works.
    static func loadRecent(client: AdminClient, capability: String) async -> [RecentModelEntry] {
        await (try? client.recentModels(capability: capability))?.entries ?? []
    }

    /// Map one `GET /admin/models/recent` entry to a choosable picker option
    /// for `capabilityRole` — an `activate` for catalog models, an `assign`
    /// for everything else (mirroring how the gateway built the entry).
    /// Returns nil when the entry's apply payload is incomplete, so the UI
    /// skips it instead of offering a dead button.
    static func recentPickerOption(
        capabilityRole: String,
        entry: RecentModelEntry
    )
        -> PickerOption? {
        let label = entry.modelName.isEmpty ? entry.assignment : entry.modelName
        switch entry.apply.type {
        case "activate":
            guard let catalogId = entry.apply.catalogId,
                  let catalogRole = entry.apply.catalogRole
            else { return nil }
            return PickerOption(
                id: entry.assignment,
                providerId: entry.providerId,
                label: label,
                detail: entry.providerLabel,
                apply: .activate(
                    catalogId: catalogId,
                    catalogRole: catalogRole,
                    capabilityRole: capabilityRole
                )
            )
        case "assign":
            guard let value = entry.apply.value else { return nil }
            return PickerOption(
                id: entry.assignment,
                providerId: entry.providerId,
                label: label,
                detail: entry.providerLabel,
                apply: .assign(value: value)
            )
        default:
            return nil
        }
    }

    // MARK: - HTTP-backend management

    /// Backend names the gateway reserves for its built-in backends; an HTTP
    /// backend can't take one of these keys. Mirrors `RESERVED_BACKEND_NAMES`
    /// in the portal's `model-config.js`.
    static let reservedBackendNames: Set<String> = ["local", "anthropic", "codex", "replay"]

    /// Validate a proposed HTTP-backend name client-side, matching the portal's
    /// `nameValid` rule (`model-config.js`): non-blank, not a reserved word, and
    /// no `/` (the slash separates backend key from model id in an assignment
    /// value). Returns nil when valid, else a short human-readable reason. The
    /// gateway re-validates on `PATCH /admin/config`; this is just for inline
    /// form feedback.
    static func validateBackendName(_ raw: String) -> String? {
        let name = raw.trimmingCharacters(in: .whitespaces)
        if name.isEmpty { return "Name is required." }
        if reservedBackendNames.contains(name) { return "Name can't be a reserved word." }
        if name.contains("/") { return "Name can't contain \"/\"." }
        return nil
    }

    /// One row of the backends list: the backend key plus its probed status.
    struct BackendRow: Identifiable, Equatable, Hashable {
        let key: String
        let status: BackendStatus
        var id: String {
            key
        }
    }

    /// The user-managed HTTP backends, sorted by key. The built-in `anthropic`
    /// backend is configured via API-key credentials (the provider-credentials
    /// surface), not added/removed here, so it's excluded — matching the
    /// portal's Backends list, which only lists `type === "http"` backends as
    /// removable rows.
    static func httpBackends(_ overview: ModelsOverview) -> [BackendRow] {
        overview.inference.backends
            .filter { $0.value.type == "http" }
            .sorted { $0.key < $1.key }
            .map { BackendRow(key: $0.key, status: $0.value) }
    }

    // MARK: - Behavioral capability verify

    /// The capability roles `POST /admin/inference/backends/:key/verify` accepts,
    /// in display order. Mirrors `VERIFIABLE_ROLES` in
    /// `packages/gateway/src/models/routes.ts` (the gateway rejects any other
    /// role with a 400). Transcriber/OCR are not behaviorally verifiable here:
    /// they have no cheap text-only probe call.
    static let verifiableRoles: [String] = [
        "embedder", "agent", "privacy-reviewer", "watch-judge",
    ]

    /// Human-readable display title for a capability role. Mirrors the
    /// `title` field of `CAPABILITY_METADATA` in `@omnesis/core`. Falls back to
    /// the raw role id for any unknown role so a new gateway role still renders.
    static func roleLabel(_ role: String) -> String {
        switch role {
        case "embedder": "Embedder"
        case "agent": "Agent"
        case "privacy-reviewer": "Privacy reviewer"
        case "watch-judge": "Watch judge"
        case "transcriber": "Transcriber"
        case "ocr": "OCR"
        default: role
        }
    }

    /// One (model, role) pair a backend can be asked to behaviorally verify: a
    /// model the backend advertises (via its probe's `modelRoles`) for a role the
    /// verify endpoint accepts. Identified by `backendKey/model/role` so verdict
    /// state is tracked per pair.
    struct VerifyTarget: Identifiable, Equatable {
        let backendKey: String
        let model: String
        let role: String
        var id: String {
            "\(backendKey)/\(model)/\(role)"
        }
    }

    /// The (model, role) pairs worth offering a Verify affordance for on one
    /// backend: each model the backend's probe classified into a verifiable role.
    /// Sorted by model then role for a stable render. Empty when the backend's
    /// probe found no verifiable-role model (e.g. an OCR-only backend, or an
    /// unreachable one whose `modelRoles` is empty) — the row then offers no
    /// verify affordance.
    static func verifyTargets(_ row: BackendRow) -> [VerifyTarget] {
        let verifiable = Set(verifiableRoles)
        let roles = row.status.modelRoles ?? [:]
        var out: [VerifyTarget] = []
        for model in (row.status.models ?? []).sorted() {
            for role in (roles[model] ?? []).filter({ verifiable.contains($0) }).sorted() {
                out.append(VerifyTarget(backendKey: row.key, model: model, role: role))
            }
        }
        return out
    }

    // MARK: - Model-provider credentials

    /// The cleaned field map on success, or a short reason on the first failure.
    /// Mirrors the Android `CredentialValidation` so both platforms gate the
    /// save button identically.
    enum CredentialValidation: Equatable {
        case valid(cleaned: [String: String])
        case invalid(reason: String)
    }

    /// Validate raw credential field values against a provider's spec
    /// client-side, mirroring the gateway's `validateCredentialFields`: every
    /// declared field must be a non-empty (trimmed) string, and any field with
    /// a `pattern` must match it. Returns the trimmed field map ready to submit,
    /// or a short human-readable reason for the first failing field. The gateway
    /// re-validates on `POST`; this is just inline form feedback so the submit
    /// button can gate.
    static func validateCredentialFields(
        _ raw: [String: String],
        spec: CredentialSpec
    )
        -> CredentialValidation {
        var cleaned: [String: String] = [:]
        for field in spec.fields {
            let value = (raw[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if value.isEmpty {
                return .invalid(reason: "\(field.label) is required.")
            }
            if let pattern = field.pattern,
               value.range(of: pattern, options: .regularExpression) == nil {
                return .invalid(reason: field.patternHint ?? "\(field.label) has an invalid format.")
            }
            cleaned[field.name] = value
        }
        return .valid(cleaned: cleaned)
    }

    // MARK: - Local-model lifecycle

    /// Human-readable byte size, mirroring the portal's `formatBytes`
    /// (`lib/model-format.js`). `nil` renders as an em dash.
    static func formatBytes(_ bytes: Int?) -> String {
        guard let bytes else { return "—" }
        let gb = 1024.0 * 1024.0 * 1024.0
        let mb = 1024.0 * 1024.0
        let kb = 1024.0
        let value = Double(bytes)
        if value >= gb { return String(format: "%.2f GB", value / gb) }
        if value >= mb { return String(format: "%.1f MB", value / mb) }
        if value >= kb { return String(format: "%.1f KB", value / kb) }
        return "\(bytes) B"
    }

    /// A system-fit warning for a GGUF catalog entry against a host snapshot.
    /// Mirrors a `warn` badge from the portal's `fit` (`lib/model-format.js`).
    struct FitWarning: Identifiable, Equatable {
        let text: String
        var id: String {
            text
        }
    }

    /// System-fit warnings for a GGUF entry relative to a `SystemInfo` snapshot:
    /// a free-RAM floor warning and a free-disk warning. Mirrors the portal's
    /// `fit`. Returns empty when the snapshot is absent or the entry isn't a GGUF
    /// (those fit unconditionally on the phone surface).
    static func fitWarnings(_ entry: CatalogEntry, system: SystemInfo?) -> [FitWarning] {
        guard let system, entry.kind == "gguf" else { return [] }
        var out: [FitWarning] = []
        if let minRamGb = entry.minRamGb, system.freeRamGb < minRamGb {
            out.append(FitWarning(
                text: "Needs \(formatGb(minRamGb)) GB free RAM (you have \(formatGb(system.freeRamGb)) GB)"
            ))
        }
        if let sizeBytes = entry.sizeBytes,
           system.modelsDirFreeGb < Double(sizeBytes) / (1024.0 * 1024.0 * 1024.0) {
            out.append(FitWarning(
                text: "Disk free (\(formatGb(system.modelsDirFreeGb)) GB) may not fit \(formatBytes(sizeBytes))"
            ))
        }
        return out
    }

    private static func formatGb(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }

    /// The per-row lifecycle state of a local GGUF catalog entry.
    enum LocalModelState: Equatable {
        /// Downloading on the gateway host, at `percent` (0–100). Cancellable.
        case downloading(percent: Int)
        /// Downloaded on disk — can be assigned to a role or removed.
        case installed
        /// Not downloaded — can be installed.
        case available
    }

    /// One row of the local-model install list: a GGUF catalog entry, its
    /// lifecycle state, and any system-fit warnings.
    struct LocalModelRow: Identifiable, Equatable {
        let entry: CatalogEntry
        let state: LocalModelState
        let fitWarnings: [FitWarning]
        var id: String {
            entry.id
        }
    }

    /// Download completion percent (0–100) from a progress snapshot. Mirrors the
    /// portal's `Math.min(100, floor(downloaded / (total || 1) * 100))`.
    static func downloadPercent(_ progress: DownloadProgress) -> Int {
        let total = progress.totalBytes > 0 ? progress.totalBytes : 1
        let pct = Int((Double(progress.downloadedBytes) / Double(total) * 100.0).rounded(.down))
        return min(100, max(0, pct))
    }

    /// The local GGUF models that can serve `capabilityRole`, each decorated with
    /// its lifecycle state and fit warnings. Mirrors the portal's
    /// `LocalModelList` source filter + per-row state derivation. `nil`
    /// catalog-role capabilities (ocr) yield an empty list.
    static func localModelRows(
        capabilityRole: String,
        overview: ModelsOverview,
        system: SystemInfo?
    )
        -> [LocalModelRow] {
        guard let catalogRole = catalogRole(for: capabilityRole) else { return [] }
        let installedIds = Set(overview.installed.map(\.id))
        return overview.catalog
            .filter { $0.kind == "gguf" && $0.roles.contains(catalogRole) }
            .map { entry in
                let state: LocalModelState = if let dl = overview.activeDownloads.first(where: { $0.modelId == entry.id }) {
                    .downloading(percent: downloadPercent(dl.progress))
                } else if installedIds.contains(entry.id) {
                    .installed
                } else {
                    .available
                }
                return LocalModelRow(
                    entry: entry,
                    state: state,
                    fitWarnings: fitWarnings(entry, system: system)
                )
            }
    }
}

/// POSIX-folded whitespace tokens for the picker's fuzzy matcher. Kept here
/// (not on `ModelManagement`) because both matcher entry points need it.
extension String {
    fileprivate static let foldLocale = Locale(identifier: "en_US_POSIX")

    fileprivate var foldedTokens: [String] {
        lowercased(with: Self.foldLocale).split(whereSeparator: \.isWhitespace).map(String.init)
    }
}
