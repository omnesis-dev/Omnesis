// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Voice and text share the existing snapshot/cursor handoff and one SSE reducer.
/// Complete it before microphone capture so the first spoken turn cannot race attachment.
@available(iOS 17.0, *)
@MainActor
enum RealtimeConversationHandoff {
    static func attach(id: String, to coordinator: AgentCoordinator) async throws {
        try Task.checkCancellation()
        // Closing voice must not cancel a shared read-only snapshot and leave text
        // showing a cancellation error. The normal HTTP timeout bounds this task;
        // the coordinator's selection generation still rejects a superseded thread.
        let handoff = Task { @MainActor in
            await coordinator.resumeConversation(id: id, forceRefresh: true)
            if let error = coordinator.fatalError { throw error }
            guard coordinator.sessionId == id, !coordinator.transcriptLoading else { throw URLError(.cancelled) }
        }
        try await handoff.value
        try Task.checkCancellation()
    }
}
