// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The watch → iPhone delivery rules: how long the watch keeps retrying an
/// iPhone app that has not picked up a relay, the queued payload it falls
/// back to, and the phone's guard against acting on one relay twice.
final class WatchRelayDeliveryTests: XCTestCase {
    // MARK: - Delivery window

    /// Replays the watch's loop with sends that each take `sendDuration`: the
    /// time at which each attempt starts, until the schedule gives up.
    private func schedule(sendDuration: TimeInterval) -> [TimeInterval] {
        var starts: [TimeInterval] = []
        var elapsed: TimeInterval = 0
        while true {
            starts.append(elapsed)
            elapsed += sendDuration
            guard let pause = WatchRelayPatience.pause(afterAttempts: starts.count, elapsed: elapsed) else {
                return starts
            }
            elapsed += pause
        }
    }

    /// The first retries come quickly, for a suspended app about to answer.
    func testTheFirstRetryIsQuick() {
        XCTAssertEqual(WatchRelayPatience.pause(afterAttempts: 1, elapsed: 0.1), 0.7)
        XCTAssertEqual(WatchRelayPatience.pause(afterAttempts: 2, elapsed: 1), 1.5)
    }

    /// A cold launch takes seconds, not a beat: the watch keeps trying for
    /// most of the window rather than giving up after one retry.
    func testRetriesSpanTheDeliveryWindow() {
        let starts = schedule(sendDuration: 0)
        XCTAssertGreaterThan(starts.count, 5)
        let last = starts.last ?? 0
        XCTAssertGreaterThan(last, WatchRelayPatience.deliveryWindow - 4)
        XCTAssertLessThan(last, WatchRelayPatience.deliveryWindow)
    }

    /// Slow sends (each spending its reachability wait) use up the same
    /// window: no attempt ever starts past it.
    func testNoAttemptStartsPastTheWindow() {
        for duration in [0.0, 0.5, 3, 7, 25] {
            let starts = schedule(sendDuration: duration)
            XCTAssertGreaterThanOrEqual(starts.count, 1)
            for start in starts {
                XCTAssertLessThan(start, WatchRelayPatience.deliveryWindow, "send duration \(duration)")
            }
        }
    }

    func testTheLongestPauseRepeats() {
        XCTAssertEqual(WatchRelayPatience.pause(afterAttempts: 4, elapsed: 5), 3)
        XCTAssertEqual(WatchRelayPatience.pause(afterAttempts: 9, elapsed: 5), 3)
    }

    // MARK: - Queued payload

    func testAQueuedAskKeepsTheLiveMessageAndCarriesItsStamp() {
        let envelope = WatchRelayQueue.Envelope(
            queuedAt: Date(timeIntervalSince1970: 1_700_000_000.5),
            attempts: 6,
            lastErrorCode: 7007
        )
        let payload = WatchRelayQueue.queued(
            SiriAskWire.request(question: "anything tomorrow?", ref: "r1"),
            envelope: envelope
        )
        XCTAssertEqual(SiriAskWire.question(from: payload), "anything tomorrow?")
        XCTAssertEqual(SiriAskWire.ref(from: payload), "r1")
        XCTAssertEqual(WatchRelayQueue.envelope(from: payload), envelope)
    }

    func testAQueuedNoteKeepsItsCaptureTime() {
        let captureTime = NoteCaptureTime(
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            timeZoneId: "Europe/London",
            utcOffsetSeconds: 0
        )
        let payload = WatchRelayQueue.queued(
            WatchNoteWire.request(text: "Buy oat milk", captureTime: captureTime, ref: "n1"),
            envelope: .init(queuedAt: Date(), attempts: 1, lastErrorCode: nil)
        )
        XCTAssertEqual(WatchNoteWire.text(from: payload), "Buy oat milk")
        XCTAssertEqual(WatchNoteWire.captureTime(from: payload), captureTime)
        XCTAssertNil(WatchRelayQueue.envelope(from: payload)?.lastErrorCode)
    }

    /// Without a stamp the phone cannot tell a stale question from a fresh
    /// one, so it treats the payload as malformed instead of guessing.
    func testAPayloadWithoutAStampHasNoEnvelope() {
        XCTAssertNil(WatchRelayQueue.envelope(from: SiriAskWire.request(question: "q", ref: "r1")))
        XCTAssertNil(WatchRelayQueue.envelope(from: ["queuedAt": "yesterday"]))
        XCTAssertNil(WatchRelayQueue.envelope(from: ["queuedAt": "inf"]))
    }

