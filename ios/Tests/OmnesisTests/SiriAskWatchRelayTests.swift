// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Coverage for the shared Siri-ask relay contract that the Apple Watch
/// and iPhone both depend on: the spoken copy per outcome, the
/// WatchConnectivity request/reply wire round-trip, and the answer-engine
/// resolution → outcome mapping. All pure, so it runs in the sim-less
/// logic lane.
final class SiriAskWatchRelayTests: XCTestCase {
    /// Every outcome whose wire form is the tag alone, for exhaustive
    /// round-trip + copy checks. `answered` and an explained `failed` carry
    /// text as well and are covered separately.
    private let parameterlessOutcomes: [SiriAskOutcome] = [
        .emptyAnswer,
        .failed(reason: nil),
        .stillWorking,
        .previousTurnRunning,
        .notPaired,
        .experimentalOff,
        .unauthorized,
        .unreachable,
        .sendFailed,
        .phoneUnreachable,
        .watchLinkInactive,
        .relayFailed,
        .answerOnPhone,
        .queuedForPhone,
    ]

    // MARK: - Wire round-trip

    func testRequestCarriesTrimmableQuestion() {
        let message = SiriAskWire.request(question: "what's on my calendar", ref: "r1")
        XCTAssertEqual(SiriAskWire.question(from: message), "what's on my calendar")
    }

    func testQuestionTrimsWhitespace() {
        let message = SiriAskWire.request(question: "  hello there \n", ref: "r1")
        XCTAssertEqual(SiriAskWire.question(from: message), "hello there")
    }

    func testQuestionRejectsWrongKind() {
        XCTAssertNil(SiriAskWire.question(from: ["kind": "note", "question": "hi"]))
    }

    func testQuestionRejectsBlank() {
        XCTAssertNil(SiriAskWire.question(from: SiriAskWire.request(question: "   ", ref: "r1")))
    }

    func testQuestionRejectsMissingKeys() {
        XCTAssertNil(SiriAskWire.question(from: [:]))
    }

    func testAnsweredReplyRoundTripsText() {
        let reply = SiriAskWire.reply(for: .answered(text: "You have two meetings."))
        XCTAssertEqual(SiriAskWire.outcome(from: reply), .answered(text: "You have two meetings."))
    }

    func testAnsweredReplyToleratesMissingText() {
        // A malformed answered reply (no text key) decodes to empty text,
        // which the dialog surfaces as the empty-answer nudge downstream —
        // never a crash.
        let outcome = SiriAskWire.outcome(from: ["outcome": "answered"])
        XCTAssertEqual(outcome, .answered(text: ""))
    }

    func testEveryParameterlessOutcomeRoundTrips() {
        for outcome in parameterlessOutcomes {
            let reply = SiriAskWire.reply(for: outcome)
            XCTAssertEqual(
                SiriAskWire.outcome(from: reply),
                outcome,
                "round-trip mismatch for \(outcome)"
            )
        }
    }

    func testUnknownTagFallsBackToRelayFailed() {
        XCTAssertEqual(SiriAskWire.outcome(from: ["outcome": "teleport"]), .relayFailed)
    }

    func testMissingOutcomeKeyFallsBackToRelayFailed() {
        XCTAssertEqual(SiriAskWire.outcome(from: [:]), .relayFailed)
    }

    // MARK: - Spoken copy

    func testAnsweredSpeaksTheAnswerVerbatim() {
        XCTAssertEqual(
            SiriAskDialog.text(for: .answered(text: "It's sunny.")),
            "It's sunny."
        )
    }

    func testEveryOutcomeHasNonEmptySpokenCopy() {
        for outcome in parameterlessOutcomes {
            XCTAssertFalse(
                SiriAskDialog.text(for: outcome).isEmpty,
                "no spoken copy for \(outcome)"
            )
        }
    }

    func testWatchOnlyOutcomesHaveDistinctCopy() {
        XCTAssertNotEqual(
            SiriAskDialog.text(for: .phoneUnreachable),
            SiriAskDialog.text(for: .relayFailed)
        )
        XCTAssertTrue(SiriAskDialog.text(for: .phoneUnreachable).contains("iPhone"))
    }

    /// The two link failures must not read alike: one means the phone is out
    /// of range, the other that the watch's own session never came up, and
    /// they call for different user action.
    func testLinkFailuresAreDistinguishable() {
        XCTAssertNotEqual(
            SiriAskDialog.text(for: .phoneUnreachable),
            SiriAskDialog.text(for: .watchLinkInactive)
        )
        XCTAssertFalse(SiriAskDialog.text(for: .watchLinkInactive).isEmpty)
    }

