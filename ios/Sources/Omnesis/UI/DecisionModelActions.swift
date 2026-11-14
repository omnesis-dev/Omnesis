// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The gateway calls the Decision model sheet makes, as closures so previews
/// and snapshots render the sheet without a paired gateway.
struct DecisionModelActions: Sendable {
    /// Save a choice: TypeSafe's key to its credential route first, then the
    /// config patch unless it changes nothing.
    var save: @Sendable (DecisionModelSetup.SavePlan) async throws -> Void
    /// Apply a patch that turns a backend's decisions off.
    var remove: @Sendable (DecisionConfigPatch) async throws -> Void
    var verify: @Sendable (DecisionModelSetup.VerifyTarget) async throws -> DecisionVerifyResult
    /// The models a saved backend's decision server lists.
    var probe: @Sendable (String) async throws -> DecisionProbeResult
    /// The models a server lists before it is saved.
    var probeURL: @Sendable (DecisionProbeRequest) async throws -> DecisionProbeResult
    /// Whether the credential listing names a TypeSafe key (file or
    /// environment); nil when the listing cannot be read.
    var typesafeKeyListed: @Sendable () async -> Bool?

    /// The calls against a paired gateway; every call fails without one.
    static func live(_ client: AdminClient?) -> DecisionModelActions {
        guard let client else { return unavailable }
        return DecisionModelActions(
            save: { plan in
                if let key = plan.typesafeApiKey {
                    try await client.setModelCredentials(fileKey: DecisionModelSetup.typesafeKey, fields: ["apiKey": key])
                }
                if !plan.patch.isEmpty {
                    try await client.patchDecisionConfig(plan.patch)
                }
            },
            remove: { patch in try await client.patchDecisionConfig(patch) },
            verify: { target in
                switch target {
                case .backend(let key, let model): try await client.verifyBackendDecision(key: key, model: model)
                case .typesafe(let model): try await client.verifyTypeSafeDecision(model: model)
                }
            },
            probe: { key in try await client.probeBackendDecision(key: key) },
            probeURL: { request in
                try await client.probeDecisionURL(
                    url: request.url,
                    auth: request.auth,
                    apiKey: request.apiKey,
                    protocol: request.protocol,
                    preset: request.preset,
                    backendKey: request.backendKey
                )
            },
            typesafeKeyListed: {
                guard let entries = try? await client.listModelCredentials() else { return nil }
                return DecisionModelSetup.typesafeKeyListed(entries)
            }
        )
    }

    static let unavailable = DecisionModelActions(
        save: { _ in throw URLError(.cannotConnectToHost) },
        remove: { _ in throw URLError(.cannotConnectToHost) },
        verify: { _ in throw URLError(.cannotConnectToHost) },
        probe: { _ in throw URLError(.cannotConnectToHost) },
        probeURL: { _ in throw URLError(.cannotConnectToHost) },
        typesafeKeyListed: { nil }
    )
}

/// What a form asks a decision server before it is saved: its URL, and how
/// to send a typed key or the saved key of the backend it is being added to.
struct DecisionProbeRequest: Equatable, Hashable, Sendable {
    let url: String
    var auth: String?
    var apiKey: String?
    var `protocol`: String?
    var preset: String?
    var backendKey: String?
}
