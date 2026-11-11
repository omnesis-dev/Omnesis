// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Pure derivations behind the Decision model setup: which backends and
/// providers to offer, what a valid backend name is, how a preset's decision
/// URL is completed, when cloud consent is needed, the `PATCH /admin/config`
/// body a choice saves, and the verify wording. Kept out of
/// the views so each rule is unit-tested and stays in step with the gateway
/// (`provider-presets.ts`, `config-schema.ts`) and the portal.
enum DecisionModelSetup {
    /// The capability role the Decision model fills.
    static let role = "decision"
    /// `CapabilityMeta.backendFamily` of the Decision card.
    static let backendFamily = "typed-decision"
    /// The built-in TypeSafe slot's assignment prefix and credential file key.
    static let typesafeKey = "typesafe"
    /// Names a backend with a decision API cannot take: each already means a
    /// built-in slot in an assignment, and `typesafe` is TypeSafe's.
    static let reservedNames: Set<String> = ["local", "anthropic", "codex", "claude-code", "replay", "typesafe"]
    static let maxNameLength = 64

    /// Whether this app can configure `cap`: every ordinary role, and the
    /// Decision card when the gateway's presets describe decision APIs (an
    /// older gateway's do not, and its Decision card stays read-only).
    static func isConfigurable(_ cap: CapabilityMeta, in overview: ModelsOverview) -> Bool {
        if cap.configurableOnDevice { return true }
        return cap.backendFamily == backendFamily && overview.allProviders.contains { $0.decision != nil }
    }

    // MARK: - Providers

    /// A configured backend: one with a decision API, offered first so it can
    /// be reused, or one whose provider offers a decision API it does not use yet.
    struct ExistingBackend: Identifiable, Equatable, Hashable, Sendable {
        let key: String
        let status: BackendStatus
        /// The preset it was made from, for its name, brand and models.
        let preset: ProviderPreset?
        var id: String {
            key
        }

        var decision: BackendDecisionStatus? {
            status.decision
        }

        /// Whether the server may list its models: a local preset's server or
        /// one added by URL (the gateway answers `listed: false` for a hosted one).
        var listsModels: Bool {
            preset.map(\.isLocal) ?? true
        }

        /// Whether a readable API key is stored for the backend.
        var hasReadableKey: Bool {
            status.hasApiKey == true && decision?.apiKeySecretError == nil
        }

        /// Whether adding its provider's decision API needs a key typed: the
        /// provider refuses decision requests without one and the backend has
        /// none it can read.
        var needsKeyForDecisions: Bool {
            preset?.decision?.keyRequired == true && !hasReadableKey
        }
    }

    /// What a key typed while adding decisions to a backend becomes.
    static let sharedKeyNote = "It becomes this backend's key for its OpenAI-compatible and decision APIs."

    /// The provider list's line under a backend that can add decision models.
    static func enableSummary(_ backend: ExistingBackend) -> String {
        let provider = backend.preset?.name ?? backend.key
        return backend.needsKeyForDecisions ? "\(provider) — Needs a key" : "\(provider) — uses your existing key"
    }

    /// What the operator picked in the provider list.
    enum Choice: Hashable, Sendable {
        /// A backend whose decision API is set up.
        case existing(ExistingBackend)
        /// A backend whose provider offers a decision API it does not use
        /// yet: adding it reuses the backend's key.
        case enable(ExistingBackend)
        /// A new backend from a provider preset, or the built-in TypeSafe.
        case preset(ProviderPreset)
        /// Any other System One server, by URL.
        case custom
    }

    struct ProviderGroups: Equatable {
        /// Backends with a decision API.
        var existing: [ExistingBackend]
        /// Backends whose provider offers a decision API they do not use yet.
        var enable: [ExistingBackend]
        /// The built-in TypeSafe, when the gateway offers it.
        var typesafe: ProviderPreset?
        /// Providers to add as a new backend, leaving out every provider a
        /// backend was already made from: servers on the operator's machine
        /// first, then hosted APIs.
        var add: [ProviderPreset]
    }

