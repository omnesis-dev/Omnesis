// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Reopening a conversation whose last turn died must look like watching it die:
/// the same sentence, the same code, the same provider disposition, rendered by
/// the same error view the live stream drives.
///
/// Two halves are pinned here. `AgentTurnBuilder` lifts the failure marker the
/// session leaves in model-visible history out of the rendered text, so the
/// reader never sees the failure twice — and does so only where the session
/// actually writes it, so an answer that quotes the phrase survives whole. The
/// coordinator then folds the conversation record's own `lastTurnFailure` on
/// top, because that one carries the provider's disposition.
///
/// All fixture data is invented. Pure, so it runs in the sim-less logic lane.
@available(iOS 17.0, *)
@MainActor
final class ResumedTurnFailureTests: XCTestCase {
    // MARK: - Marker splitting

    func testMarkerAloneBecomesAFailureWithNoBody() {
        let split = AgentTurnBuilder.splitTerminalFailureMarker(
            "Model request failed: http_api_error: The model provider does not have the assigned model."
        )
        XCTAssertEqual(split?.body, "")
        XCTAssertEqual(split?.failure.code, "http_api_error")
        XCTAssertEqual(
            split?.failure.message,
            "The model provider does not have the assigned model."
        )
        XCTAssertNil(split?.failure.provider)
    }

    /// A turn that wrote something before it died keeps what it wrote.
    func testMarkerAfterABlankLineKeepsThePrecedingBody() {
        let split = AgentTurnBuilder.splitTerminalFailureMarker(
            "Here are the two invoices I found so far.\n\n"
                + "Model request failed: backend_unavailable: The model backend closed the stream."
        )
        XCTAssertEqual(split?.body, "Here are the two invoices I found so far.")
        XCTAssertEqual(split?.failure.code, "backend_unavailable")
        XCTAssertEqual(split?.failure.message, "The model backend closed the stream.")
    }

    /// The phrase inside a sentence is the assistant explaining a log line, not
    /// a turn reporting its own death.
    func testMidSentenceMentionIsNotAFailure() {
        XCTAssertNil(AgentTurnBuilder.splitTerminalFailureMarker(
            "The line in your log reads Model request failed: http_api_error: no such model, "
                + "which means the model assignment points at something the provider doesn't serve."
        ))
        XCTAssertNil(AgentTurnBuilder.splitTerminalFailureMarker(
            "The log line is:\nModel request failed: http_api_error: no such model"
        ), "one newline is not the blank line the session writes before the marker")
    }

    /// The marker's shape is `<code>: <sentence>`; without both halves there is
    /// nothing structured to lift, and the text stays an ordinary answer.
    func testMalformedMarkerIsLeftAlone() {
        XCTAssertNil(AgentTurnBuilder.splitTerminalFailureMarker("Model request failed: "))
        XCTAssertNil(AgentTurnBuilder.splitTerminalFailureMarker("Model request failed: cancelled"))
        XCTAssertNil(AgentTurnBuilder.splitTerminalFailureMarker("Model request failed: :  "))
    }

    // MARK: - Rebuilt transcript

    private func lastAssistant(_ turns: [AgentTurn]) -> AgentAssistantTurn? {
        for turn in turns.reversed() {
            if case .assistant(let assistant) = turn { return assistant }
        }
        return nil
    }

    private func texts(_ assistant: AgentAssistantTurn?) -> [String] {
        (assistant?.parts ?? []).compactMap { part in
            if case .text(let text) = part { return text }
            return nil
        }
    }

    func testRebuiltTurnRendersTheFailureInsteadOfTheMarkerProse() {
        let turns = AgentTurnBuilder.turns(from: [
            .user(parts: [.text("summarise the quarterly invoices")]),
            .assistant(parts: [
                .text("Model request failed: http_api_error: The model provider rejected the request."),
            ]),
        ])
        let assistant = lastAssistant(turns)
        XCTAssertEqual(texts(assistant), [], "the marker must not render as assistant prose")
        XCTAssertEqual(assistant?.failure?.code, "http_api_error")
        XCTAssertEqual(assistant?.failure?.message, "The model provider rejected the request.")
    }

