// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

extension TasksClient {
    /// `POST /tasks/:id/conversation` — start a new chat about the task. Each
    /// call starts another; the conversation carries a `task` origin and no
    /// messages yet.
    public func startConversation(about id: String) async throws -> ConversationSummary {
        let data = try await dispatch(
            method: "POST",
            path: "/tasks/\(percentEncode(id))/conversation",
            body: Data("{}".utf8)
        )
        return try decodeOrThrow(TaskConversationResponse.self, from: data).conversation
    }
}

/// The body of `POST /tasks/:id/conversation`.
struct TaskConversationResponse: Decodable {
    let conversation: ConversationSummary

    private enum CodingKeys: String, CodingKey {
        case conversation
    }
}
