// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Pure reducer that distils an agent event stream into the single
/// spoken answer a Siri ask needs. `VoiceAnswerEngine` feeds it every
/// decoded `AgentEvent` from `/agent/events`; the collector filters to
/// its session AND its watched assistant message, accumulates that
/// message's `textDelta`s, and reports a terminal `Outcome` when the
/// turn completes (`messageEnd`) or dies (`error`). No networking, no
/// clocks — the engine owns the transport and the deadline; this type
/// owns only the fold, so it is unit-testable in the sim-less logic
/// lane.
public struct VoiceAnswerCollector: Sendable, Equatable {
    /// How the turn ended, from this collector's point of view.
    public enum Outcome: Equatable, Sendable {
        /// The turn completed; `text` is the full assistant reply
        /// (empty when the turn produced no spoken text at all).
        case answered(text: String, stopReason: String)
        /// The gateway surfaced a turn-level `agent.error`.
        case failed(code: String, message: String)
    }

    /// Session whose events this collector folds; everything else on the
    /// shared caller-wide stream is ignored.
    public let sessionId: String
    /// The watched assistant turn — the `messageId` the send response
    /// returned. Required: a resumed session's stream can carry OTHER
    /// turns' events for the same session (a still-running previous
    /// turn, another device's ask), and gating on the session alone
    /// would let a foreign turn's `messageEnd` terminate this fold with
    /// the wrong text.
    public let messageId: String
    /// Assistant text accumulated so far.
    public private(set) var text: String = ""

    public init(sessionId: String, messageId: String) {
        self.sessionId = sessionId
        self.messageId = messageId
    }

    /// Fold one event. Returns the terminal outcome when this event
    /// completes the answer, nil while the turn is still streaming.
    public mutating func consume(_ event: AgentEvent) -> Outcome? {
        guard event.sessionId == sessionId else { return nil }
        switch event {
        case .textDelta(_, let deltaMessageId, let delta) where deltaMessageId == messageId:
            text += delta
            return nil
        case .messageEnd(_, let endMessageId, let stopReason, _) where endMessageId == messageId:
            return .answered(text: text, stopReason: stopReason)
        case .outputTruncated(_, let endMessageId, _, let failure)
            where endMessageId == messageId:
            return .failed(code: failure.code, message: failure.message)
        case .contextWindowExceeded(_, let endMessageId, _, let failure, _)
            where endMessageId == messageId:
            return .failed(code: failure.code, message: failure.message)
        case .error(_, let errorMessageId, let code, _, _)
            where (code == "context_window_exceeded" || code == "output_truncated")
            && (errorMessageId == nil || errorMessageId == messageId):
            // Live signal only; wait for the authoritative message-end failure.
            return nil
        case .error(_, let errorMessageId, let code, let message, _)
            where errorMessageId == nil || errorMessageId == messageId:
            // A turn-scoped error for the watched turn, or a
            // session-scoped error (nil messageId) that kills every turn
            // on the session. A foreign turn's error is ignored like its
            // other events.
            return .failed(code: code, message: message)
        default:
            return nil
        }
    }
}
