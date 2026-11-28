// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Omnesis

/// Only explicit annotations ground an answer. Search hits are never presented as citations.
enum DesktopChatEvidence {
    static func annotations(in result: AgentToolResult) -> [AgentDocRef] {
        func reference(_ result: AgentToolResult) -> AgentDocRef? {
            guard case .annotateRecorded(_, let ref, _, _, _, _) = result else { return nil }
            return ref
        }
        switch result {
        case .annotateRecorded: return reference(result).map { [$0] } ?? []
        case .annotateBatch(let items): return items.compactMap(reference)
        default: return []
        }
    }

    static func references(in messages: [ChatMessage]) -> [AgentDocRef] {
        var references: [AgentDocRef] = []
        for message in messages {
            switch message {
            case .user(let parts):
                for part in parts {
                    if case .toolResult(_, let result) = part { references.append(contentsOf: annotations(in: result)) }
                }
            case .assistant(let parts):
                for part in parts {
                    if case .reportArtifact(let report) = part { references.append(contentsOf: report.citations) }
                }
            default: break
            }
        }
        return merging([], references)
    }

    static func merging(_ existing: [AgentDocRef], _ added: [AgentDocRef], removing removed: [String] = []) -> [AgentDocRef] {
        let removed = Set(removed)
        var order: [String] = [], byId: [String: AgentDocRef] = [:]
        for ref in existing + added where !removed.contains(ref.documentId) {
            if byId[ref.documentId] == nil { order.append(ref.documentId) }
            byId[ref.documentId] = ref
        }
        return order.compactMap { byId[$0] }
    }
}
