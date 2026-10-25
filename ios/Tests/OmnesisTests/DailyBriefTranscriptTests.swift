// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

/// The Morning brief conversation's logic: the wire shapes, how turns group
/// into days, the day labels in the phone's calendar (across a clock change),
/// and which days and lists start open.
@available(iOS 17.0, *)
final class DailyBriefTranscriptTests: XCTestCase {
    // MARK: - Decoding

    func testBriefReferenceDecodesWithAndWithoutSentAt() throws {
        let origin = try JSONDecoder().decode(ConversationOrigin.self, from: Data("""
        {"kind":"daily_brief","runId":"r1","briefs":[
          {"day":"2026-10-13","messageIndex":0,"messageId":"mb_1"},
          {"day":"2026-10-14","messageIndex":3,"messageId":"mb_2","sentAt":"2026-10-14T06:02:40.055Z"}
        ]}
        """.utf8))
        XCTAssertEqual(origin.briefs.count, 2)
        XCTAssertNil(origin.briefs[0].sentAt)
        XCTAssertEqual(origin.briefs[1].sentAt, "2026-10-14T06:02:40.055Z")
        XCTAssertEqual(origin.latestDailyBrief?.messageId, "mb_2")
    }

    func testItemsResponseDecodes() throws {
        let page = try JSONDecoder().decode(DailyBriefItems.self, from: Data("""
        {"day":"2026-10-14","messageId":"mb_2","sentAt":"2026-10-14T06:02:40.055Z",
         "items":[
           {"rank":1,"observationId":"obs_1","summary":"The loan offer letter asks for a reply by Friday.",
            "sources":[{"id":"doc_1","title":"Loan offer letter","sourceType":"gmail","createdAt":"2026-10-05T09:00:00.000Z"},
                       {"id":"doc_2","title":null,"sourceType":"whatsapp","createdAt":"2026-10-06T09:00:00.000Z"}],
            "tasks":[{"id":"loop_1","title":"Book the boiler engineer","state":"open"},
                     {"id":"loop_2","title":"Pay the deposit","state":"done"}]},
           {"rank":2,"observationId":"obs_2","summary":"Nothing behind this one.","sources":[],"tasks":[]},
           {"rank":3,"summary":"An item with no observation id is dropped."}
         ]}
        """.utf8))
        XCTAssertEqual(page.day, "2026-10-14")
        XCTAssertEqual(page.messageId, "mb_2")
        XCTAssertEqual(page.sentAt, "2026-10-14T06:02:40.055Z")
        XCTAssertEqual(page.items.map(\.observationId), ["obs_1", "obs_2"])
        let first = page.items[0]
        XCTAssertEqual(first.sources.map(\.title), ["Loan offer letter", nil])
        XCTAssertEqual(first.sources[1].sourceType, "whatsapp")
        XCTAssertEqual(first.tasks.map(\.isResolved), [false, true])
        XCTAssertTrue(page.items[1].sources.isEmpty)
        XCTAssertTrue(page.items[1].tasks.isEmpty)
    }

    func testItemReactionDecodesLeniently() throws {
        let page = try JSONDecoder().decode(DailyBriefItems.self, from: Data("""
        {"day":"2026-10-14","messageId":"mb_2","items":[
           {"rank":1,"observationId":"obs_up","summary":"Useful.",
            "reaction":{"kind":"up","at":"2026-10-14T07:10:03.000Z"}},
           {"rank":2,"observationId":"obs_no","summary":"Not interested.",
            "reaction":{"kind":"not_interested","note":"Never mind this","at":"2026-10-14T07:11:40Z"}},
           {"rank":3,"observationId":"obs_wrong","summary":"Wrong.",
            "reaction":{"kind":"factual_error","note":"Paid already","at":"not an instant"}},
           {"rank":4,"observationId":"obs_none","summary":"Untouched."},
           {"rank":5,"observationId":"obs_new","summary":"A kind this build does not know.",
            "reaction":{"kind":"shrug","at":"2026-10-14T07:12:00.000Z"}}
         ]}
        """.utf8))
        let reactions = page.items.map(\.reaction)
        XCTAssertEqual(reactions[0]?.kind, .up)
        XCTAssertNil(reactions[0]?.note)
        XCTAssertEqual(reactions[0]?.at, ISO8601DateFormatter().date(from: "2026-10-14T07:10:03Z"))
        XCTAssertEqual(reactions[1], DailyBriefReaction(
            kind: .notInterested,
            note: "Never mind this",
            at: ISO8601DateFormatter().date(from: "2026-10-14T07:11:40Z")
        ))
        XCTAssertEqual(reactions[2]?.kind, .factualError)
        XCTAssertEqual(reactions[2]?.note, "Paid already")
        XCTAssertNil(reactions[2]?.at, "an unreadable instant is dropped, not the reaction")
        XCTAssertNil(reactions[3])
        XCTAssertNil(reactions[4], "an unknown kind reads as no reaction")
        XCTAssertEqual(page.items.count, 5, "an unknown reaction kind never drops the item")
    }