    /// A stopped reply is an outcome, not a failure: the live view ends such a
    /// turn with no error affordance, so a reopened one says only that it
    /// stopped, keeping whatever the turn had written.
    func testRebuiltCanceledMarkerIsAStopNotAFailure() {
        let turns = AgentTurnBuilder.turns(from: [
            .user(parts: [.text("summarise the quarterly invoices")]),
            .assistant(parts: [
                .text("I found two invoices so far.\n\nModel request failed: canceled: You stopped this reply."),
            ]),
        ])
        let assistant = lastAssistant(turns)
        XCTAssertEqual(texts(assistant), ["I found two invoices so far."])
        XCTAssertEqual(assistant?.stopReason, "canceled")
        XCTAssertEqual(assistant?.stopped, "You stopped this reply.")
        XCTAssertNil(assistant?.failure, "a stop must not render as a failure")
    }

    /// Every other code still takes the failure path, and carries no stop note.
    func testRebuiltNonCanceledMarkerStillFails() {
        let turns = AgentTurnBuilder.turns(from: [
            .user(parts: [.text("summarise the quarterly invoices")]),
            .assistant(parts: [
                .text("Model request failed: backend_unavailable: The model backend closed the stream."),
            ]),
        ])
        let assistant = lastAssistant(turns)
        XCTAssertEqual(assistant?.failure?.code, "backend_unavailable")
        XCTAssertNil(assistant?.stopReason)
        XCTAssertNil(assistant?.stopped)
    }

    func testRebuiltTurnKeepsAnAnswerThatQuotesTheMarker() {
        let quoted = "Your log line Model request failed: http_api_error: no such model means "
            + "the assigned model is not one the provider serves."
        let turns = AgentTurnBuilder.turns(from: [
            .user(parts: [.text("what does this log line mean?")]),
            .assistant(parts: [.text(quoted)]),
        ])
        let assistant = lastAssistant(turns)
        XCTAssertEqual(texts(assistant), [quoted])
        XCTAssertNil(assistant?.failure)
    }

    // MARK: - Resumed conversation

    private func resume(assistantText: String, lastTurnFailure: AgentTerminalFailure?) async -> AgentAssistantTurn? {
        let coord = AgentCoordinator()
        await coord.applySnapshotForTesting(
            CreateSessionResponse(
                sessionId: "s_resumed",
                model: "fictional-model",
                backend: "openai-compatible",
                title: "Quarterly invoices",
                messages: [
                    .user(parts: [.text("summarise the quarterly invoices")]),
                    .assistant(parts: [.text(assistantText)]),
                ],
                messagesAreVisible: true,
                lastTurnFailure: lastTurnFailure
            ),
            buffered: []
        )
        return lastAssistant(coord.turns)
    }

    /// The case the record now carries for every code, not only a truncation.
    func testResumedNonTruncationFailureRendersStructurallyWithProviderDetail() async {
        let assistant = await resume(
            assistantText: "Model request failed: http_api_error: The model provider does not have the assigned model.",
            lastTurnFailure: AgentTerminalFailure(
                code: "http_api_error",
                message: "The model provider does not have the assigned model.",
                retryable: false,
                backend: "openai-compatible",
                model: "fictional-model",
                provider: AgentProviderFailureDetail(status: 404, code: "NOT_FOUND", param: "model")
            )
        )

        XCTAssertEqual(texts(assistant), [], "the marker must not render as assistant prose")
        XCTAssertEqual(assistant?.failure?.code, "http_api_error")
        XCTAssertEqual(
            assistant?.failure?.message,
            "The model provider does not have the assigned model."
        )
        XCTAssertEqual(
            assistant?.failure?.detailLine,
            "http_api_error · HTTP 404 · NOT_FOUND · param=model"
        )
        XCTAssertNil(assistant?.stopReason, "only a truncation ended mid-answer")
    }

