// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// When the iPhone tells the watch about gateway dictation and what it
/// keeps — plus how it handles relays the watch queued.
final class WatchDictationGateStoreTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)
    private let limit = 26_214_400

    private func status(active: Bool) -> DictationStatus {
        DictationStatus(visible: true, enabled: active, modelAssigned: true, active: active, maxAudioBytes: limit)
    }

    // MARK: - What the status implies

    /// A background launch has not read the status: it says nothing rather
    /// than tell the watch "off".
    func testUnknownStatusPublishesNothing() {
        XCTAssertNil(WatchGatePublishing.gate(status: nil, statusKnown: false, paired: true, now: now))
    }

    func testKnownStatusGivesTheGate() throws {
        let on = try XCTUnwrap(WatchGatePublishing.gate(status: status(active: true), statusKnown: true, paired: true, now: now))
        XCTAssertTrue(on.active)
        XCTAssertEqual(on.maxAudioBytes, limit)
        let off = try XCTUnwrap(WatchGatePublishing.gate(status: status(active: false), statusKnown: true, paired: true, now: now))
        XCTAssertFalse(off.active)
    }

    /// A gateway that predates the field reports a status without it: off.
    func testStatusWithoutTheFieldIsOff() throws {
        let gate = try XCTUnwrap(WatchGatePublishing.gate(status: nil, statusKnown: true, paired: true, now: now))
        XCTAssertFalse(gate.active)
    }

    func testUnpairedIsOffWithoutAStatus() throws {
        let gate = try XCTUnwrap(WatchGatePublishing.gate(status: nil, statusKnown: false, paired: false, now: now))
        XCTAssertFalse(gate.active)
    }

    // MARK: - When to publish

    func testPublishesTheFirstGateAndChanges() {
        let on = WatchDictationGate(active: true, maxAudioBytes: limit, updatedAt: now)
        XCTAssertTrue(WatchGatePublishing.shouldPublish(on, after: nil, now: now))
        let off = WatchDictationGate(active: false, maxAudioBytes: 0, updatedAt: now)
        XCTAssertTrue(WatchGatePublishing.shouldPublish(off, after: on, now: now))
        let smaller = WatchDictationGate(active: true, maxAudioBytes: 1000, updatedAt: now)
        XCTAssertTrue(WatchGatePublishing.shouldPublish(smaller, after: on, now: now))
    }

    func testAnUnchangedGateWaitsForTheDailyRefresh() {
        let last = WatchDictationGate(active: true, maxAudioBytes: limit, updatedAt: now)
        let later = now.addingTimeInterval(60 * 60)
        XCTAssertFalse(WatchGatePublishing.shouldPublish(
            WatchDictationGate(active: true, maxAudioBytes: limit, updatedAt: later), after: last, now: later
        ))
        let nextDay = now.addingTimeInterval(WatchGatePublishing.refreshInterval)
        XCTAssertTrue(WatchGatePublishing.shouldPublish(
            WatchDictationGate(active: true, maxAudioBytes: limit, updatedAt: nextDay), after: last, now: nextDay
        ))
        XCTAssertLessThan(WatchGatePublishing.refreshInterval, WatchDictationGate.staleAfter)
    }

    // MARK: - What the phone keeps

    func testTheGateSurvivesARelaunch() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "watch-gate-\(UUID().uuidString)"))
        XCTAssertNil(WatchDictationGateStore(defaults: defaults).load())
        WatchDictationGateStore(defaults: defaults).save(WatchDictationGate(active: true, maxAudioBytes: limit, updatedAt: now))

        let loaded = try XCTUnwrap(WatchDictationGateStore(defaults: defaults).load())
        XCTAssertTrue(loaded.active)
        XCTAssertEqual(loaded.maxAudioBytes, limit)
    }

    // MARK: - Queued relays

    private final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [String] = []
        var all: [String] {
            lock.lock()
            defer { lock.unlock() }
            return list
        }

        func add(_ call: String) {
            lock.lock()
            list.append(call)
            lock.unlock()
        }
    }

    private func handler(calls: Calls) -> WatchQueuedRelayHandler {
        let now = now
        let refs = RefBox()
        return WatchQueuedRelayHandler(
            route: { payload in refs.route(payload, now: now) },
            saveNote: { text, _, id in calls.add("note \(id ?? "-"): \(text)") },
            ask: { calls.add("ask: \($0)") },
            notify: { calls.add($0 == .questionExpired ? "expired" : "other") }
        )
    }

    private final class RefBox: @unchecked Sendable {
        private let lock = NSLock()
        private var refs = WatchRelayRecentRefs()

        func route(_ payload: [String: Any], now: Date) -> WatchRelayInbox.Action {
            lock.lock()
            defer { lock.unlock() }
            return WatchRelayInbox.route(queued: payload, now: now, handled: &refs)
        }
    }

    private func queued(_ message: [String: String], at date: Date) -> [String: String] {
        WatchRelayQueue.queued(message, envelope: WatchRelayQueue.Envelope(queuedAt: date, attempts: 3, lastErrorCode: 7007))
    }

    func testAQueuedNoteIsSavedUnderItsRef() async {
        let calls = Calls()
        let note = WatchNoteWire.request(
            text: "Water the tomatoes",
            captureTime: NoteCaptureTime.now(date: now),
            ref: "9d3e7c1a-2b4f-4e8a-9c6d-0f1e2a3b4c5d"
        )
        await handler(calls: calls).handle(queued(note, at: now))
        XCTAssertEqual(calls.all, ["note 9d3e7c1a-2b4f-4e8a-9c6d-0f1e2a3b4c5d: Water the tomatoes"])
    }

    func testAQueuedQuestionIsAskedOnce() async {
        let calls = Calls()
        let relay = handler(calls: calls)
        let question = queued(SiriAskWire.request(question: "Is the car booked in?", ref: "q1"), at: now)
        await relay.handle(question)
        await relay.handle(question)
        XCTAssertEqual(calls.all, ["ask: Is the car booked in?"])
    }

    func testAnExpiredQueuedQuestionIsReported() async {
        let calls = Calls()
        let old = now.addingTimeInterval(-WatchRelayQueue.askExpiry - 60)
        await handler(calls: calls).handle(queued(SiriAskWire.request(question: "Is it raining?", ref: "q2"), at: old))
        XCTAssertEqual(calls.all, ["expired"])
    }
}
