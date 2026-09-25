// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

/// Brief talk-back threads hide the steward internals from the user:
/// `AgentCoordinator.visibleMessages` drops the folded run transcript
/// (replaced visually by the brief card), and the steward toolset is
/// enrolled in `agentEphemeralTools` so resumed history rebuilds no tool
/// cards for it. The agent's server-side context is untouched by both.
@available(iOS 17.0, *)
final class AgentBriefThreadVisibilityTests: XCTestCase {
    private let seedMessages: [ChatMessage] = [
        .user(parts: [.text("Loop agent run run_1 (kind: daily, attempt 1).")]),
        .assistant(parts: [.text("Composed the morning brief.")]),
    ]
    private let followUp: [ChatMessage] = [
        .user(parts: [.text("Can you push the reminder to Friday?")]),
        .assistant(parts: [.text("Done — moved to Friday.")]),
    ]

    private func origin(
        withSnapshot: Bool = true,
        seedCount: Int? = 2
    )
        -> ConversationOrigin {
        ConversationOrigin(
            kind: "brief",
            briefId: "brief_1",
            runId: "run_1",
            brief: withSnapshot
                ? BriefOriginSnapshot(
                    title: "Return the borrowed projector",
                    description: "Back to the AV desk this week.",
                    body: nil
                )
                : nil,
            seedMessageCount: seedCount
        )
    }

    func testSeedPrefixHiddenWhenSnapshotAndCountPresent() {
        let visible = AgentCoordinator.visibleMessages(
            seedMessages + followUp,
            origin: origin()
        )
        XCTAssertEqual(visible.count, 2, "the 2-message seed must be dropped")
        guard case .user(let parts) = visible[0], case .text(let t) = parts[0] else {
            return XCTFail("first visible message should be the follow-up user text")
        }
        XCTAssertEqual(t, "Can you push the reminder to Friday?")
    }

    func testNoOriginShowsEverything() {
        let visible = AgentCoordinator.visibleMessages(seedMessages + followUp, origin: nil)
        XCTAssertEqual(visible.count, 4)
    }

    /// Threads created before snapshots existed have the anchor but no
    /// snapshot/count — hiding the seed would strand the reader with no
    /// context, so everything stays visible.
    func testAnchorWithoutSnapshotShowsEverything() {
        let visible = AgentCoordinator.visibleMessages(
            seedMessages + followUp,
            origin: origin(withSnapshot: false, seedCount: nil)
        )
        XCTAssertEqual(visible.count, 4)
    }

    /// A seed count larger than the message list (corrupt or truncated
    /// record) must not crash or hide the whole conversation.
    func testOversizedSeedCountShowsEverything() {
        let visible = AgentCoordinator.visibleMessages(
            seedMessages,
            origin: origin(seedCount: 10)
        )
        XCTAssertEqual(visible.count, 2)
    }

    func testSnapshotWithoutSeedCountShowsEverything() {
        let visible = AgentCoordinator.visibleMessages(
            seedMessages + followUp,
            origin: origin(seedCount: nil)
        )
        XCTAssertEqual(visible.count, 4)
    }

    /// Temporal-annotation origins carry no supported context card, so their
    /// extra fields are ignored and no transcript prefix is hidden.
    func testTemporalOriginDoesNotHideMessages() throws {
        let retired = try JSONDecoder().decode(
            ConversationOrigin.self,
            from: Data(
                """
                {
                  "kind":"temporal_annotation",
                  "annotationId":"annotation_1",
                  "runId":"run_1",
                  "annotation":{"sentence":"An old agent note."},
                  "seedMessageCount":2
                }
                """.utf8
            )
        )

        XCTAssertFalse(AgentCoordinator.hasContextCard(retired))
        XCTAssertEqual(
            AgentCoordinator.visibleMessages(seedMessages + followUp, origin: retired).count,
            4
        )
    }

    // MARK: - Watch-firing origins

