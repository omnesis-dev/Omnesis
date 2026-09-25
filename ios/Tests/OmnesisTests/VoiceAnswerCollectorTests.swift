// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class VoiceAnswerCollectorTests: XCTestCase {
    private let sessionId = "sess-voice-1"
    private let messageId = "m-watched"

    private func makeCollector() -> VoiceAnswerCollector {
        VoiceAnswerCollector(sessionId: sessionId, messageId: messageId)
    }

    func testAccumulatesDeltasAndCompletesOnMessageEnd() {
        var collector = makeCollector()
        XCTAssertNil(collector.consume(.messageStart(sessionId: sessionId, messageId: messageId)))
        XCTAssertNil(collector.consume(.textDelta(sessionId: sessionId, messageId: messageId, delta: "Your next ")))
        XCTAssertNil(collector.consume(.textDelta(sessionId: sessionId, messageId: messageId, delta: "meeting is ")))
        XCTAssertNil(collector.consume(.textDelta(sessionId: sessionId, messageId: messageId, delta: "at three.")))
        XCTAssertEqual(
            collector.consume(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "end_turn")),
            .answered(text: "Your next meeting is at three.", stopReason: "end_turn")
        )
    }

    func testIgnoresEventsFromOtherSessions() {
        var collector = makeCollector()
        XCTAssertNil(collector.consume(.textDelta(sessionId: "sess-other", messageId: messageId, delta: "noise")))
        // A foreign messageEnd must not terminate this session's fold.
        XCTAssertNil(collector.consume(.messageEnd(sessionId: "sess-other", messageId: messageId, stopReason: "end_turn")))
        XCTAssertNil(collector.consume(.textDelta(sessionId: sessionId, messageId: messageId, delta: "Sunny, 21 degrees.")))
        XCTAssertEqual(
            collector.consume(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "end_turn")),
            .answered(text: "Sunny, 21 degrees.", stopReason: "end_turn")
        )
    }

    /// A resumed session's stream can carry another turn's events — a
    /// still-running previous ask, another device's turn — with the SAME
    /// sessionId. Those must neither pollute the answer nor terminate
    /// the fold, even when they complete BEFORE the watched message's
    /// events arrive.
    func testIgnoresOtherTurnsOnTheSameSession() {
        var collector = makeCollector()
        XCTAssertNil(collector.consume(.textDelta(sessionId: sessionId, messageId: "m-prev", delta: "stale answer")))
        XCTAssertNil(collector.consume(.messageEnd(sessionId: sessionId, messageId: "m-prev", stopReason: "end_turn")))
        XCTAssertNil(collector.consume(.textDelta(sessionId: sessionId, messageId: messageId, delta: "Fresh answer.")))
        XCTAssertEqual(
            collector.consume(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "end_turn")),
            .answered(text: "Fresh answer.", stopReason: "end_turn")
        )
    }

    func testNonTextEventsDoNotPolluteTheAnswer() {
        var collector = makeCollector()
        XCTAssertNil(collector.consume(.thinkingDelta(sessionId: sessionId, messageId: messageId, delta: "pondering")))
        XCTAssertNil(collector.consume(.userMessage(sessionId: sessionId, userMessageId: "u1", text: "echo")))
        XCTAssertEqual(
            collector.consume(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "end_turn")),
            .answered(text: "", stopReason: "end_turn")
        )
    }

    func testKeepsNonDefaultStopReason() {
        var collector = makeCollector()
        XCTAssertNil(collector.consume(.textDelta(sessionId: sessionId, messageId: messageId, delta: "Partial answer")))
        XCTAssertEqual(
            collector.consume(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "max_tokens")),
            .answered(text: "Partial answer", stopReason: "max_tokens")
        )
    }

    func testOutputTruncationWaitsForMessageEndAndFailsHonestly() {
        var collector = makeCollector()
        let failure = AgentTerminalFailure(
            code: "output_truncated",
            message: "The model reached its output limit before completing this response.",
            retryable: false,
            backend: "openai-compatible",
            model: "fictional-model"
        )
        XCTAssertNil(collector.consume(.textDelta(
            sessionId: sessionId,
            messageId: messageId,
            delta: "Partial answer"
        )))
        XCTAssertNil(collector.consume(.error(
            sessionId: sessionId,
            messageId: messageId,
            code: "output_truncated",
            message: failure.message,
            provider: nil
        )))
        XCTAssertEqual(
            collector.consume(.outputTruncated(
                sessionId: sessionId,
                messageId: messageId,
                stopReason: "max_tokens",
                failure: failure
            )),
            .failed(code: "output_truncated", message: failure.message)
        )
    }

    func testStreamErrorSurfacesAsFailure() {
        var collector = makeCollector()
        XCTAssertNil(collector.consume(.textDelta(sessionId: sessionId, messageId: messageId, delta: "Half an ans")))
        XCTAssertEqual(
            collector.consume(.error(
                sessionId: sessionId,
                messageId: messageId,
                code: "backend_unavailable",
                message: "model backend closed the stream",
                provider: nil
            )),
            .failed(code: "backend_unavailable", message: "model backend closed the stream")
        )
    }

    func testContextErrorWaitsForAuthoritativeMessageEnd() {
        var collector = makeCollector()
        let failure = AgentTerminalFailure(
            code: "context_window_exceeded",
            message:
            "This conversation no longer fits in the selected model's context window. "
                + "Start a new conversation to continue.",
            retryable: false,
            backend: "openai-compatible",
            model: "fictional-model"
        )
        XCTAssertNil(
            collector.consume(
                .error(
                    sessionId: sessionId,
                    messageId: messageId,
                    code: failure.code,
                    message: failure.message,
                    provider: nil
                )
            )
        )
        XCTAssertEqual(
            collector.consume(
                .contextWindowExceeded(
                    sessionId: sessionId,
                    messageId: messageId,
                    stopReason: "error",
                    failure: failure,
                    context: nil
                )
            ),
            .failed(code: failure.code, message: failure.message)
        )
    }

    /// A session-scoped error (nil messageId) kills every turn on the
    /// session, including the watched one.
    func testSessionScopedErrorFailsTheWatchedTurn() {
        var collector = makeCollector()
        XCTAssertEqual(
            collector.consume(.error(
                sessionId: sessionId,
                messageId: nil,
                code: "session_reset",
                message: "gateway restarted",
                provider: nil
            )),
            .failed(code: "session_reset", message: "gateway restarted")
        )
    }

    /// Another turn's error must not fail the watched fold.
    func testOtherTurnsErrorIsIgnored() {
        var collector = makeCollector()
        XCTAssertNil(collector.consume(.error(
            sessionId: sessionId,
            messageId: "m-prev",
            code: "backend_unavailable",
            message: "previous turn died",
            provider: nil
        )))
        XCTAssertNil(collector.consume(.textDelta(sessionId: sessionId, messageId: messageId, delta: "Still fine.")))
        XCTAssertEqual(
            collector.consume(.messageEnd(sessionId: sessionId, messageId: messageId, stopReason: "end_turn")),
            .answered(text: "Still fine.", stopReason: "end_turn")
        )
    }
}