    // MARK: - Budgets

    /// The watch app sits on screen waiting, so it can afford a longer wait
    /// than Siri's spoken budget — that is what lets a slower turn still be
    /// shown on the wrist instead of falling through to the push. It must
    /// still stay well inside WatchConnectivity's reply window, since the
    /// answer travels back as the `sendMessage` reply.
    func testWatchRelayBudgetOutlastsSiriButStaysInsideTheReplyWindow() {
        XCTAssertGreaterThan(SiriAskRunner.watchRelayBudget, SiriAskRunner.answerBudget)
        XCTAssertLessThanOrEqual(SiriAskRunner.watchRelayBudget, 50)
    }

    // MARK: - Resolution mapping

    func testResolutionMappingCoversEveryExit() {
        XCTAssertEqual(
            SiriAskOutcome.from(.answered(text: "hi")),
            .answered(text: "hi")
        )
        XCTAssertEqual(SiriAskOutcome.from(.answered(text: "")), .emptyAnswer)
        XCTAssertEqual(
            SiriAskOutcome.from(.failed(code: "x", message: "y")),
            .failed(reason: "y")
        )
        XCTAssertEqual(SiriAskOutcome.from(.stillWorking), .stillWorking)
    }

    // MARK: - Outcome kind

    /// The kind drives how a screen presents the result — an error dressed as
    /// an answer is the failure mode this guards.
    func testOutcomeKindSeparatesAnswersStatusesAndFailures() {
        XCTAssertEqual(SiriAskOutcome.answered(text: "11am").kind, .answer)
        XCTAssertEqual(SiriAskOutcome.stillWorking.kind, .status)
        XCTAssertEqual(SiriAskOutcome.previousTurnRunning.kind, .status)
        // A queued question is on its way, not lost.
        XCTAssertEqual(SiriAskOutcome.queuedForPhone.kind, .status)
        for outcome in [
            SiriAskOutcome.emptyAnswer, .failed(reason: nil), .notPaired, .experimentalOff,
            .unauthorized, .unreachable, .sendFailed, .phoneUnreachable,
            .watchLinkInactive, .relayFailed,
        ] {
            XCTAssertEqual(outcome.kind, .failure, "\(outcome) should read as a failure")
        }
    }

    // MARK: - Progress

    func testProgressWireRoundTripsSnapshotAndRef() {
        let snapshot = SiriAskActivitySnapshot(label: "Reading…", detail: "3 read")
        let message = SiriAskWire.progress(snapshot: snapshot, ref: "r1")
        XCTAssertEqual(SiriAskWire.activitySnapshot(from: message)?.snapshot, snapshot)
        XCTAssertEqual(SiriAskWire.activitySnapshot(from: message)?.ref, "r1")
    }

    /// A snapshot with nothing retrieved yet must survive the wire as a bare
    /// label — not as a label with an empty clause hanging off it.
    func testProgressWireOmitsAnAbsentDetail() {
        let message = SiriAskWire.progress(snapshot: SiriAskActivitySnapshot(label: "Received"), ref: nil)
        XCTAssertNil(message["detail"])
        XCTAssertEqual(SiriAskWire.activitySnapshot(from: message)?.snapshot.detail, nil)
        XCTAssertEqual(SiriAskWire.activitySnapshot(from: message)?.snapshot.line, "Received")
    }

    func testProgressSnapshotRejectsNonProgressOrAnUnusableLabel() {
        XCTAssertNil(SiriAskWire.activitySnapshot(from: SiriAskWire.request(question: "hi", ref: "r1")))
        XCTAssertNil(SiriAskWire.activitySnapshot(from: [:]))
        XCTAssertNil(SiriAskWire.activitySnapshot(from: ["kind": "progress"]))
        XCTAssertNil(SiriAskWire.activitySnapshot(from: ["kind": "progress", "activity": ""]))
        XCTAssertNil(SiriAskWire.activitySnapshot(from: [
            "kind": "progress", "activity": String(repeating: "a", count: 41),
        ]))
        // The bound is a ceiling, not a fence one short of it.
        XCTAssertNotNil(SiriAskWire.activitySnapshot(from: [
            "kind": "progress", "activity": String(repeating: "a", count: 40),
        ]))
    }

