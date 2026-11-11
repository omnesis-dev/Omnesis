// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What a Decision model form asks for and what saving it sends.
extension DecisionModelSetup {
    // MARK: - API key field

    /// How a form treats the API key.
    struct KeyField: Equatable {
        /// Whether the form shows a key field at all.
        let shown: Bool
        /// Whether Save needs a typed key: the provider refuses requests
        /// without one and none is stored (or the stored one cannot be read).
        let required: Bool
        /// Whether a readable key is stored, so a blank field keeps it.
        let stored: Bool
    }

    /// TypeSafe's key is stored when the gateway resolved one for the
    /// current TypeSafe assignment, or the credential listing reports a file
    /// or an environment variable. `listed` is nil when the listing failed.
    static func typesafeKeyStored(listed: Bool?, in overview: ModelsOverview) -> Bool? {
        let current = overview.inference.assignments[role]
        if current?.kind == "typesafe", current?.hasApiKey == true { return true }
        return listed
    }

    /// Whether the listing names a TypeSafe key, in its file or the gateway's environment.
    static func typesafeKeyListed(_ entries: [ModelCredentialEntry]) -> Bool {
        entries.first { $0.fileKey == typesafeKey }.map { $0.configured || $0.environment == true } ?? false
    }

    /// The key field for a choice. `typesafeStored` is
    /// `typesafeKeyStored(listed:in:)`; nil (unknown) never makes a key
    /// required. A backend has one key for both of its APIs, so adding
    /// decisions to a backend asks for one only when it has none and the
    /// provider needs one.
    static func keyField(_ choice: Choice, in overview: ModelsOverview, typesafeStored: Bool?) -> KeyField {
        switch choice {
        case .preset(let preset) where preset.isTypeSafe:
            let selfHosted = overview.inference.typesafe?.selfHosted == true
            return KeyField(shown: true, required: typesafeStored == false && !selfHosted, stored: typesafeStored == true)
        case .preset(let preset):
            return KeyField(shown: true, required: preset.decision?.keyRequired == true, stored: false)
        case .custom:
            return KeyField(shown: true, required: false, stored: false)
        case .enable(let backend):
            let needed = backend.needsKeyForDecisions
            return KeyField(shown: needed, required: needed, stored: backend.hasReadableKey)
        case .existing(let backend):
            let keyRequired = backend.preset?.decision?.keyRequired == true
            let readable = backend.hasReadableKey
            return KeyField(
                shown: keyRequired || backend.listsModels || backend.status.hasApiKey == true,
                required: keyRequired && !readable,
                stored: readable
            )
        }
    }

    // MARK: - Saving

    /// A form's values, already validated, ready to save.
    struct Draft: Equatable, Sendable {
        let choice: Choice
        /// The backend's name: the existing key, or the new one typed.
        let name: String
        /// The decision endpoint URL, complete (unused for TypeSafe).
        let url: String
        /// The API key typed; blank keeps the stored one.
        let apiKey: String
        let model: String
        /// Whether the operator agreed to turn on cloud inference.
        let enableRemoteInference: Bool
    }

    /// What one save sends: the config patch, plus TypeSafe's key, which goes
    /// to its credential route instead of the config.
    struct SavePlan: Equatable, Sendable {
        let patch: DecisionConfigPatch
        let typesafeApiKey: String?
        let verifyTarget: VerifyTarget
    }

    /// The save for a form. A new backend gets every field its preset sets,
    /// its OpenAI-compatible URL too when the provider has one; a backend
    /// gaining decisions gets the preset's decision API and nothing else (its
    /// key serves both) — or, when it has no key and the provider needs one,
    /// the key typed too; an existing decision API only what changed (its URL,
    /// a new key), so the protocol, auth and score field written for it are
    /// never replaced by a preset's. The assignment is sent only when it changes.
    static func savePlan(_ draft: Draft, in overview: ModelsOverview) -> SavePlan {
        let model = draft.model.trimmingCharacters(in: .whitespacesAndNewlines)
        let apiKey = draft.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let typedKey = apiKey.isEmpty ? nil : apiKey
        let url = draft.url.trimmingCharacters(in: .whitespacesAndNewlines)
        switch draft.choice {
        case .preset(let preset) where preset.isTypeSafe:
            let assignment = "\(typesafeKey)/\(model)"
            return SavePlan(
                patch: DecisionConfigPatch(
                    assignment: assignmentChange(to: assignment, in: overview),
                    enableRemoteInference: draft.enableRemoteInference
                ),
                typesafeApiKey: typedKey,
                verifyTarget: .typesafe(model: model)
            )
        case .existing(let backend):
            let changedURL = url.isEmpty || url == backend.decision?.url ? nil : url
            let changes = DecisionConfigPatch.Backend(
                apiKey: typedKey,
                decision: changedURL.map { .set(DecisionConfigPatch.DecisionAPI(url: $0)) }
            )
            return backendPlan(
                key: backend.key,
                change: changes == DecisionConfigPatch.Backend() ? nil : changes,
                model: model,
                draft: draft,
                in: overview
            )
        case .enable(let backend):
            let api = backend.preset?.decision.map { DecisionConfigPatch.DecisionAPI(preset: $0, url: url) }
                ?? DecisionConfigPatch.DecisionAPI(url: url, protocol: "systemone", auth: "bearer")
            return backendPlan(
                key: backend.key,
                change: DecisionConfigPatch.Backend(apiKey: backend.needsKeyForDecisions ? typedKey : nil, decision: .set(api)),
                model: model,
                draft: draft,
                in: overview
            )
        case .preset(let preset):
            return newBackendPlan(draft, preset: preset, model: model, apiKey: typedKey)
        case .custom:
            return newBackendPlan(draft, preset: nil, model: model, apiKey: typedKey)
        }
    }

