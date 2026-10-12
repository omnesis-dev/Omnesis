// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

/// What a conversation's origin changes on screen: a watch thread hides the
/// folded run transcript behind its card, the Morning brief thread is
/// undeletable and scopes its citation timeline to the latest brief, and the
/// steward toolset never rebuilds cards into resumed history.
@available(iOS 17.0, *)
final class AgentConversationOriginTests: XCTestCase {
    private let seedMessages: [ChatMessage] = [
        .user(parts: [.text("Watch run run_1 fired.")]),
        .assistant(parts: [.text("Composed the firing note.")]),
    ]
    private let followUp: [ChatMessage] = [
        .user(parts: [.text("Can you push the reminder to Friday?")]),
        .assistant(parts: [.text("Done — moved to Friday.")]),
    ]

    private func watchOrigin(seedCount: Int? = 2) -> ConversationOrigin {
        ConversationOrigin(
            kind: "watch_firing",
            firingId: "sfiring_1",
            watchId: "sub_1",
            runId: "sfiring_1",
            watch: WatchFiringOriginSnapshot(
                name: "Marathon entry deadlines",
                condition: "a race I entered moves its registration deadline",
                firedAt: 1_789_344_600_000
            ),
            seedMessageCount: seedCount
        )
    }

    func testNoOriginShowsEverything() {
        let visible = AgentCoordinator.visibleMessages(seedMessages + followUp, origin: nil)
        XCTAssertEqual(visible.count, 4)
    }

    /// A seed count larger than the message list (corrupt or truncated
    /// record) must not crash or hide the whole conversation.
    func testOversizedSeedCountShowsEverything() {
        let visible = AgentCoordinator.visibleMessages(seedMessages, origin: watchOrigin(seedCount: 10))
        XCTAssertEqual(visible.count, 2)
    }

    func testSnapshotWithoutSeedCountShowsEverything() {
        let visible = AgentCoordinator.visibleMessages(seedMessages + followUp, origin: watchOrigin(seedCount: nil))
        XCTAssertEqual(visible.count, 4)
    }

    // MARK: - Morning brief origins

    private func message(_ text: String, user: Bool = false) -> ChatMessage {
        user ? .user(parts: [.text(text)]) : .assistant(parts: [.text(text)])
    }

    /// The messages page carries the full origin: every brief reference,
    /// oldest first. A malformed reference is dropped on its own.
    func testDailyBriefOriginDecodes() throws {
        let origin = try JSONDecoder().decode(
            ConversationOrigin.self,
            from: Data(
                """
                {
                  "kind":"daily_brief",
                  "runId":"run_morning_2",
                  "briefs":[
                    {"day":"2026-10-13","messageIndex":0,"messageId":"m_1"},
                    {"day":"2026-10-14","messageIndex":"not a number","messageId":"m_bad"},
                    {"day":"2026-10-14","messageIndex":4,"messageId":"m_2"}
                  ]
                }
                """.utf8
            )
        )
        XCTAssertTrue(origin.isDailyBrief)
        XCTAssertEqual(origin.runId, "run_morning_2")
        XCTAssertEqual(origin.briefs.map(\.messageId), ["m_1", "m_2"])
        XCTAssertEqual(origin.latestDailyBrief, DailyBriefMessageRef(day: "2026-10-14", messageIndex: 4, messageId: "m_2"))
        XCTAssertFalse(AgentCoordinator.hasContextCard(origin), "the Morning brief has no pinned card")
    }

    /// A summary's daily-brief origin has no `briefs`; it still decodes, and
    /// it is what makes the row undeletable.
    func testConversationSummaryWithDailyBriefOriginIsNotDeletable() throws {
        let summaries = try JSONDecoder().decode(
            ConversationListPage.self,
            from: Data(
                """
                {"conversations":[
                  {"id":"s_brief","title":"Morning brief","model":"m","backend":"b",
                   "createdAt":"2026-10-01T07:00:00Z","updatedAt":"2026-10-14T07:00:00Z",
                   "messageCount":12,"pinned":true,
                   "origin":{"kind":"daily_brief","runId":"run_morning_1","briefs":[]}},
                  {"id":"s_plain","title":"Q4 budget review","model":"m","backend":"b",
                   "createdAt":"2026-10-01T07:00:00Z","updatedAt":"2026-10-14T07:00:00Z",
                   "messageCount":4},
                  {"id":"s_future","title":"Something new","model":"m","backend":"b",
                   "createdAt":"2026-10-01T07:00:00Z","updatedAt":"2026-10-14T07:00:00Z",
                   "messageCount":4,"origin":{"kind":"from_the_future"}}
                ],"nextCursor":null}
                """.utf8
            )
        )
        XCTAssertEqual(summaries.conversations.map(\.isDeletable), [false, true, true])
        XCTAssertEqual(summaries.conversations[0].origin?.briefs, [])
        XCTAssertNil(summaries.conversations[2].origin, "an unreadable origin leaves a plain conversation")
        XCTAssertFalse(summaries.conversations[0].withPinned(false).isDeletable, "copies keep the origin")
        XCTAssertFalse(summaries.conversations[0].markedRead().isDeletable)
    }

    func testMessagePageCarriesOrigin() throws {
        let page = try JSONDecoder().decode(
            ConversationMessagePage.self,
            from: Data(
                """
                {"messages":[],"messageCount":7,"messagesAreVisible":true,
                 "origin":{"kind":"daily_brief","runId":"r","briefs":[{"day":"2026-10-14","messageIndex":5,"messageId":"m"}]}}
                """.utf8
            )
        )
        XCTAssertEqual(page.origin?.latestDailyBrief?.messageIndex, 5)
    }