    /// Whatever the turn managed to write before it died is still its answer.
    func testResumedFailureKeepsThePartialAnswerAboveIt() async {
        let assistant = await resume(
            assistantText: "I found two invoices in the quarterly folder.\n\n"
                + "Model request failed: backend_unavailable: The model backend closed the stream.",
            lastTurnFailure: AgentTerminalFailure(
                code: "backend_unavailable",
                message: "The model backend closed the stream.",
                retryable: true,
                backend: "openai-compatible",
                model: "fictional-model"
            )
        )

        XCTAssertEqual(texts(assistant), ["I found two invoices in the quarterly folder."])
        XCTAssertEqual(assistant?.failure?.code, "backend_unavailable")
        XCTAssertEqual(assistant?.failure?.detailLine, "backend_unavailable")
    }

    /// An answer that merely quotes the phrase is an answer; nothing about it
    /// changes on reopen.
    func testResumedAnswerQuotingTheMarkerSurvivesIntact() async {
        let quoted = "Your log line Model request failed: http_api_error: no such model means "
            + "the assigned model is not one the provider serves."
        let assistant = await resume(assistantText: quoted, lastTurnFailure: nil)

        XCTAssertEqual(texts(assistant), [quoted])
        XCTAssertNil(assistant?.failure)
        XCTAssertNil(assistant?.stopReason)
    }

    /// A stopped reply reopens the way it ended live — as a canceled turn, not
    /// a failed one — with the marker's sentence as its only trace. The record
    /// keeps no `lastTurnFailure` for a stop, so nothing folds on top.
    func testResumedStoppedReplyReadsAsStopped() async {
        let assistant = await resume(
            assistantText: "Model request failed: canceled: This reply was stopped.",
            lastTurnFailure: nil
        )

        XCTAssertEqual(texts(assistant), [], "the marker must not render as assistant prose")
        XCTAssertEqual(assistant?.stopReason, "canceled")
        XCTAssertEqual(assistant?.stopped, "This reply was stopped.")
        XCTAssertNil(assistant?.failure)
    }

    /// The truncation path is unchanged: it alone reports a `max_tokens` stop.
    func testResumedTruncationStillReportsTheOutputLimit() async {
        let assistant = await resume(
            assistantText: "The first two invoices are",
            lastTurnFailure: AgentTerminalFailure(
                code: "output_truncated",
                message: "The model reached its output limit before completing this response.",
                retryable: false,
                backend: "anthropic",
                model: "fictional-model",
                provider: AgentProviderFailureDetail(status: 200, code: "length")
            )
        )

        XCTAssertEqual(texts(assistant), ["The first two invoices are"])
        XCTAssertEqual(assistant?.stopReason, "max_tokens")
        XCTAssertEqual(assistant?.failure?.code, "output_truncated")
        XCTAssertEqual(
            assistant?.failure?.message,
            "The model reached its output limit before completing this response."
        )
        XCTAssertEqual(assistant?.failure?.detailLine, "output_truncated · HTTP 200 · length")
    }

    /// A record with no sentence still has to say something — an error bubble
    /// with no words explains nothing.
    func testResumedFailureWithoutASentenceFallsBackPerCode() async {
        let truncated = await resume(
            assistantText: "The first two invoices are",
            lastTurnFailure: AgentTerminalFailure(
                code: "output_truncated",
                message: "  ",
                retryable: false,
                backend: "anthropic",
                model: "fictional-model"
            )
        )
        XCTAssertEqual(
            truncated?.failure?.message,
            "The model reached its output limit before completing this response."
        )

        let other = await resume(
            assistantText: "The first two invoices are",
            lastTurnFailure: AgentTerminalFailure(
                code: "agent_failed",
                message: "",
                retryable: false,
                backend: "anthropic",
                model: "fictional-model"
            )
        )
        XCTAssertEqual(other?.failure?.message, "The turn failed.")
        XCTAssertNil(other?.stopReason)
    }
}
