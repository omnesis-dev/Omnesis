// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The local notification for a question the watch queued, when the gateway's
/// slow-answer push will not announce how it ended: the turn settled inside
/// the push's budget, or the question never reached the gateway at all. The
/// watch told the user a notification would follow, so every way a queued
/// question can end produces exactly one — this or the gateway's push.
///
/// Pure, so the sim-less logic lane covers what each outcome says.
public struct QueuedAskNotice: Equatable, Sendable {
    public let title: String
    public let body: String
    /// The conversation a tap opens, when the question reached one.
    public let conversationId: String?

    /// Banner length, matching the gateway's slow-answer push so both read
    /// the same.
    static let maxBodyLength = 175

    /// The notice for `outcome`, or nil when the gateway's push is the one to
    /// announce it.
    public static func notice(for outcome: SiriAskOutcome, conversationId: String?) -> QueuedAskNotice? {
        switch outcome {
        case .stillWorking, .previousTurnRunning:
            nil
        case .answered(let text):
            QueuedAskNotice(title: "Answer ready", body: clipped(text), conversationId: conversationId)
        case .emptyAnswer, .failed:
            QueuedAskNotice(
                title: "Answer failed",
                body: clipped(SiriAskDialog.text(for: outcome)),
                conversationId: conversationId
            )
        // The watch-only outcomes never come from a hand-off; listed so a new
        // outcome has to be placed here deliberately.
        case .notPaired, .experimentalOff, .unauthorized, .unreachable, .sendFailed,
             .phoneUnreachable, .watchLinkInactive, .relayFailed, .answerOnPhone, .queuedForPhone:
            QueuedAskNotice(
                title: "Couldn't ask your watch question",
                body: clipped(SiriAskDialog.text(for: outcome)),
                conversationId: conversationId
            )
        }
    }

    /// The payload a tap routes on — the same shape as the gateway's answer
    /// push, so `PushTarget` opens the conversation either way.
    public var userInfo: [String: Any] {
        guard let conversationId else { return [:] }
        return ["omnesis": ["kind": "agent-answer", "targetId": conversationId]]
    }

    /// One line, clipped to banner length with an ellipsis marking the cut.
    static func clipped(_ text: String) -> String {
        let collapsed = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard collapsed.count > maxBodyLength else { return collapsed }
        return String(collapsed.prefix(maxBodyLength - 1)) + "…"
    }
}
