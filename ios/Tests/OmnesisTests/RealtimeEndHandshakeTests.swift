// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@MainActor
final class RealtimeEndHandshakeTests: XCTestCase {
    func testDuplicateEndRequestsWaitForTheSameAcknowledgment() async {
        let handshake = RealtimeEndHandshake()
        let generation = UUID()
        let sent = expectation(description: "Media end sent")
        var sends = 0
        let first = Task {
            await handshake.wait(generation: generation) { sends += 1
                sent.fulfill()
            }
        }
        await fulfillment(of: [sent], timeout: 1)
        XCTAssertTrue(handshake.isWaiting(generation: generation))
        let second = Task { await handshake.wait(generation: generation) { sends += 1 } }
        await Task.yield()
        XCTAssertTrue(handshake.isWaiting(generation: generation), "Text must remain gated until the gateway releases its lease")
        handshake.acknowledge(generation: generation)
        let firstOutcome = await first.value
        let secondOutcome = await second.value
        XCTAssertEqual(firstOutcome, .acknowledged)
        XCTAssertEqual(secondOutcome, .acknowledged)
        XCTAssertEqual(sends, 1)
        XCTAssertFalse(handshake.isWaiting(generation: generation))
    }

    func testMissingAcknowledgmentTimesOutAndCleansUp() async {
        let handshake = RealtimeEndHandshake()
        let generation = UUID()
        let outcome = await handshake.wait(generation: generation, timeout: .milliseconds(20)) {}
        XCTAssertEqual(outcome, .timedOut)
        XCTAssertFalse(handshake.isWaiting(generation: generation))
        var sends = 0
        let repeated = await handshake.wait(generation: generation) { sends += 1 }
        XCTAssertEqual(repeated, .timedOut)
        XCTAssertEqual(sends, 0)
    }

    func testForcedDisconnectAndStaleAcknowledgmentCannotCompleteANewerCall() async {
        let handshake = RealtimeEndHandshake()
        let oldGeneration = UUID()
        let oldSent = expectation(description: "Old media end sent")
        let old = Task { await handshake.wait(generation: oldGeneration) { oldSent.fulfill() } }
        await fulfillment(of: [oldSent], timeout: 1)
        handshake.cancel(generation: oldGeneration)
        let oldOutcome = await old.value
        XCTAssertEqual(oldOutcome, .cancelled)

        let newGeneration = UUID()
        let newSent = expectation(description: "New media end sent")
        let new = Task { await handshake.wait(generation: newGeneration) { newSent.fulfill() } }
        await fulfillment(of: [newSent], timeout: 1)
        handshake.acknowledge(generation: oldGeneration)
        handshake.cancel(generation: oldGeneration)
        XCTAssertTrue(handshake.isWaiting(generation: newGeneration))
        handshake.acknowledge(generation: newGeneration)
        let newOutcome = await new.value
        XCTAssertEqual(newOutcome, .acknowledged)
    }
}