    /// The provider list: backends with decisions, backends that can add
    /// them with the key they have, TypeSafe, then the providers to add.
    static func providerGroups(_ overview: ModelsOverview) -> ProviderGroups {
        let backends = overview.inference.backends
            .filter { $0.value.type == "http" }
            .map { key, status in ExistingBackend(key: key, status: status, preset: preset(id: status.preset, in: overview)) }
            .sorted { $0.key < $1.key }
        let enable = backends.filter { backend in
            guard backend.decision == nil, backend.key != typesafeKey, let preset = backend.preset else { return false }
            return preset.decision != nil && preset.builtIn == nil
        }
        let taken = Set(backends.compactMap(\.status.preset))
        let addable = overview.allProviders.filter { $0.decision != nil && $0.builtIn == nil && !taken.contains($0.id) }
        return ProviderGroups(
            existing: backends.filter { $0.decision != nil },
            enable: enable,
            typesafe: overview.allProviders.first { $0.isTypeSafe && $0.decision != nil },
            add: addable.filter(\.isLocal) + addable.filter { !$0.isLocal }
        )
    }

    static func preset(id: String?, in overview: ModelsOverview) -> ProviderPreset? {
        guard let id else { return nil }
        return overview.allProviders.first { $0.id == id }
    }

    // MARK: - Names

    /// The preset's id, or the first `<id>-N` no backend has taken yet.
    static func defaultName(for preset: ProviderPreset, in overview: ModelsOverview) -> String {
        if validateName(preset.id, in: overview) == nil { return preset.id }
        for suffix in 2 ... 99 where validateName("\(preset.id)-\(suffix)", in: overview) == nil {
            return "\(preset.id)-\(suffix)"
        }
        return ""
    }

