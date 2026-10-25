// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class RealtimePlaybackBufferTests: XCTestCase {
    func testSixtySecondReplyGeneratedFourTimesFasterThanPlaybackDrainsInOrder() {
        var buffer = RealtimePlaybackBuffer()
        var expected = Data()
        var actual = Data()
        var inFlight: [RealtimePlaybackBuffer.Packet] = []
        var produced = 0
        var clock: Int64 = 0
        while produced < 600 || !buffer.isEmpty {
            for _ in 0 ..< min(4, 600 - produced) {
                let data = Data(repeating: UInt8(produced % 256), count: 4800)
                expected.append(data)
                XCTAssertTrue(buffer.append(data, itemID: "answer"))
                produced += 1
            }
            while let packet = buffer.nextPacket(renderedFrame: clock, leadFrames: 0) {
                inFlight.append(packet)
                actual.append(packet.data)
                XCTAssertLessThanOrEqual(buffer.scheduledFrames, 48000)
            }
            clock += 2400
            while let packet = inFlight.first, packet.startFrame + packet.frameCount <= clock {
                XCTAssertTrue(buffer.complete(token: packet.token))
                inFlight.removeFirst()
            }
        }
        XCTAssertEqual(expected.count, 60 * 24000 * 2)
        XCTAssertEqual(actual, expected)
        XCTAssertEqual(buffer.retainedPCMBytes, 0)
        XCTAssertEqual(buffer.scheduledFrames, 0)
    }

    func testInstantSixtySecondBurstOnlySchedulesTwoSeconds() {
        var buffer = RealtimePlaybackBuffer()
        XCTAssertTrue(buffer.append(Data(repeating: 1, count: 60 * 24000 * 2), itemID: "answer"))
        var frames: Int64 = 0
        while let packet = buffer.nextPacket(renderedFrame: 0, leadFrames: 0) {
            frames += packet.frameCount
        }
        XCTAssertEqual(frames, 48000)
        XCTAssertNil(buffer.nextPacket(renderedFrame: 0))
        XCTAssertGreaterThan(buffer.retainedPCMBytes, 0)
    }

    func testTruncationUsesTheRenderedItemNotTheLatestReceivedItem() {
        var buffer = RealtimePlaybackBuffer()
        XCTAssertTrue(buffer.append(Data(repeating: 0, count: 48000), itemID: "first"))
        XCTAssertTrue(buffer.append(Data(repeating: 1, count: 48000), itemID: "second"))
        while buffer.nextPacket(renderedFrame: 0, leadFrames: 0) != nil {}
        XCTAssertEqual(buffer.truncations(at: 12000), [
            .init(itemID: "first", audioEndMilliseconds: 500),
            .init(itemID: "second", audioEndMilliseconds: 0),
        ])
        XCTAssertEqual(buffer.truncations(at: 36000), [.init(itemID: "second", audioEndMilliseconds: 500)])
        XCTAssertEqual(buffer.truncations(at: 100_000), [])
    }

    func testUnderrunDoesNotCountSilenceAsPlayedItemAudio() throws {
        var buffer = RealtimePlaybackBuffer()
        XCTAssertTrue(buffer.append(Data(repeating: 0, count: 4800), itemID: "answer"))
        let first = try XCTUnwrap(buffer.nextPacket(renderedFrame: 10000))
        XCTAssertEqual(first.startFrame, 10240)
        XCTAssertTrue(buffer.complete(token: first.token))
        XCTAssertTrue(buffer.append(Data(repeating: 1, count: 4800), itemID: "answer"))
        let second = try XCTUnwrap(buffer.nextPacket(renderedFrame: 50000))
        XCTAssertEqual(second.startFrame, 50240)
        XCTAssertEqual(buffer.truncations(at: 49000), [.init(itemID: "answer", audioEndMilliseconds: 100)])
        XCTAssertEqual(buffer.truncations(at: 51440), [.init(itemID: "answer", audioEndMilliseconds: 150)])
    }

    func testResetRejectsLateCompletionsAndRestartsThePlayerTimeline() throws {
        var buffer = RealtimePlaybackBuffer()
        XCTAssertTrue(buffer.append(Data(repeating: 0, count: 4800), itemID: "old"))
        let old = try XCTUnwrap(buffer.nextPacket(renderedFrame: 100_000))
        buffer.reset()
        XCTAssertTrue(buffer.append(Data(repeating: 1, count: 4800), itemID: "new"))
        let new = try XCTUnwrap(buffer.nextPacket(renderedFrame: 0))
        XCTAssertNotEqual(old.token, new.token)
        XCTAssertFalse(buffer.complete(token: old.token))
        XCTAssertEqual(buffer.scheduledFrames, new.frameCount)
        XCTAssertEqual(new.startFrame, 240)
        XCTAssertEqual(buffer.truncations(at: 0), [.init(itemID: "new", audioEndMilliseconds: 0)])
    }

    func testOverflowKeepsTheExistingQueueBoundedUntilItsOwnerCancelsTheReply() {
        var buffer = RealtimePlaybackBuffer(maximumBytes: 1024 * 1024)
        let data = Data(repeating: 0, count: 400_000)
        XCTAssertTrue(buffer.append(data, itemID: "answer"))
        XCTAssertFalse(buffer.append(data, itemID: "answer"))
        XCTAssertEqual(buffer.retainedPCMBytes, data.count)
        buffer.reset()
        XCTAssertTrue(buffer.isEmpty)
        XCTAssertTrue(buffer.append(data, itemID: "next-answer"))
    }
}