    /// The timeline starts at the latest brief: earlier days stay in the
    /// transcript but not in the timeline. Indices are visible-message
    /// indices, and `startIndex` places a loaded page against them.
    func testTimelineScopedToLatestBrief() {
        let origin = ConversationOrigin(
            kind: "daily_brief",
            runId: "run_2",
            briefs: [
                DailyBriefMessageRef(day: "2026-10-13", messageIndex: 0, messageId: "m_a"),
                DailyBriefMessageRef(day: "2026-10-14", messageIndex: 3, messageId: "m_b"),
            ]
        )
        let thread = [
            message("Yesterday's brief"),
            message("What about the invoice?", user: true),
            message("It is due Friday."),
            message("Today's brief"),
            message("Move the call to Thursday", user: true),
            message("Moved."),
        ]

        let whole = AgentCoordinator.timelineMessages(thread, startIndex: 0, origin: origin)
        XCTAssertEqual(whole.count, 3)
        guard case .assistant(let parts) = whole[0], case .text(let text) = parts[0] else {
            return XCTFail("the timeline should open on today's brief")
        }
        XCTAssertEqual(text, "Today's brief")

        // A loaded tail page that starts after the brief keeps everything.
        XCTAssertEqual(
            AgentCoordinator.timelineMessages(Array(thread[4...]), startIndex: 4, origin: origin).count,
            2
        )
        // An older page wholly before the brief contributes nothing.
        XCTAssertEqual(
            AgentCoordinator.timelineMessages(Array(thread[0 ..< 3]), startIndex: 0, origin: origin).count,
            0
        )
        // A page straddling the brief is cut at it.
        XCTAssertEqual(
            AgentCoordinator.timelineMessages(Array(thread[2...]), startIndex: 2, origin: origin).count,
            3
        )
    }

    /// Each brief is an assistant message with no user message before it, so
    /// consecutive briefs — or a brief after yesterday's answer — sit next
    /// to each other. Every brief must still render as its own turn.
    func testEachBriefIsItsOwnTurn() {
        let origin = ConversationOrigin(
            kind: "daily_brief",
            runId: "run_3",
            briefs: [
                DailyBriefMessageRef(day: "2026-10-12", messageIndex: 0, messageId: "m_a"),
                DailyBriefMessageRef(day: "2026-10-13", messageIndex: 1, messageId: "m_b"),
                DailyBriefMessageRef(day: "2026-10-14", messageIndex: 4, messageId: "m_c"),
            ]
        )
        let thread = [
            message("Monday's brief"),
            message("Tuesday's brief"),
            message("What about the invoice?", user: true),
            message("It is due Friday."),
            message("Wednesday's brief"),
        ]
        func assistantTexts(_ turns: [AgentTurn]) -> [[String]] {
            turns.compactMap { turn -> [String]? in
                guard case .assistant(let assistant) = turn else { return nil }
                return assistant.parts.compactMap { part -> String? in
                    if case .text(let text) = part { return text }
                    return nil
                }
            }
        }

        let breaks = AgentCoordinator.briefTurnBreaks(origin: origin, startIndex: 0)
        XCTAssertEqual(Set(breaks.keys), [0, 1, 4])
        XCTAssertEqual(breaks[4]?.messageId, "m_c")
        let turns = AgentTurnBuilder.turns(from: thread, breakBefore: breaks)
        XCTAssertEqual(
            assistantTexts(turns),
            [["Monday's brief"], ["Tuesday's brief"], ["It is due Friday."], ["Wednesday's brief"]]
        )
        // Without the breaks the adjacent messages fold together.
        XCTAssertEqual(assistantTexts(AgentTurnBuilder.turns(from: thread)).count, 2)

        // A page loaded from visible index 3 places Wednesday's brief at 1.
        XCTAssertEqual(Set(AgentCoordinator.briefTurnBreaks(origin: origin, startIndex: 3).keys), [1])
        XCTAssertEqual(
            assistantTexts(AgentTurnBuilder.turns(
                from: Array(thread[3...]),
                breakBefore: AgentCoordinator.briefTurnBreaks(origin: origin, startIndex: 3)
            )),
            [["It is due Friday."], ["Wednesday's brief"]]
        )
        XCTAssertEqual(AgentCoordinator.briefTurnBreaks(origin: nil, startIndex: 0), [:])
    }

    /// Every other conversation — and a Morning brief thread whose origin
    /// arrived without references — keeps its whole loaded history.
    func testTimelineUnscopedWithoutLatestBrief() {
        let thread = seedMessages + followUp
        XCTAssertEqual(AgentCoordinator.timelineMessages(thread, startIndex: 0, origin: nil).count, 4)
        XCTAssertEqual(AgentCoordinator.timelineMessages(thread, startIndex: 0, origin: watchOrigin()).count, 4)
        let bare = ConversationOrigin(kind: "daily_brief", runId: "r")
        XCTAssertEqual(AgentCoordinator.timelineMessages(thread, startIndex: 0, origin: bare).count, 4)
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
            guard case .assistant(let assistant) = turn else { continue }
            for part in assistant.parts {
                if case .tool(let call) = part {
                    XCTFail("no tool part should survive the rebuild, found \(call.tool)")
                }
            }
        }
    }

    /// Structured resultTypes humanize into the action card's outcome
    /// line ("open_loop.updated" → "Open loop updated").
    func testHumanizeResultType() {
        XCTAssertEqual(agentHumanizeResultType("open_loop.updated"), "Open loop updated")
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
            "observation_list", "observation_note", "observation_withdraw",
            "observation_suppress", "temporal_query", "temporal_annotation_add",
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
