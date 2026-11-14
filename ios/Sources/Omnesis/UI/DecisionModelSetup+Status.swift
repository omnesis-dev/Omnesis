// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The verify wording the Decision model sheet shows.
extension DecisionModelSetup {
    // MARK: - Verify

    /// Which verify route checks a model.
    enum VerifyTarget: Equatable, Hashable, Sendable {
        case backend(key: String, model: String)
        case typesafe(model: String)

        var model: String {
            switch self {
            case .backend(_, let model), .typesafe(let model): model
            }
        }
    }

    /// The verify target for the current assignment, when it is a model on a
    /// backend's decision API or TypeSafe's.
    static func currentVerifyTarget(_ overview: ModelsOverview) -> VerifyTarget? {
        guard let current = overview.inference.assignments[role], let model = current.model, !model.isEmpty else {
            return nil
        }
        switch current.kind {
        case "decision":
            guard let key = current.backendKey else { return nil }
            return .backend(key: key, model: model)
        case "typesafe":
            return .typesafe(model: model)
        default:
            return nil
        }
    }

    /// "Answered in 240 ms", naming the model that answered when it is not
    /// the one asked for (an alias the server resolved), or the gateway's
    /// reason as written.
    static func verifyText(_ result: DecisionVerifyResult, model: String?) -> String {
        if result.ok {
            var text = result.latencyMs.map { "Answered in \($0) ms" } ?? "Answered"
            if let answeredBy = result.answeredBy, !answeredBy.isEmpty, answeredBy != model {
                text += " by \(answeredBy)"
            }
            return text
        }
        let reason = result.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return reason.isEmpty ? "The model did not answer." : reason
    }

    /// What a model listing says beside the model field: the reason it
    /// failed, or that a listed server has no models; nil otherwise.
    static func probeNote(_ result: DecisionProbeResult) -> String? {
        if !result.ok {
            let reason = result.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return reason.isEmpty ? "The server did not list its models." : reason
        }
        return result.listed && result.models.isEmpty ? "The server lists no models yet." : nil
    }
}