    /// A corrupt detail costs the detail, not the packet: the step it belongs
    /// to is still worth showing, and a wrist stuck on a stale label for the
    /// rest of the turn is a worse outcome than a missing count.
    func testProgressSnapshotDropsAnUnusableDetailButKeepsItsStep() {
        for bad in ["", String(repeating: "9", count: 21)] {
            let decoded = SiriAskWire.activitySnapshot(from: [
                "kind": "progress", "activity": "Reading…", "detail": bad,
            ])
            XCTAssertEqual(decoded?.snapshot.label, "Reading…")
            XCTAssertNil(decoded?.snapshot.detail)
        }
        XCTAssertEqual(
            SiriAskWire.activitySnapshot(from: [
                "kind": "progress", "activity": "Reading…", "detail": String(repeating: "9", count: 20),
            ])?.snapshot.detail,
            String(repeating: "9", count: 20)
        )
    }

    /// The status line is one unwrapped line on a 41mm screen. Nothing at
    /// runtime can enforce that on the phrases themselves, so it is enforced
    /// here: every label this build can emit stays inside the width the wrist
    /// was measured to render whole.
    func testEveryStatusLabelFitsTheWatchLine() {
        var timeline = SiriAskActivityTimeline()
        var labels = [SiriAskActivity.fallbackLabel]
        for event in [
            SiriAskActivityEvent.relayReceived, .connecting, .requestSent, .agentStarted,
        ] {
            labels.append(timeline.apply(event).label)
        }
        labels += [
            "search_documents", "search_loops", "list_loops", "search_many",
            "fetch_document", "fetch_loop", "lookup_document_by_url", "fetch_many",
            "lookup_people", "run_sql", "trace_connections", "temporal_query",
            "time_index_query", "entity_context", "annotate", "cite_record",
            "annotate_many", "spawn_subagent", "join_subagents", "plan", "watch_create",
        ].map(SiriAskActivity.label(forTool:))
        labels.append(SiriAskActivity.wakingPhoneLabel)
        for label in labels {
            XCTAssertLessThanOrEqual(
                label.count,
                SiriAskWire.maxRenderableLabelLength,
                "\"\(label)\" is too long for the watch's status line"
            )
        }
    }

    /// The status line is one phrase, optionally followed by one clause —
    /// never a third part, and never a dangling separator.
    func testStatusLineJoinsAtMostTwoClauses() {
        XCTAssertEqual(SiriAskActivitySnapshot(label: "Thinking…").line, "Thinking…")
        XCTAssertEqual(
            SiriAskActivitySnapshot(label: "Searching…", detail: "12 found").line,
            "Searching… · 12 found"
        )
    }

    /// A newer gateway can run a tool this build has never heard of; it must
    /// still read as progress rather than a blank or a raw identifier.
    func testUnknownToolStillReadsAsProgress() {
        let label = SiriAskActivity.label(forTool: "consult_oracle")
        XCTAssertFalse(label.isEmpty)
        XCTAssertFalse(label.contains("consult_oracle"))
    }

    func testEveryKnownToolHasItsOwnPhrasing() {
        let tools = [
            "search_documents", "fetch_document", "lookup_people", "run_sql",
            "trace_connections", "temporal_query", "entity_context", "plan",
        ]
        for tool in tools {
            XCTAssertFalse(SiriAskActivity.label(forTool: tool).isEmpty)
        }
        // Distinct verbs where the work is genuinely different.
        XCTAssertNotEqual(
            SiriAskActivity.label(forTool: "search_documents"),
            SiriAskActivity.label(forTool: "run_sql")
        )
    }

    /// The batch tools are the ones the agent actually opens a call with —
    /// the singular tools only ever appear as their child steps, which don't
    /// start a call. If these fell through to the fallback, a wrist watching
    /// a real retrieval would sit on "Working…" for the whole turn and never
    /// learn that it is searching.
    func testBatchToolsReadAsTheirSingularVerb() {
        XCTAssertEqual(
            SiriAskActivity.label(forTool: "search_many"),
            SiriAskActivity.label(forTool: "search_documents")
        )
        XCTAssertEqual(
            SiriAskActivity.label(forTool: "fetch_many"),
            SiriAskActivity.label(forTool: "fetch_document")
        )
        XCTAssertEqual(
            SiriAskActivity.label(forTool: "annotate_many"),
            SiriAskActivity.label(forTool: "annotate")
        )
        for tool in ["search_many", "fetch_many", "annotate_many"] {
            XCTAssertNotEqual(SiriAskActivity.label(forTool: tool), SiriAskActivity.fallbackLabel)
        }
    }

