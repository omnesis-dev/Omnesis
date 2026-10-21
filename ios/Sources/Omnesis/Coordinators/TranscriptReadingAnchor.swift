// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Where a conversation opens: the reading anchor.
///
/// After a load, when the agent is idle and the transcript ends on an
/// assistant reply the reader has not yet been positioned on, the transcript
/// opens with that reply's top at the top of the view, so the reader starts at
/// the beginning of what they have not read. Otherwise — a reply pending after
/// the owner's message, a turn in flight, a reply already read — it follows the
/// bottom.
///
/// A finished reply is identified by its conversation and the conversation's
/// message count, both fixed once the reply has ended. The same rule runs on
/// Android and in the portal.
@available(iOS 17.0, *)
enum TranscriptReadingAnchor {
    /// What the reader has already been shown.
    enum Seen: Equatable {
        /// The reply the transcript last opened on.
        case reply(String)
        /// A reply in this conversation finished streaming while the reader
        /// watched; the next load of the conversation names it.
        case watched(sessionId: String)
    }

    struct Decision: Equatable {
        /// The turn whose top the transcript opens on; nil follows the bottom.
        var turnId: String?
        var seen: Seen?
    }

    static func decide(
        sessionId: String?,
        busy: Bool,
        turns: [AgentTurn],
        messageCount: Int,
        seen: Seen?
    )
        -> Decision {
        guard !busy, let sessionId, case .assistant(let last) = turns.last else {
            return Decision(turnId: nil, seen: seen)
        }
        // A snapshot that carries no count counts its turns instead.
        let reply = "\(sessionId)#\(messageCount > 0 ? messageCount : turns.count)"
        if seen == .reply(reply) { return Decision(turnId: nil, seen: seen) }
        if seen == .watched(sessionId: sessionId) { return Decision(turnId: nil, seen: .reply(reply)) }
        return Decision(turnId: last.id, seen: .reply(reply))
    }

    /// The record once a reply finishes streaming: watched when the
    /// conversation was on screen in the foreground, unread otherwise.
    static func replyEnded(sessionId: String?, watching: Bool) -> Seen? {
        guard watching, let sessionId else { return nil }
        return .watched(sessionId: sessionId)
    }
}
