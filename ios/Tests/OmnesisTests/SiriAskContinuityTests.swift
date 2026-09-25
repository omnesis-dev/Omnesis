// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class SiriAskContinuityTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - Pure decision

    func testFirstAskStartsFresh() {
        XCTAssertNil(SiriAskContinuity.conversationToResume(record: nil, now: base))
    }

    func testAskInsideWindowResumes() {
        let record = SiriAskContinuity.Record(conversationId: "conv-1", askedAt: base)
        XCTAssertEqual(
            SiriAskContinuity.conversationToResume(record: record, now: base.addingTimeInterval(4 * 60)),
            "conv-1"
        )
    }

    func testAskAtOrPastWindowStartsFresh() {
        let record = SiriAskContinuity.Record(conversationId: "conv-1", askedAt: base)
        XCTAssertNil(
            SiriAskContinuity.conversationToResume(
                record: record,
                now: base.addingTimeInterval(SiriAskContinuity.window)
            )
        )
        XCTAssertNil(
            SiriAskContinuity.conversationToResume(record: record, now: base.addingTimeInterval(60 * 60))
        )
    }

    func testRecordFromTheFutureStartsFresh() {
        // A clock that moved backwards leaves a record dated after `now`;
        // its timing is meaningless, so it must not be resumed.
        let record = SiriAskContinuity.Record(conversationId: "conv-1", askedAt: base.addingTimeInterval(30))
        XCTAssertNil(SiriAskContinuity.conversationToResume(record: record, now: base))
    }

    // MARK: - Pre-send gate

    private func session(busy: Bool, conversationId: String? = nil) -> CreateSessionResponse {
        CreateSessionResponse(
            sessionId: "sess-1",
            conversationId: conversationId,
            model: "test-model",
            backend: "test-backend",
            busy: busy
        )
    }

    /// A resumed conversation whose previous turn is still running must
    /// not be sent to (the gateway would reject it session-busy); the
    /// ask reports still-working and keeps the thread.
    func testPreflightBusySessionReportsPreviousTurnRunning() {
        XCTAssertEqual(
            SiriAskPreflight.action(for: session(busy: true, conversationId: "conv-1")),
            .reportPreviousTurnRunning(conversationId: "conv-1")
        )
    }

    func testPreflightIdleSessionSends() {
        XCTAssertEqual(
            SiriAskPreflight.action(for: session(busy: false, conversationId: "conv-1")),
            .send(conversationId: "conv-1")
        )
    }

    /// Gateways that don't emit `conversationId` fall back to the
    /// session id for the continuity thread.
    func testPreflightFallsBackToSessionId() {
        XCTAssertEqual(
            SiriAskPreflight.action(for: session(busy: false)),
            .send(conversationId: "sess-1")
        )
        XCTAssertEqual(
            SiriAskPreflight.action(for: session(busy: true)),
            .reportPreviousTurnRunning(conversationId: "sess-1")
        )
    }

    // MARK: - Budget

    /// The budget covers the whole ask. Reaching the gateway is part of
    /// what it pays for, so the wait left over shrinks by however long
    /// that took — a follow-up resuming a long thread pays more for it
    /// than a first ask reaching an empty one.
    func testSetupTimeComesOutOfTheBudget() {
        XCTAssertEqual(SiriAskBudget.remaining(budget: 45, elapsed: 0), 45)
        XCTAssertEqual(SiriAskBudget.remaining(budget: 45, elapsed: 12), 33)
        XCTAssertEqual(SiriAskBudget.remaining(budget: 20, elapsed: 5.5), 14.5)
    }

    /// A setup that already spent the budget still posts the question —
    /// the armed push is the only channel left to deliver its answer — so
    /// the remaining wait floors rather than going to zero or negative.
    func testOverrunSetupFloorsTheRemainingWait() {
        XCTAssertEqual(SiriAskBudget.remaining(budget: 45, elapsed: 45), SiriAskBudget.minimumRemaining)
        XCTAssertEqual(SiriAskBudget.remaining(budget: 45, elapsed: 90), SiriAskBudget.minimumRemaining)
    }

    /// A clock that moved backwards reports negative setup time; it must
    /// not hand the ask more than its whole budget.
    func testBackwardsClockCannotExtendTheBudget() {
        XCTAssertEqual(SiriAskBudget.remaining(budget: 45, elapsed: -30), 45)
    }

    /// The push arms on the same deadline the spoken wait ends on, so both
    /// read the same remaining interval — in whole milliseconds, and never
    /// under the second the gateway requires.
    func testNotifyAfterMsMatchesTheRemainingWait() {
        XCTAssertEqual(SiriAskBudget.notifyAfterMs(remaining: 33), 33000)
        XCTAssertEqual(SiriAskBudget.notifyAfterMs(remaining: 14.5), 14500)
        XCTAssertEqual(SiriAskBudget.notifyAfterMs(remaining: SiriAskBudget.minimumRemaining), 1000)
        XCTAssertEqual(SiriAskBudget.notifyAfterMs(remaining: 0), 1000)
    }

    /// A wait the gateway would refuse must not ride along with the
    /// question: an out-of-range `notifyAfterMs` fails the whole send, and
    /// an infinite one would trap on conversion rather than send anything.
    func testNotifyAfterMsStaysInsideTheRangeTheGatewayAccepts() {
        XCTAssertEqual(SiriAskBudget.notifyAfterMs(remaining: 10000), 600_000)
        XCTAssertEqual(SiriAskBudget.notifyAfterMs(remaining: .infinity), 600_000)
    }

    /// The ask may exceed its budget only by the settle grace, and the
    /// total has to stay clear of the watch relay's own backstop —
    /// otherwise the wrist gives up first and reports a delivery problem
    /// for an answer that was on its way.
    func testTheWatchAskStaysInsideItsRelayBackstop() {
        XCTAssertLessThanOrEqual(
            SiriAskRunner.watchRelayBudget + SiriAskBudget.settleGrace,
            60
        )
    }

    // MARK: - UserDefaults-backed store

    private func makeSuite() throws -> (UserDefaults, String) {
        let name = "siri-ask-continuity-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        return (defaults, name)
    }

    func testStoreRoundTripsWithinWindow() throws {
        let (defaults, name) = try makeSuite()
        defer { defaults.removePersistentDomain(forName: name) }
        var now = base
        let store = SiriAskContinuityStore(defaults: defaults, now: { now })
        XCTAssertNil(store.conversationToResume())
        store.record(conversationId: "conv-42")
        now = base.addingTimeInterval(2 * 60)
        XCTAssertEqual(store.conversationToResume(), "conv-42")
    }

    func testStoreExpiresPastWindow() throws {
        let (defaults, name) = try makeSuite()
        defer { defaults.removePersistentDomain(forName: name) }
        var now = base
        let store = SiriAskContinuityStore(defaults: defaults, now: { now })
        store.record(conversationId: "conv-42")
        now = base.addingTimeInterval(SiriAskContinuity.window + 1)
        XCTAssertNil(store.conversationToResume())
    }

    func testStoreLatestRecordWins() throws {
        let (defaults, name) = try makeSuite()
        defer { defaults.removePersistentDomain(forName: name) }
        var now = base
        let store = SiriAskContinuityStore(defaults: defaults, now: { now })
        store.record(conversationId: "conv-1")
        now = base.addingTimeInterval(60)
        store.record(conversationId: "conv-2")
        now = base.addingTimeInterval(4 * 60)
        XCTAssertEqual(store.conversationToResume(), "conv-2")
    }
}