    /// The hand-off states are what the wrist sees first, and they are the
    /// proof that the relay worked at all.
    func testTimelineNamesEachHandOffStepOnce() {
        var timeline = SiriAskActivityTimeline()
        XCTAssertEqual(timeline.apply(.relayReceived).line, "Received")
        // Reaching the gateway and handing it the question are one phrase:
        // they resolve a moment apart, and two strings that fast read as a
        // flicker rather than as progress.
        XCTAssertEqual(timeline.apply(.connecting).line, "Asking…")
        XCTAssertEqual(timeline.apply(.requestSent).line, "Asking…")
        XCTAssertEqual(timeline.apply(.agentStarted).line, "Thinking…")
    }

    func testTimelineCountsCompletedSearchesAndOpenedDocumentsOnce() {
        var timeline = SiriAskActivityTimeline()
        _ = timeline.apply(.toolStarted(id: "search-1", tool: "search_documents"))
        _ = timeline.apply(.toolFinished(id: "search-1", outcome: .search(found: 4)))
        // A replayed result must not inflate the count.
        _ = timeline.apply(.toolFinished(id: "search-1", outcome: .search(found: 4)))
        XCTAssertEqual(timeline.snapshot.line, "Searching… · 4 found")
        _ = timeline.apply(.toolStarted(id: "open-1", tool: "fetch_document"))
        _ = timeline.apply(.toolFinished(id: "open-1", outcome: .documentOpened))
        XCTAssertEqual(timeline.snapshot.line, "Reading… · 1 read")
    }

    /// The agent often answers straight from the chunks a search returns
    /// inline, opening nothing. That turn still has to report what it found —
    /// otherwise the commonest shape of a real ask shows no progress at all.
    func testTimelineReportsFindingsWhenNothingIsOpened() {
        var timeline = SiriAskActivityTimeline()
        _ = timeline.apply(.toolStarted(id: "batch", tool: "search_many"))
        _ = timeline.apply(.toolFinished(id: "batch", outcome: .batch(found: 12, opened: 0)))
        XCTAssertEqual(timeline.snapshot.line, "Searching… · 12 found")
    }

    /// A search that returns nothing leaves the clause off rather than
    /// reporting a zero: "0 found" reads as a failure the turn hasn't had.
    func testTimelineOmitsAnEmptyCount() {
        var timeline = SiriAskActivityTimeline()
        _ = timeline.apply(.toolStarted(id: "search-1", tool: "search_documents"))
        _ = timeline.apply(.toolFinished(id: "search-1", outcome: .search(found: 0)))
        XCTAssertNil(timeline.snapshot.detail)
        XCTAssertEqual(timeline.snapshot.line, "Searching…")
    }

    /// One clause at a time: a call that both searched and opened reports the
    /// read, because opening is the deeper act and the line has room for one.
    func testTimelineReportsTheDeeperActOfABatch() {
        var timeline = SiriAskActivityTimeline()
        _ = timeline.apply(.toolFinished(id: "batch", outcome: .batch(found: 12, opened: 2)))
        XCTAssertEqual(timeline.snapshot.detail, "2 read")
    }

    func testTimelineDoesNotDoubleCountChildProgressAndItsParentBatch() {
        var timeline = SiriAskActivityTimeline()
        _ = timeline.apply(.toolFinished(id: "batch#0", outcome: .search(found: 4)))
        _ = timeline.apply(.toolFinished(id: "batch#1", outcome: .search(found: 5)))
        _ = timeline.apply(.toolFinished(id: "batch", outcome: .batch(found: 9, opened: 0)))
        XCTAssertEqual(timeline.snapshot.detail, "9 found")
    }

    // MARK: - Read-along split

    /// Speech reports UTF-16 offsets. Treating them as character counts breaks
    /// the moment an answer contains an emoji, so the conversion is the whole
    /// point of this helper.
    func testSplitTracksUTF16OffsetsAcrossEmoji() {
        let text = "Checkout is 11am 🗓 sharp"
        // Offset past the emoji, expressed in UTF-16 units.
        let offset = "Checkout is 11am 🗓".utf16.count
        let split = SiriAskReadAlong.split(of: text, spokenUTF16: offset)
        XCTAssertEqual(split.map { String(text[..<$0]) }, "Checkout is 11am 🗓")
    }

