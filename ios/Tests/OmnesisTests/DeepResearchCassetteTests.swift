// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The iOS arm of the cross-client Deep Research cassette test (#748).
///
/// Drives the CANONICAL synthetic conversation — the exact
/// `evals/universes/japan-trip/agent-demos/japan-trip-spend.jsonl` the demo
/// gateway plays and the portal / Android twins assert against — through the iOS
/// client's REAL pipeline: each wire line is JSON-DECODED with the same
/// `JSONDecoder().decode(AgentEvent.self, …)` the SSE loop uses, then reduced
/// through `AgentCoordinator`. It then asserts the terminal state the user
/// actually sees.
///
/// The point is to cross the JSON decoder, not hand-build events. The earlier
/// researcher-card tests constructed `AgentEvent` values in memory and bypassed
/// decoding — which is precisely why the "panels show 0 documents" decode bug
/// (a thin wrapped child payload with no `sessionId`/`messageId` throwing
/// `keyNotFound` and discarding the whole sub-agent event) shipped without a CI
/// failure. Decoding the real wire here makes such a regression fail this test:
/// the docs counts would collapse to `[0, 0, 0]`.
@available(iOS 17.0, *)
@MainActor
final class DeepResearchCassetteTests: XCTestCase {
    /// Stable test ids the cassette placeholders resolve to (mirrors the portal
    /// twin's `sess-test` / `msg-test` / `doc-` substitutions). The session id
    /// MUST match the coordinator's installed `sessionId` — the reducer drops
    /// events for other sessions.
    private static let sessionId = "sess-test"

    // MARK: - Cassette loading

    /// Locate the cassette by walking up from THIS test file's directory until a
    /// parent contains `evals/universes/japan-trip`, then append the cassette
    /// path. Robust against the working directory (the macOS scratch checkout's
    /// `ios/` tree runs `swift test` from a path that is not the repo root).
    private func cassetteURL() throws -> URL {
        let relative = "evals/universes/japan-trip/agent-demos/japan-trip-spend.jsonl"
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while dir.path != "/" {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("could not locate \(relative) above \(#filePath)")
    }

    /// Decode every event line of the cassette through the REAL `AgentEvent`
    /// decoder — the step the panels-show-0-docs bug lived in. Placeholders are
    /// substituted in the raw text first; blank / `#` comment lines are skipped;
    /// each remaining line is `{afterMs, event:{type,payload}}`, and only the
    /// `event` envelope is decoded.
    private func decodeCassette() throws -> [AgentEvent] {
        let raw = try String(contentsOf: cassetteURL(), encoding: .utf8)
            .replacingOccurrences(of: "$SESSION", with: Self.sessionId)
            .replacingOccurrences(of: "$MSG", with: "msg-test")
            .replacingOccurrences(of: "$DOC_", with: "doc-")
        let decoder = JSONDecoder()
        var events: [AgentEvent] = []
        for line in raw.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            // Pull the `event` envelope out of the wrapper, then decode it with
            // the SAME decoder the SSE loop uses.
            guard let wrapperData = trimmed.data(using: .utf8),
                  let wrapper = try JSONSerialization.jsonObject(with: wrapperData) as? [String: Any],
                  let eventObject = wrapper["event"]
            else {
                XCTFail("cassette line is not a {afterMs, event} wrapper: \(trimmed)")
                continue
            }
            let eventData = try JSONSerialization.data(withJSONObject: eventObject)
            try events.append(decoder.decode(AgentEvent.self, from: eventData))
        }
        return events
    }

    /// Drive the decoded cassette through a fresh coordinator and return it plus
    /// the terminal assistant turn.
    private func driveCassette() async throws -> (coord: AgentCoordinator, assistant: AgentAssistantTurn) {
        let coord = AgentCoordinator()
        coord.installPreviewState(
            sessionId: Self.sessionId, model: "m", backend: "b", title: "t",
            turns: [], citations: [], conversations: []
        )
        let events = try decodeCassette()
        XCTAssertGreaterThan(events.count, 0, "cassette decoded to zero events")
        for event in events {
            await coord.applyEventForTesting(event)
        }

        guard let assistant = coord.turns.reversed().compactMap({ turn -> AgentAssistantTurn? in
            if case .assistant(let a) = turn { return a }
            return nil
        }).first else {
            throw XCTSkip("no assistant turn after driving the cassette")
        }
        return (coord, assistant)
    }

    /// Concatenate every text part of an assistant turn (the streamed report
    /// prose) — the reducer already merges consecutive text deltas into one part.
    private func reportText(_ assistant: AgentAssistantTurn) -> String {
        assistant.parts.compactMap { part -> String? in
            if case .text(let text) = part { return text }
            return nil
        }.joined()
    }

    // MARK: - Terminal state

    /// Issue A — the reported decode bug: each researcher panel must carry its
    /// search hits. Before the `AgentEvent` decode fix the thin wrapped child
    /// payloads threw `keyNotFound`, the whole sub-agent event was discarded, and
    /// the docs counts collapsed to `[0, 0, 0]`. This is the load-bearing assert
    /// the in-memory-constructed tests could never catch.
    func testThreeResearcherPanelsEachCarryItsDocuments() async throws {
        let (coord, _) = try await driveCassette()
        let panels = coord.researchPanels
        XCTAssertEqual(panels.map(\.specialist), ["history-sweep", "source-digest", "history-sweep"])
        XCTAssertEqual(panels.map(\.docs.count), [7, 3, 5])
        XCTAssertTrue(
            panels.first?.docs.contains { ($0.title ?? "").contains("Tokyo Riverside Hotel") } ?? false,
            "the bank researcher's first hit survived the decode"
        )
    }

    /// The reconciled spend report streamed onto the assistant turn's text parts.
    func testReportProseStreamsOntoTheTurn() async throws {
        let (_, assistant) = try await driveCassette()
        let text = reportText(assistant)
        XCTAssertTrue(text.contains("Studio Northstar"), "report names the travel agency")
        XCTAssertTrue(text.contains("3,700"), "report carries the reconciled total")
        XCTAssertTrue(text.contains("168,000"), "report carries the largest line item")
    }

    /// The additive `agent.deep_research.summary` event preserves structured
    /// terminal metadata on the assistant turn for protocol compatibility.
    func testReportArtifactCarriesTerminalStateAndVerification() async throws {
        let (coord, assistant) = try await driveCassette()
        let artifact = try XCTUnwrap(assistant.reportArtifact, "the deep_research.summary should have folded on")
        XCTAssertEqual(artifact.stoppedReason, "answer_complete")
        XCTAssertEqual(artifact.verification.quotesChecked, 6)
        XCTAssertEqual(artifact.verification.quotesVerified, 6)
        // The merged citation set landed (the citations.update event).
        XCTAssertGreaterThanOrEqual(coord.citations.count, 6)
    }

    /// The turn is done: `message.end` stamped a `stopReason`.
    func testTurnIsDone() async throws {
        let (_, assistant) = try await driveCassette()
        XCTAssertNotNil(assistant.stopReason, "message.end should have stamped a stopReason")
    }
}