    func testClientPutsTheReactionAndReadsItBack() async throws {
        let session = StubSession()
        session.body = #"{"observationId":"obs/1","reaction":"not_interested","note":"Never mind","at":"2026-10-14T07:11:40.000Z"}"#
        let client = try DailyBriefClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com:7600")),
            token: "omn_t",
            session: session
        )
        let settled = try await client.react(
            conversationId: "s/brief",
            day: "2026-10-14",
            observationId: "obs/1",
            reaction: .notInterested,
            note: "Never mind"
        )
        XCTAssertEqual(settled?.kind, .notInterested)
        XCTAssertEqual(settled?.note, "Never mind")
        XCTAssertEqual(settled?.at, ISO8601DateFormatter().date(from: "2026-10-14T07:11:40Z"))
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(
            request.url?.absoluteString,
            "https://gateway.example.com:7600/agent/conversations/s%2Fbrief/briefs/2026-10-14/items/obs%2F1/reaction"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any]
        XCTAssertEqual(body?["reaction"] as? String, "not_interested")
        XCTAssertEqual(body?["note"] as? String, "Never mind")
        XCTAssertEqual(body?.count, 2, "the body is the reaction and the words, nothing else")

        // A correction sends only its words — the gateway names the note it saves —
        // and the note's id in the answer is not needed; clearing sends JSON null
        // and reads back nil.
        session.body = #"{"observationId":"obs/1","reaction":"factual_error","note":"Paid","noteId":"3f1e","at":"2026-10-14T07:12:00Z"}"#
        let correction = try await client.react(
            conversationId: "s/brief",
            day: "2026-10-14",
            observationId: "obs/1",
            reaction: .factualError,
            note: "Paid"
        )
        XCTAssertEqual(correction?.kind, .factualError)
        let correcting = try JSONSerialization.jsonObject(with: XCTUnwrap(session.requests[1].httpBody)) as? [String: Any]
        XCTAssertEqual(correcting?["reaction"] as? String, "factual_error")
        XCTAssertEqual(correcting?["note"] as? String, "Paid")
        XCTAssertEqual(correcting?.count, 2)

        session.body = #"{"observationId":"obs/1","reaction":null}"#
        let cleared = try await client.react(conversationId: "s/brief", day: "2026-10-14", observationId: "obs/1", reaction: nil)
        XCTAssertNil(cleared)
        let clearing = try JSONSerialization.jsonObject(with: XCTUnwrap(session.requests[2].httpBody)) as? [String: Any]
        XCTAssertTrue(clearing?["reaction"] is NSNull, "clearing sends an explicit null")
        XCTAssertEqual(clearing?.count, 1)

