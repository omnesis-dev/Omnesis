// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

extension ConversationOrigin {
    /// A chat the operator started about one of their tasks.
    public var isTask: Bool {
        kind == "task"
    }

    /// The task card's content, for a task chat whose snapshot this build can read.
    public var taskCard: TaskConversationOriginSnapshot? {
        isTask ? task : nil
    }
}

/// The task fields needed to draw the card at the top of a chat about that
/// task. A snapshot taken when the chat was started: the card still renders
/// after the task is renamed, completed or deleted.
public struct TaskConversationOriginSnapshot: Decodable, Sendable, Equatable {
    public let title: String
    /// The task's state as `/tasks` reports it (`open`, `snoozed`, `done`,
    /// `dismissed`); a state this build does not know is shown as written.
    public let state: String
    /// The day its deadline falls due (`YYYY-MM-DD`), when it has one.
    public let due: String?
    /// How many documents the task refers to.
    public let sourceCount: Int

    public init(title: String, state: String, due: String? = nil, sourceCount: Int = 0) {
        self.title = title
        self.state = state
        self.due = due
        self.sourceCount = sourceCount
    }

    private enum CodingKeys: String, CodingKey {
        case title, state, due, sourceCount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decode(String.self, forKey: .title)
        state = try container.decodeIfPresent(String.self, forKey: .state) ?? "open"
        due = try container.decodeIfPresent(String.self, forKey: .due)
        sourceCount = try container.decodeIfPresent(Int.self, forKey: .sourceCount) ?? 0
    }
}