    func testAQueuedAskExpiresAfterTheLimit() {
        let queuedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let envelope = WatchRelayQueue.Envelope(queuedAt: queuedAt, attempts: 1, lastErrorCode: nil)
        let limit = WatchRelayQueue.askExpiry
        XCTAssertFalse(WatchRelayQueue.askIsExpired(envelope, now: queuedAt.addingTimeInterval(limit - 1)))
        XCTAssertTrue(WatchRelayQueue.askIsExpired(envelope, now: queuedAt.addingTimeInterval(limit + 1)))
    }

    /// A watch clock ahead of the phone's must not lose the question.
    func testAQueuedAskFromTheFutureIsFresh() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let envelope = WatchRelayQueue.Envelope(
            queuedAt: now.addingTimeInterval(120),
            attempts: 1,
            lastErrorCode: nil
        )
        XCTAssertFalse(WatchRelayQueue.askIsExpired(envelope, now: now))
    }

    // MARK: - Recent refs

    func testARefIsHandledOnce() {
        var refs = WatchRelayRecentRefs()
        XCTAssertTrue(refs.insert("r1"))
        XCTAssertFalse(refs.insert("r1"))
        XCTAssertTrue(refs.insert("r2"))
    }

    func testTheOldestRefIsForgottenPastCapacity() {
        var refs = WatchRelayRecentRefs()
        for index in 0 ... WatchRelayRecentRefs.capacity {
            XCTAssertTrue(refs.insert("r\(index)"))
        }
        // r0 was evicted; the newest are still remembered.
        XCTAssertTrue(refs.insert("r0"))
        XCTAssertFalse(refs.insert("r\(WatchRelayRecentRefs.capacity)"))
    }

    func testARefLessRelayIsAlwaysNew() {
        var refs = WatchRelayRecentRefs()
        XCTAssertTrue(refs.insert(nil))
        XCTAssertTrue(refs.insert(nil))
    }

    // MARK: - Queued inbox

    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func queuedAsk(ref: String = "r1", age: TimeInterval = 5) -> [String: String] {
        WatchRelayQueue.queued(
            SiriAskWire.request(question: "anything tomorrow?", ref: ref),
            envelope: .init(queuedAt: now.addingTimeInterval(-age), attempts: 6, lastErrorCode: 7007)
        )
    }

    private func queuedNote(ref: String = "n1", age: TimeInterval = 5) -> [String: String] {
        let captureTime = NoteCaptureTime(
            capturedAt: now.addingTimeInterval(-age),
            timeZoneId: "Europe/London",
            utcOffsetSeconds: 0
        )
        return WatchRelayQueue.queued(
            WatchNoteWire.request(text: "Buy oat milk", captureTime: captureTime, ref: ref),
            envelope: .init(queuedAt: now.addingTimeInterval(-age), attempts: 6, lastErrorCode: nil)
        )
    }

    func testAFreshQueuedAskIsAsked() {
        var refs = WatchRelayRecentRefs()
        XCTAssertEqual(
            WatchRelayInbox.route(queued: queuedAsk(), now: now, handled: &refs),
            .ask(question: "anything tomorrow?")
        )
    }

    func testAStaleQueuedAskIsDropped() {
        var refs = WatchRelayRecentRefs()
        XCTAssertEqual(
            WatchRelayInbox.route(queued: queuedAsk(age: WatchRelayQueue.askExpiry + 1), now: now, handled: &refs),
            .drop(.expired)
        )
    }

    /// A note carries its own capture time, so however late it arrives it is
    /// saved — unlike a question, whose answer would come out of nowhere.
    func testAnOldQueuedNoteIsStillSaved() {
        var refs = WatchRelayRecentRefs()
        let action = WatchRelayInbox.route(
            queued: queuedNote(age: 6 * 3600),
            now: now,
            handled: &refs
        )
        guard case .saveNote(let text, _) = action else {
            return XCTFail("expected the note to be saved, got \(action)")
        }
        XCTAssertEqual(text, "Buy oat milk")
    }

    func testASecondCopyOfARelayIsDropped() {
        var refs = WatchRelayRecentRefs()
        _ = WatchRelayInbox.route(queued: queuedAsk(), now: now, handled: &refs)
        _ = WatchRelayInbox.route(queued: queuedNote(), now: now, handled: &refs)
        XCTAssertEqual(WatchRelayInbox.route(queued: queuedAsk(), now: now, handled: &refs), .drop(.duplicate))
        XCTAssertEqual(WatchRelayInbox.route(queued: queuedNote(), now: now, handled: &refs), .drop(.duplicate))
    }

    /// A live ask the phone already took shares its ref with the queued copy,
    /// so the copy is not asked again.
    func testAQueuedCopyOfALiveAskIsDropped() {
        var refs = WatchRelayRecentRefs()
        XCTAssertTrue(refs.insert("r1"))
        XCTAssertEqual(WatchRelayInbox.route(queued: queuedAsk(), now: now, handled: &refs), .drop(.duplicate))
    }

    /// An expired question is dropped before it is recorded, so its ref is not
    /// spent on something that was never acted on.
    func testAnExpiredAskDoesNotSpendItsRef() {
        var refs = WatchRelayRecentRefs()
        _ = WatchRelayInbox.route(queued: queuedAsk(age: WatchRelayQueue.askExpiry + 1), now: now, handled: &refs)
        XCTAssertTrue(refs.insert("r1"))
    }

    func testMalformedQueuedPayloadsAreDropped() {
        var refs = WatchRelayRecentRefs()
        XCTAssertEqual(
            WatchRelayInbox.route(queued: SiriAskWire.request(question: "q", ref: "r1"), now: now, handled: &refs),
            .drop(.unstamped)
        )
        var note = queuedNote()
        note.removeValue(forKey: "capturedAt")
        XCTAssertEqual(WatchRelayInbox.route(queued: note, now: now, handled: &refs), .drop(.noteWithoutCaptureTime))
        let unknown = WatchRelayQueue.queued(
            ["kind": "teleport"],
            envelope: .init(queuedAt: now, attempts: 1, lastErrorCode: nil)
        )
        XCTAssertEqual(WatchRelayInbox.route(queued: unknown, now: now, handled: &refs), .drop(.unknownKind))
    }

    // MARK: - Live ask ledger

    func testTheFirstCopyRunsAndALaterOneWaitsForItsReply() {
        var ledger = LiveAskLedger<String>()
        guard case .run = ledger.claim("r1", isNew: true, waiter: "first") else {
            return XCTFail("the first copy should run")
        }
        guard case .held = ledger.claim("r1", isNew: false, waiter: "retry") else {
            return XCTFail("a copy of a running ask should wait for it")
        }
        let reply = SiriAskWire.reply(for: .answered(text: "Friday."))
        XCTAssertEqual(ledger.settle("r1", reply: reply), ["retry"])
    }

    /// A copy that arrives after the first settled gets the same answer, not
    /// a guess about a turn that is already over.
    func testACopyAfterTheFirstSettledGetsItsReply() {
        var ledger = LiveAskLedger<String>()
        _ = ledger.claim("r1", isNew: true, waiter: "first")
        let reply = SiriAskWire.reply(for: .answered(text: "Friday."))
        XCTAssertEqual(ledger.settle("r1", reply: reply), [])
        guard case .reply(let got) = ledger.claim("r1", isNew: false, waiter: "late") else {
            return XCTFail("a late copy should get the settled reply")
        }
        XCTAssertEqual(got, reply)
        // Settling twice hands out nothing a second time.
        XCTAssertEqual(ledger.settle("r1", reply: reply), [])
    }

    func testACopyOfAnAskTheLedgerNeverRanIsUntracked() {
        var ledger = LiveAskLedger<String>()
        guard case .untracked = ledger.claim("r1", isNew: false, waiter: "copy") else {
            return XCTFail("an ask handled elsewhere should be untracked")
        }
    }

    func testTheLedgerForgetsItsOldestAsk() {
        var ledger = LiveAskLedger<String>()
        for index in 0 ... WatchRelayRecentRefs.capacity {
            _ = ledger.claim("r\(index)", isNew: true, waiter: "w")
        }
        guard case .untracked = ledger.claim("r0", isNew: false, waiter: "copy") else {
            return XCTFail("the oldest ask should have aged out")
        }
        guard case .held = ledger.claim("r\(WatchRelayRecentRefs.capacity)", isNew: false, waiter: "copy") else {
            return XCTFail("the newest ask should still be tracked")
        }
    }
}