    /// A thread the agent opened when a watch fired. The seed prefix here
    /// is the hidden briefing that told the agent what to write — showing
    /// it would open the conversation with an internal prompt.
    func testWatchFiringSeedPrefixHiddenWhenSnapshotAndCountPresent() throws {
        let origin = try JSONDecoder().decode(
            ConversationOrigin.self,
            from: Data(
                """
                {
                  "kind":"watch_firing",
                  "firingId":"sfiring_1",
                  "runId":"sfiring_1",
                  "watchId":"sub_1",
                  "watch":{
                    "name":"Marathon entry deadlines",
                    "condition":"a race I entered moves its registration deadline",
                    "firedAt":1789344600000
                  },
                  "seedMessageCount":1
                }
                """.utf8
            )
        )

        XCTAssertEqual(origin.firingId, "sfiring_1")
        XCTAssertEqual(origin.watchId, "sub_1")
        XCTAssertEqual(origin.watch?.name, "Marathon entry deadlines")
        XCTAssertEqual(origin.watch?.firedAt, 1_789_344_600_000)
        XCTAssertTrue(AgentCoordinator.hasContextCard(origin))

        let visible = AgentCoordinator.visibleMessages(
            [.user(parts: [.text("hidden briefing prompt")])] + followUp,
            origin: origin
        )
        XCTAssertEqual(visible.count, 2, "the 1-message briefing must be dropped")
        guard case .user(let parts) = visible[0], case .text(let text) = parts[0] else {
            return XCTFail("first visible message should be the follow-up user text")
        }
        XCTAssertEqual(text, "Can you push the reminder to Friday?")
    }

    /// A watch-firing anchor without its snapshot has no card to stand in
    /// for the hidden briefing, so nothing may be hidden.
    func testWatchFiringWithoutSnapshotShowsEverything() {
        let origin = ConversationOrigin(
            kind: "watch_firing",
            firingId: "sfiring_1",
            watchId: "sub_1",
            runId: "sfiring_1",
            seedMessageCount: 1
        )
        XCTAssertFalse(AgentCoordinator.hasContextCard(origin))
        let messages: [ChatMessage] = [.user(parts: [.text("hidden briefing prompt")])] + followUp
        XCTAssertEqual(AgentCoordinator.visibleMessages(messages, origin: origin).count, 3)
    }

    /// The steward toolset is ephemeral: resumed history must rebuild
    /// no tool part for any of its calls (mirrors the drop the builder
    /// already does for search/fetch/sql).
    func testLoopAgentToolUsesDroppedFromHistory() {
        let messages: [ChatMessage] = [
            .user(parts: [.text("Mark the projector loop done.")]),
            .assistant(parts: [
                .text("Updating the loop."),
                .toolUse(
                    toolCallId: "tu_loop",
                    tool: "open_loop_update",
                    args: JSONAny(value: ["id": "loop_1"] as [String: Any])
                ),
            ]),
            .user(parts: [
                .toolResult(
                    toolCallId: "tu_loop",
                    result: .unknown(kind: "text", raw: JSONAny(value: ["text": "ok"]))
                ),
            ]),
            .assistant(parts: [.text("Done — loop resolved.")]),
        ]
        let turns = AgentTurnBuilder.turns(from: messages)
        for turn in turns {
            guard case .assistant(let a) = turn else { continue }
            for part in a.parts {
                if case .tool(let call) = part {
                    XCTFail("no tool part should survive the rebuild, found \(call.tool)")
                }
            }
        }
    }

    /// Structured resultTypes humanize into the action card's outcome
    /// line ("brief.updated" → "Brief updated").
    func testHumanizeResultType() {
        XCTAssertEqual(agentHumanizeResultType("brief.updated"), "Brief updated")
        XCTAssertEqual(
            agentHumanizeResultType("open_loop.ledger_appended"),
            "Open loop ledger appended"
        )
        XCTAssertEqual(
            agentHumanizeResultType("temporal_annotation.added"),
            "Temporal annotation added"
        )
    }

    /// The whole steward toolset is enrolled — a missing name would
    /// leave a persistent card in past conversations for that tool.
    func testLoopAgentToolsetEnrolledInEphemeralSet() {
        let loopAgentTools = [
            "open_loop_search", "open_loop_fetch", "open_loop_create",
            "open_loop_update", "open_loop_delete", "open_loop_ledger_append",
            "brief_list", "brief_fetch", "brief_create", "brief_update",
            "brief_delete", "temporal_query", "temporal_annotation_add",
            "temporal_annotation_update", "temporal_annotation_delete",
            "notes_append", "notes_rewrite",
            "annotate_durable", "schedule_agent_run",
        ]
        for tool in loopAgentTools {
            XCTAssertTrue(
                agentEphemeralTools.contains(tool),
                "\(tool) missing from agentEphemeralTools"
            )
        }
    }

    func testInteractiveMemoryToolsetEnrolledInEphemeralSet() {
        let memoryTools = [
            "conversation_memory_evidence", "annotation_search", "annotate_durable",
            "annotation_revise", "annotation_retract", "annotation_supersede",
            "annotate_person", "person_annotation_revise", "person_annotation_retract",
            "person_annotation_supersede",
        ]
        for tool in memoryTools {
            XCTAssertTrue(
                agentEphemeralTools.contains(tool),
                "\(tool) missing from agentEphemeralTools"
            )
        }
    }
}