    /// Nil when `raw` can name a new backend with a decision API, else the
    /// reason. The gateway enforces the same rules on save.
    static func validateName(_ raw: String, in overview: ModelsOverview) -> String? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return "Enter a name." }
        if name.contains("/") { return "A name cannot contain “/”." }
        if name == "." || name == ".." { return "“\(name)” cannot name a backend." }
        if reservedNames.contains(name) { return "“\(name)” is reserved. Pick another name." }
        // The gateway counts UTF-16 code units, as JavaScript strings do.
        if name.utf16.count > maxNameLength { return "Use \(maxNameLength) characters or fewer." }
        if overview.inference.backends[name] != nil { return "A backend is already called “\(name)”." }
        return nil
    }

    // MARK: - URLs

    enum URLFill: Equatable {
        case ready(String)
        /// A URL parameter has no value yet; carries its label.
        case missing(String)
    }

    /// Complete a preset's decision URL: each `{key}` is replaced by its
    /// value, trimmed and percent-encoded the way `encodeURIComponent` does.
    /// Mirrors `fillDecisionPresetUrl`.
    static func fillURL(_ decision: ProviderDecisionPreset, values: [String: String]) -> URLFill {
        var url = decision.url
        for param in decision.urlParams {
            let value = values[param.key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if value.isEmpty { return .missing(param.label) }
            let encoded = value.addingPercentEncoding(withAllowedCharacters: uriComponentAllowed) ?? value
            url = url.replacingOccurrences(of: "{\(param.key)}", with: encoded)
        }
        if let open = url.firstIndex(of: "{"), let close = url[open...].firstIndex(of: "}") {
            return .missing(String(url[url.index(after: open) ..< close]))
        }
        return .ready(url)
    }

    /// The characters `encodeURIComponent` leaves as they are.
    static let uriComponentAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    )

    /// Nil when `raw` is an http(s) URL with a host, else the reason.
    static func validateURL(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Enter the server's URL." }
        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty
        else { return "Enter a full URL, such as http://127.0.0.1:8080/v1/systemone." }
        return nil
    }

    /// Whether `raw` names the gateway's own host: `localhost`, a
    /// `.localhost` name, `::1` or a 127.x address. Mirrors
    /// `isLoopbackInferenceUrl`.
    static func isLoopback(_ raw: String) -> Bool {
        guard var host = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines))?.host?.lowercased() else {
            return false
        }
        host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".localhost") || host == "::1" { return true }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        guard octets.count == 4, octets[0] == "127" else { return false }
        return octets.allSatisfy { !$0.isEmpty && $0.count <= 3 && $0.allSatisfy(\.isNumber) }
    }

    // MARK: - Cloud consent

    /// Whether saving endpoints at `urls` must first turn on cloud inference:
    /// it is off (or unknown) and one of the URLs leaves the gateway's host.
    static func needsRemoteConsent(urls: [String], in overview: ModelsOverview) -> Bool {
        overview.inference.allowRemoteInference != true && urls.contains { !isLoopback($0) }
    }

    /// The same for the built-in TypeSafe slot, whose endpoint the gateway reports.
    static func typesafeNeedsRemoteConsent(in overview: ModelsOverview) -> Bool {
        overview.inference.allowRemoteInference != true && overview.inference.typesafe?.onHost != true
    }

    static let consentTitle = "Enable cloud inference?"
    static let consentConfirm = "Enable cloud inference"

    /// The portal's cloud-inference consent wording (`cloud-inference-consent.js`).
    static func consentMessage(model: String, provider: String) -> String {
        let subject = model.isEmpty ? "Cloud inference" : "Using \(model)"
        return "\(subject) sends messages, conversation context, and relevant Omnesis data and tool results "
            + "to \(provider). Depending on the capabilities you configure, this can also include search queries, "
            + "document chunks, audio, and images."
    }

    // MARK: - Models

    /// Model suggestions: what a local server listed first, then the preset's
    /// own decision models it did not list.
    static func modelOptions(preset: ProviderPreset?, probed: [String]) -> [DecisionModelOption] {
        let presetModels = preset?.decision?.models ?? []
        let byId = Dictionary(presetModels.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        var options: [DecisionModelOption] = []
        for id in probed where seen.insert(id).inserted {
            options.append(byId[id] ?? DecisionModelOption(id: id, source: "probe"))
        }
        for option in presetModels where seen.insert(option.id).inserted {
            options.append(option)
        }
        return options
    }

    /// "128K context · $0.20 per million input tokens", or the parts known; nil when none is.
    static func modelDetail(_ option: DecisionModelOption) -> String? {
        var parts: [String] = []
        if let tokens = option.contextTokens, tokens > 0 { parts.append("\(compactCount(tokens)) context") }
        if let cost = option.inputCostPerMillion {
            parts.append(cost == 0 ? "free" : "$\(formatCost(cost)) per million input tokens")
        }
        if option.source == "probe" { parts.append("on the server") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Context sizes as model cards write them: 131072 is "128K", 1000000 is "1M".
    private static func compactCount(_ value: Int) -> String {
        if value >= 1_000_000, value % 1_000_000 == 0 { return "\(value / 1_000_000)M" }
        if value >= 1024, value % 1024 == 0 { return "\(value / 1024)K" }
        if value >= 1000 { return "\(Int((Double(value) / 1000).rounded()))K" }
        return "\(value)"
    }

    /// Cents for most prices, a tenth of a cent below one cent.
    private static func formatCost(_ cost: Double) -> String {
        String(format: cost >= 0.01 ? "%.2f" : "%.3f", cost)
    }

    // MARK: - Form defaults

    struct FormDefaults: Equatable {
        let name: String
        let url: String
        let model: String
    }

    /// A form's starting values: the preset's id as the name (or the next free
    /// one), the decision URL, and the model in use or else the first suggestion.
    static func formDefaults(_ choice: Choice, in overview: ModelsOverview) -> FormDefaults {
        let current = overview.inference.assignments[role]
        switch choice {
        case .existing(let backend):
            let inUse = current?.kind == "decision" && current?.backendKey == backend.key ? current?.model : nil
            return FormDefaults(
                name: backend.key,
                url: backend.decision?.url ?? "",
                model: inUse ?? firstModel(backend.preset)
            )
        case .enable(let backend):
            return FormDefaults(name: backend.key, url: backend.preset?.decision?.url ?? "", model: firstModel(backend.preset))
        case .preset(let preset):
            let inUse = preset.isTypeSafe && current?.kind == "typesafe" ? current?.model : nil
            return FormDefaults(
                name: preset.isTypeSafe ? "" : defaultName(for: preset, in: overview),
                url: preset.decision?.url ?? "",
                model: inUse ?? firstModel(preset)
            )
        case .custom:
            return FormDefaults(name: "", url: "", model: "")
        }
    }

    private static func firstModel(_ preset: ProviderPreset?) -> String {
        preset?.decision?.models.first?.id ?? ""
    }
}