    func testSplitReturnsNilBeforeAnythingIsSpoken() {
        XCTAssertNil(SiriAskReadAlong.split(of: "anything", spokenUTF16: 0))
        XCTAssertNil(SiriAskReadAlong.split(of: "", spokenUTF16: 5))
    }

    func testSplitClampsPastTheEnd() {
        let text = "short"
        let split = SiriAskReadAlong.split(of: text, spokenUTF16: 999)
        XCTAssertEqual(split, text.endIndex)
    }

    /// An offset landing inside a multi-scalar cluster has no String.Index.
    /// It must round down to the cluster start, not collapse the highlight.
    func testSplitInsideAGraphemeClusterRoundsDown() throws {
        let text = "Bonjour 🇫🇷 mon ami"
        let flagStart = try text.distance(from: text.startIndex, to: XCTUnwrap(text.firstIndex(of: "🇫🇷")))
        let prefixUTF16 = text.prefix(flagStart).utf16.count
        // Land two UTF-16 units into the four-unit flag.
        let split = SiriAskReadAlong.split(of: text, spokenUTF16: prefixUTF16 + 2)
        let spoken = split.map { String(text[..<$0]) }
        XCTAssertEqual(spoken, "Bonjour ")
        // Whatever it returns must be a real character boundary.
        XCTAssertNotNil(split.map { text.distance(from: text.startIndex, to: $0) })
    }

    // MARK: - Result channel

    /// The finished answer travels twice: as the reply and, fire-and-forget,
    /// as a result message. A reply lost to a suspended phone would otherwise
    /// strand the watch on an answer that exists — and a turn settling inside
    /// the budget arms no push to fall back on.
    func testResultMessageCarriesTheOutcomeAndIsDistinguishable() {
        let message = SiriAskWire.result(for: .answered(text: "The ninth of May."), ref: "r1")
        XCTAssertEqual(SiriAskWire.resultOutcome(from: message)?.outcome, .answered(text: "The ninth of May."))
        XCTAssertEqual(SiriAskWire.resultOutcome(from: message)?.ref, "r1")
        // It must not be mistaken for the inbound ask or for progress.
        XCTAssertNil(SiriAskWire.question(from: message))
        XCTAssertNil(SiriAskWire.activitySnapshot(from: message))
    }

    /// The ref is what stops a straggler from an earlier ask ending the next
    /// ask's wait — a real bug: a backstop timer armed by one question fired
    /// during the following one and reported its verdict.
    func testAskCarriesARefTheResultEchoes() {
        let ask = SiriAskWire.request(question: "when is my dad's birthday", ref: "ask-2")
        XCTAssertEqual(SiriAskWire.ref(from: ask), "ask-2")
        let result = SiriAskWire.result(for: .answered(text: "The ninth."), ref: SiriAskWire.ref(from: ask))
        XCTAssertEqual(SiriAskWire.resultOutcome(from: result)?.ref, "ask-2")
    }

    func testResultOutcomeIgnoresOtherMessages() {
        XCTAssertNil(SiriAskWire.resultOutcome(from: SiriAskWire.progress(
            snapshot: SiriAskActivitySnapshot(label: "Checking your records…"), ref: "r1"
        )))
        XCTAssertNil(SiriAskWire.resultOutcome(from: SiriAskWire.request(question: "hi", ref: "r1")))
        XCTAssertNil(SiriAskWire.resultOutcome(from: [:]))
    }

    /// A reply and a result must decode identically, so it never matters which
    /// path won the race.
    func testReplyAndResultAgreeForEveryOutcome() {
        for outcome in parameterlessOutcomes + [.answered(text: "same")] {
            XCTAssertEqual(
                SiriAskWire.outcome(from: SiriAskWire.reply(for: outcome)),
                SiriAskWire.resultOutcome(from: SiriAskWire.result(for: outcome, ref: "r1"))?.outcome,
                "delivery paths disagree for \(outcome)"
            )
        }
    }

    /// A delivery failure is not an answer failure: the turn succeeded and the
    /// phone holds the result, so it must not read as "couldn't answer".
    func testAnswerOnPhoneReadsAsAStatusNotAFailure() {
        XCTAssertEqual(SiriAskOutcome.answerOnPhone.kind, .status)
        XCTAssertTrue(SiriAskDialog.text(for: .answerOnPhone).contains("iPhone"))
    }
}