        session.status = 404
        session.body = #"{"error":"not one of this brief's items"}"#
        do {
            _ = try await client.react(conversationId: "s/brief", day: "2026-10-14", observationId: "obs/9", reaction: .up)
            XCTFail("expected notFound")
        } catch GatewayClient.Error.notFound {}
    }

    func testItemsResponseWithoutSentAtOrItems() throws {
        let page = try JSONDecoder().decode(DailyBriefItems.self, from: Data("""
        {"day":"2026-10-12","messageId":"mb_0"}
        """.utf8))
        XCTAssertNil(page.sentAt)
        XCTAssertTrue(page.items.isEmpty)
    }

    func testClientRequestsTheDayAndMapsNotFound() async throws {
        let session = StubSession()
        session.body = #"{"day":"2026-10-14","messageId":"mb_2","items":[]}"#
        let client = try DailyBriefClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com:7600")),
            token: "omn_t",
            session: session
        )
        let page = try await client.items(conversationId: "s/brief", day: "2026-10-14")
        XCTAssertEqual(page.messageId, "mb_2")
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString, "https://gateway.example.com:7600/agent/conversations/s%2Fbrief/briefs/2026-10-14")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")

        session.status = 404
        session.body = #"{"error":"no morning brief was sent on 2026-10-15"}"#
        do {
            _ = try await client.items(conversationId: "s/brief", day: "2026-10-15")
            XCTFail("expected notFound")
        } catch GatewayClient.Error.notFound {}
    }

    // MARK: - Grouping

    private let origin = ConversationOrigin(
        kind: "daily_brief",
        runId: "r1",
        briefs: [
            DailyBriefMessageRef(day: "2026-10-12", messageIndex: 2, messageId: "mb_12"),
            DailyBriefMessageRef(day: "2026-10-13", messageIndex: 5, messageId: "mb_13"),
            DailyBriefMessageRef(day: "2026-10-14", messageIndex: 6, messageId: "mb_14"),
        ]
    )

    private let thread: [ChatMessage] = [
        .user(parts: [.text("Before any brief")]),
        .assistant(parts: [.text("An answer from before the briefs began.")]),
        .assistant(parts: [.text("Monday's brief")]),
        .user(parts: [.text("First reply")]),
        .assistant(parts: [.text("Answer one")]),
        .assistant(parts: [.text("Tuesday's brief")]),
        .assistant(parts: [.text("Wednesday's brief")]),
        .user(parts: [.text("A reply today")]),
        .assistant(parts: [.text("Answer today")]),
        .user(parts: [.text("Another reply today")]),
    ]

    private func turns(from start: Int = 0) -> [AgentTurn] {
        AgentTurnBuilder.turns(
            from: Array(thread[start...]),
            breakBefore: AgentCoordinator.briefTurnBreaks(origin: origin, startIndex: start)
        )
    }

    func testEachBriefTurnCarriesItsBriefsId() {
        let ids = turns().map(\.id)
        XCTAssertTrue(ids.contains("brief-mb_12"))
        XCTAssertTrue(ids.contains("brief-mb_13"))
        XCTAssertTrue(ids.contains("brief-mb_14"))
        XCTAssertEqual(Set(ids).count, ids.count, "turn ids must be unique")
    }

    func testTurnsGroupIntoDaysWithReplyCounts() {
        let transcript = DailyBriefTranscript(turns: turns(), briefs: origin.briefs)
        XCTAssertEqual(transcript.leading.count, 2, "the turns before the first brief stand alone")
        XCTAssertEqual(transcript.days.map(\.brief.day), ["2026-10-12", "2026-10-13", "2026-10-14"])
        XCTAssertEqual(transcript.days.map(\.replyCount), [1, 0, 2])
        XCTAssertEqual(transcript.days.map(\.turns.count), [3, 1, 4])
        XCTAssertEqual(transcript.days.map { $0.turns.first?.id }, ["brief-mb_12", "brief-mb_13", "brief-mb_14"])
        XCTAssertEqual(transcript.latest?.id, "mb_14")
    }

    /// A page that starts mid-day: the turns before its first brief belong to
    /// a day whose brief is not loaded, and show without a day of their own.
    func testPageStartingMidDay() {
        let transcript = DailyBriefTranscript(turns: turns(from: 3), briefs: origin.briefs)
        XCTAssertEqual(transcript.leading.count, 2)
        XCTAssertEqual(transcript.days.map(\.brief.day), ["2026-10-13", "2026-10-14"])
    }

    func testNoBriefsLeavesEverythingLeading() {
        let transcript = DailyBriefTranscript(turns: turns(), briefs: [])
        XCTAssertTrue(transcript.days.isEmpty)
        XCTAssertNil(transcript.latest)
    }

    // MARK: - Labels

    private let gb = Locale(identifier: "en_GB")

    private func london() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London")!
        return calendar
    }

    private func instant(_ iso: String) -> Date {
        ISO8601DateFormatter().date(from: iso)!
    }

    private func label(_ day: String, now: String) -> String? {
        DailyBriefCopy.dayLabel(day, now: instant(now), calendar: london(), locale: gb)
    }

    func testTodayYesterdayAndDate() {
        let now = "2026-10-14T08:30:00Z"
        XCTAssertEqual(label("2026-10-14", now: now), "Today")
        XCTAssertEqual(label("2026-10-13", now: now), "Yesterday")
        XCTAssertEqual(label("2026-10-12", now: now), "Mon 12 Oct")
        XCTAssertEqual(
            DailyBriefCopy.spokenDayLabel("2026-10-12", now: instant(now), calendar: london(), locale: gb),
            "Monday 12 October"
        )
        XCTAssertNil(label("not-a-day", now: now))
    }

    /// Clocks go back in London at 02:00 BST on 25 October 2026, so that day
    /// is 25 hours long. The labels follow calendar days, not 24-hour spans.
    func testLabelsAcrossTheClockChange() {
        // 00:30 BST on the 25th is still the 24th in UTC.
        XCTAssertEqual(label("2026-10-25", now: "2026-10-24T23:30:00Z"), "Today")
        XCTAssertEqual(label("2026-10-24", now: "2026-10-24T23:30:00Z"), "Yesterday")
        // 23:30 GMT on the 25th: 25 hours after its midnight, still that day.
        XCTAssertEqual(label("2026-10-25", now: "2026-10-25T23:30:00Z"), "Today")
        // 00:30 GMT on the 26th: the long day is yesterday, the 24th two days back.
        XCTAssertEqual(label("2026-10-25", now: "2026-10-26T00:30:00Z"), "Yesterday")
        XCTAssertEqual(label("2026-10-24", now: "2026-10-26T00:30:00Z"), "Sat 24 Oct")
    }

    func testSentTimeIsLocal() {
        let calendar = london()
        XCTAssertEqual(DailyBriefCopy.sentTime("2026-10-24T06:02:40.055Z", calendar: calendar, locale: gb), "07:02")
        XCTAssertEqual(DailyBriefCopy.sentTime("2026-10-25T06:02:40Z", calendar: calendar, locale: gb), "06:02")
        XCTAssertNil(DailyBriefCopy.sentTime(nil, calendar: calendar, locale: gb))
        XCTAssertNil(DailyBriefCopy.sentTime("yesterday", calendar: calendar, locale: gb))
    }

    func testFoldedSummaryAndCounts() {
        XCTAssertEqual(DailyBriefCopy.foldedSummary(itemCount: 5, replyCount: 2), "Morning brief · 5 things · 2 replies")
        XCTAssertEqual(DailyBriefCopy.foldedSummary(itemCount: 1, replyCount: 1), "Morning brief · 1 thing · 1 reply")
        XCTAssertEqual(DailyBriefCopy.foldedSummary(itemCount: nil, replyCount: 3), "Morning brief · 3 replies")
        XCTAssertEqual(DailyBriefCopy.foldedSummary(itemCount: 0, replyCount: 0), "Morning brief")
        XCTAssertEqual(DailyBriefCopy.basedOn(1), "Based on 1 thing")
        XCTAssertEqual(DailyBriefCopy.basedOn(4), "Based on 4 things")
    }

    func testComposerPrompt() {
        XCTAssertEqual(DailyBriefCopy.composerPrompt(for: origin), "Reply about today's brief…")
        XCTAssertEqual(DailyBriefCopy.composerPrompt(for: nil), "Ask Omnesis")
        XCTAssertEqual(DailyBriefCopy.composerPrompt(for: ConversationOrigin(kind: "watch_firing", runId: "r")), "Ask Omnesis")
    }

    // MARK: - What starts open

    private func page(_ day: String, count: Int) -> DailyBriefItems {
        DailyBriefItems(
            day: day,
            messageId: "mb_\(day)",
            items: (0 ..< count).map { DailyBriefItem(rank: $0 + 1, observationId: "obs_\($0)", summary: "Item \($0)") }
        )
    }

    @MainActor
    func testLatestDayAndItsListStartOpenEarlierDaysFolded() {
        let model = DailyBriefModel(conversationId: "s1", loader: nil)
        model.observeLatest(origin.latestDailyBrief)
        let monday = origin.briefs[0]
        let tuesday = origin.briefs[1]
        let today = origin.briefs[2]
        XCTAssertTrue(model.isOpen(today))
        XCTAssertTrue(model.isFooterOpen(today))
        XCTAssertFalse(model.isOpen(monday))
        XCTAssertFalse(model.isOpen(tuesday))

        model.toggleDay(tuesday)
        XCTAssertTrue(model.isOpen(tuesday))
        XCTAssertFalse(model.isFooterOpen(tuesday), "an opened earlier day keeps its list closed")
        model.toggleFooter(tuesday)
        XCTAssertTrue(model.isFooterOpen(tuesday))
        model.toggleDay(tuesday)
        XCTAssertFalse(model.isOpen(tuesday))

        model.toggleDay(today)
        XCTAssertTrue(model.isOpen(today), "the latest day does not fold")
        model.toggleFooter(today)
        XCTAssertFalse(model.isFooterOpen(today))
        model.toggleFooter(today)
        XCTAssertTrue(model.isFooterOpen(today))
    }

    @MainActor
    func testANewBriefFoldsThePreviousDay() {
        let model = DailyBriefModel(conversationId: "s1", loader: nil)
        let tuesday = origin.briefs[1]
        let today = origin.briefs[2]
        model.observeLatest(tuesday)
        model.toggleFooter(tuesday)
        model.observeLatest(today)
        XCTAssertFalse(model.isOpen(tuesday))
        XCTAssertFalse(model.isFooterOpen(tuesday))
        XCTAssertTrue(model.isOpen(today))
        XCTAssertTrue(model.isFooterOpen(today))
    }

    @MainActor
    func testLoadingRetryAndCounts() async {
        let gateway = DailyBriefDemoGateway(
            pages: [page("2026-10-13", count: 2), page("2026-10-14", count: 5)],
            failingOnce: ["2026-10-13"]
        )
        let model = DailyBriefModel(conversationId: "s1", loader: gateway)
        XCTAssertNil(model.itemCount(day: "2026-10-14"))

        await model.load(day: "2026-10-14")
        XCTAssertEqual(model.itemCount(day: "2026-10-14"), 5)
        await model.load(day: "2026-10-14")

        await model.load(day: "2026-10-13")
        XCTAssertEqual(model.items["2026-10-13"], .failed)
        await model.load(day: "2026-10-13")
        XCTAssertEqual(model.items["2026-10-13"], .failed, "a failed day waits for Retry")
        await model.retry(day: "2026-10-13")
        XCTAssertEqual(model.itemCount(day: "2026-10-13"), 2)

        await model.load(day: "2026-10-11")
        XCTAssertEqual(model.items["2026-10-11"], .failed, "a day with no brief reads as failed, not empty")

        let reads = await gateway.reads
        XCTAssertEqual(reads, ["2026-10-14", "2026-10-13", "2026-10-13", "2026-10-11"])
    }

    @MainActor
    func testReactionShowsAtOnceAndSettlesFromTheGateway() async {
        let gateway = DailyBriefDemoGateway(pages: [page("2026-10-14", count: 2)])
        let model = DailyBriefModel(conversationId: "s1", loader: gateway)
        await model.load(day: "2026-10-14")

        let took = await model.react(day: "2026-10-14", observationId: "obs_0", reaction: .up)
        XCTAssertTrue(took)
        let settled = reaction(model, "obs_0")
        XCTAssertEqual(settled?.kind, .up)
        XCTAssertNotNil(settled?.at, "the gateway's answer replaces the optimistic reaction")
        XCTAssertNil(reaction(model, "obs_1"), "only the item reacted to changes")
        XCTAssertNil(model.reactionFailure(observationId: "obs_0"))

        await model.react(day: "2026-10-14", observationId: "obs_0", reaction: .factualError, note: "Paid")
        XCTAssertEqual(reaction(model, "obs_0")?.kind, .factualError)
        XCTAssertEqual(reaction(model, "obs_0")?.note, "Paid")
        await model.react(day: "2026-10-14", observationId: "obs_0", reaction: nil)
        XCTAssertNil(reaction(model, "obs_0"))

        let unknown = await model.react(day: "2026-10-14", observationId: "obs_9", reaction: .up)
        XCTAssertFalse(unknown, "an item the day does not hold is not sent")
        let unloaded = await model.react(day: "2026-10-13", observationId: "obs_0", reaction: .up)
        XCTAssertFalse(unloaded)

        let sent = await gateway.reactions
        XCTAssertEqual(sent, [
            .init(observationId: "obs_0", kind: .up, note: nil),
            .init(observationId: "obs_0", kind: .factualError, note: "Paid"),
            .init(observationId: "obs_0", kind: nil, note: nil),
        ])
    }

    @MainActor
    func testRefusedReactionIsPutBackWithItsReason() async {
        let gateway = DailyBriefDemoGateway(pages: [page("2026-10-14", count: 1)], refusingReactions: ["obs_0"])
        let model = DailyBriefModel(conversationId: "s1", loader: gateway)
        await model.load(day: "2026-10-14")

        let took = await model.react(day: "2026-10-14", observationId: "obs_0", reaction: .notInterested, note: "No")
        XCTAssertFalse(took)
        XCTAssertNil(reaction(model, "obs_0"), "the reaction it had before is back")
        let failure = model.reactionFailure(observationId: "obs_0") as? GatewayClient.Error
        XCTAssertEqual(failure, .serverError(status: 503, body: #"{"error":"Reactions are unavailable"}"#))
        let sent = await gateway.reactions.count
        XCTAssertEqual(sent, 1)
    }

    /// A reply to an older reaction never overwrites a newer one: the
    /// gateway answers the first tap after the second was shown.
    @MainActor
    func testALateReplyNeverOverwritesANewerReaction() async {
        let gateway = SlowReactionGateway(page: page("2026-10-14", count: 1))
        let model = DailyBriefModel(conversationId: "s1", loader: gateway)
        await model.load(day: "2026-10-14")

        let first = Task { await model.react(day: "2026-10-14", observationId: "obs_0", reaction: .up) }
        await gateway.started(1)
        // The second tap clears it while the first is still on its way.
        let second = Task { await model.react(day: "2026-10-14", observationId: "obs_0", reaction: nil) }
        await gateway.started(2)
        XCTAssertNil(reaction(model, "obs_0"))
        await gateway.answer(0)
        _ = await first.value
        XCTAssertNil(reaction(model, "obs_0"), "the first tap's late answer is ignored")
        await gateway.answer(1)
        _ = await second.value
        XCTAssertNil(reaction(model, "obs_0"))
    }

    @MainActor
    private func reaction(_ model: DailyBriefModel, _ observationId: String) -> DailyBriefReaction? {
        guard case .loaded(let page) = model.items["2026-10-14"] else { return nil }
        return page.items.first { $0.observationId == observationId }?.reaction
    }

    @MainActor
    func testPreloadedItemsNeedNoFetch() async {
        let model = DailyBriefModel(conversationId: "s1", loader: nil, preloaded: [page("2026-10-14", count: 3)])
        await model.load(day: "2026-10-14")
        XCTAssertEqual(model.itemCount(day: "2026-10-14"), 3)
        await model.load(day: "2026-10-13")
        XCTAssertNil(model.items["2026-10-13"], "with no loader nothing is fetched")
    }
}

/// Answers each reaction only when told to, in the order they were sent.
private actor SlowReactionGateway: DailyBriefItemsLoading {
    private let page: DailyBriefItems
    private var pending: [Int: CheckedContinuation<DailyBriefReaction?, Never>] = [:]
    private var answers: [Int: DailyBriefReaction?] = [:]
    private var sent = 0
    private var waitingForStart: [CheckedContinuation<Void, Never>] = []

    init(page: DailyBriefItems) {
        self.page = page
    }

    func items(conversationId _: String, day _: String) async throws -> DailyBriefItems {
        page
    }

    func react(
        conversationId _: String,
        day _: String,
        observationId _: String,
        reaction: DailyBriefReaction.Kind?,
        note _: String?
    ) async throws
        -> DailyBriefReaction? {
        let index = sent
        sent += 1
        answers[index] = reaction.map { DailyBriefReaction(kind: $0, at: Date()) }
        waitingForStart.forEach { $0.resume() }
        waitingForStart = []
        return await withCheckedContinuation { continuation in
            pending[index] = continuation
        }
    }

    /// Waits until `count` reactions have reached the gateway.
    func started(_ count: Int) async {
        while sent < count {
            await withCheckedContinuation { waitingForStart.append($0) }
        }
    }

    func answer(_ index: Int) {
        pending.removeValue(forKey: index)?.resume(returning: answers[index].flatMap { $0 })
    }
}

private final class StubSession: URLSessionLike, @unchecked Sendable {
    var requests: [URLRequest] = []
    var status = 200
    var body = "{}"

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (Data(body.utf8), response)
    }
}