    private static func backendPlan(
        key: String,
        change: DecisionConfigPatch.Backend?,
        model: String,
        draft: Draft,
        in overview: ModelsOverview
    )
        -> SavePlan {
        SavePlan(
            patch: DecisionConfigPatch(
                backend: change.map { .upsert(key: key, $0) },
                assignment: assignmentChange(to: "\(key)/\(model)", in: overview),
                enableRemoteInference: draft.enableRemoteInference
            ),
            typesafeApiKey: nil,
            verifyTarget: .backend(key: key, model: model)
        )
    }

    private static func newBackendPlan(
        _ draft: Draft,
        preset: ProviderPreset?,
        model: String,
        apiKey: String?
    )
        -> SavePlan {
        let key = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let url = draft.url.trimmingCharacters(in: .whitespacesAndNewlines)
        let openAIURL = preset?.defaultUrl.flatMap { $0.isEmpty ? nil : $0 }
        let backend = DecisionConfigPatch.Backend(
            type: "http",
            preset: preset?.id,
            url: openAIURL,
            apiPathPrefix: openAIURL == nil ? nil : preset?.apiPathPrefix,
            apiKey: apiKey,
            decision: .set(
                preset?.decision.map { DecisionConfigPatch.DecisionAPI(preset: $0, url: url) }
                    ?? DecisionConfigPatch.DecisionAPI(url: url, protocol: "systemone", auth: "bearer")
            )
        )
        return SavePlan(
            patch: DecisionConfigPatch(
                backend: .upsert(key: key, backend),
                assignment: .set("\(key)/\(model)"),
                enableRemoteInference: draft.enableRemoteInference
            ),
            typesafeApiKey: nil,
            verifyTarget: .backend(key: key, model: model)
        )
    }

    /// `.keep` when the Decision model already is `assignment`.
    private static func assignmentChange(
        to assignment: String,
        in overview: ModelsOverview
    )
        -> DecisionConfigPatch.AssignmentChange {
        currentAssignment(overview) == assignment ? .keep : .set(assignment)
    }

    /// The current Decision assignment as its wire value, when it is a
    /// model on a backend's decision API or TypeSafe's.
    static func currentAssignment(_ overview: ModelsOverview) -> String? {
        switch currentVerifyTarget(overview) {
        case .backend(let key, let model): "\(key)/\(model)"
        case .typesafe(let model): "\(typesafeKey)/\(model)"
        case nil: nil
        }
    }

    /// Turning a backend's decisions off: a backend that also serves
    /// OpenAI-compatible models keeps them and loses only its decision API; a
    /// decision-only backend is removed whole. Either clears the Decision
    /// assignment when it points there.
    static func removalPatch(key: String, in overview: ModelsOverview) -> DecisionConfigPatch {
        let current = overview.inference.assignments[role]
        let pointsHere = current?.kind == "decision" && current?.backendKey == key
        let change: DecisionConfigPatch.BackendChange = overview.inference.backends[key]?.servesOpenAI == true
            ? .upsert(key: key, DecisionConfigPatch.Backend(decision: .remove))
            : .remove(key: key)
        return DecisionConfigPatch(backend: change, assignment: pointsHere ? .clear : .keep)
    }

    /// Whether saving an existing decision API needs cloud consent: the
    /// gateway's own verdict on its host, unless the URL is being changed.
    static func needsRemoteConsent(_ backend: ExistingBackend, url: String, in overview: ModelsOverview) -> Bool {
        let typed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let onHost = typed.isEmpty || typed == backend.decision?.url ? backend.decision?.onHost == true : isLoopback(typed)
        return overview.inference.allowRemoteInference != true && !onHost
    }
}
