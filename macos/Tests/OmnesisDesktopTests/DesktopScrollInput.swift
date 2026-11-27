// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import CoreGraphics
import Foundation
import XCTest

private final class DesktopLiveScrollCounts: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    func record(_ name: String) {
        lock.withLock { counts[name, default: 0] += 1 }
    }

    var snapshot: [String: Int] {
        lock.withLock { counts }
    }
}

/// Local native input only: never posts events to the session or changes focus.
@MainActor
enum DesktopScrollInput {
    struct Failure: Error, CustomStringConvertible { let description: String }

    static func scrollUp(_ scroll: NSScrollView, in window: NSWindow, evidence name: String) async throws {
        func require(_ condition: Bool, _ message: String) throws {
            if !condition { throw Failure(description: message) }
        }
        func ownsTarget() -> Bool {
            guard let content = window.contentView else { return false }
            return scroll.window === window && scroll.isDescendant(of: content) && window.isVisible &&
                !scroll.isHiddenOrHasHiddenAncestor && scroll.bounds.width > 0 && scroll.bounds.height > 0
        }
        try require(ownsTarget(), "Local scroll input requires its exact attached owned window")
        let allowedName = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")
        try require(
            !name.isEmpty && name.utf8.count <= 64 && name.unicodeScalars.allSatisfy(allowedName.contains),
            "Invalid local evidence name"
        )
        let document = try { () throws -> NSView in
            guard let document = scroll.documentView else { throw Failure(description: "The owned scroll view has no document") }
            return document
        }()
        let clip = scroll.contentView
        let viewport = clip.bounds.height
        try require(
            viewport.isFinite && viewport >= 1 && document.bounds.height.isFinite && document.bounds.height > 0,
            "The local gesture requires finite document and viewport dimensions"
        )
        let packetSize = floor(viewport)
        let plannedPixels = ceil(document.bounds.height)
        let count = ceil(plannedPixels / packetSize)
        try require(
            count.isFinite && count >= 1 && count <= 16 && packetSize <= CGFloat(Int32.max),
            "The local fixture exceeds the sixteen-packet gesture budget"
        )
        guard let source = CGEventSource(stateID: .privateState) else {
            throw Failure(description: "The private local event source could not be created")
        }
        func event(_ phase: CGScrollPhase, expected: NSEvent.Phase, delta: Int32) throws -> NSEvent {
            guard let raw = CGEvent(
                scrollWheelEvent2Source: source,
                units: .pixel,
                wheelCount: 1,
                wheel1: delta,
                wheel2: 0,
                wheel3: 0
            ) else {
                throw Failure(description: "The public pixel-wheel factory refused input")
            }
            raw.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase.rawValue))
            raw.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            raw.setIntegerValueField(.scrollWheelEventMomentumPhase, value: 0)
            guard let native = NSEvent(cgEvent: raw) else { throw Failure(description: "The public native event conversion failed") }
            try require(
                native.type == .scrollWheel && native.phase == expected && native.momentumPhase.isEmpty,
                "Converted type=\(native.type.rawValue) phase=\(native.phase.rawValue) expected=\(expected.rawValue) momentum=\(native.momentumPhase.rawValue)"
            )
            try require(
                native.hasPreciseScrollingDeltas && native.scrollingDeltaY.isFinite && native.scrollingDeltaX == 0,
                "Converted precise=\(native.hasPreciseScrollingDeltas) finiteY=\(native.scrollingDeltaY.isFinite) deltaX=\(native.scrollingDeltaX)"
            )
            try require(
                delta == 0 ? native.scrollingDeltaY == 0 : native.scrollingDeltaY > 0 && native.scrollingDeltaY <= viewport,
                "Converted deltaY=\(native.scrollingDeltaY) requested=\(delta) viewport=\(viewport)"
            )
            return native
        }
        struct Packet {
            let phase: CGScrollPhase
            let expected: NSEvent.Phase
            let delta: Int32
            let name: String
        }
        let began = Packet(phase: .began, expected: .began, delta: 0, name: "began")
        let ended = Packet(phase: .ended, expected: .ended, delta: 0, name: "ended")
        // Validate the fixed recipe before beginning; create each event when it occurs.
        let changed: [Packet] = try {
            var result: [Packet] = []
            var remaining = plannedPixels
            for _ in 0 ..< Int(count) {
                let pixels = min(packetSize, remaining)
                try require(pixels.isFinite && pixels >= 1 && pixels <= viewport, "Invalid planned pixel delta")
                result.append(Packet(phase: .changed, expected: .changed, delta: Int32(pixels), name: "changed"))
                remaining -= pixels
            }
            try require(remaining == 0, "The fixed gesture must account for its complete pixel budget")
            return result
        }()
        for packet in [began] + changed + [ended] {
            _ = try event(packet.phase, expected: packet.expected, delta: packet.delta)
        }
        let counts = DesktopLiveScrollCounts()
        let notifications: [(Notification.Name, String)] = [
            (NSScrollView.willStartLiveScrollNotification, "began"),
            (NSScrollView.didLiveScrollNotification, "changed"),
            (NSScrollView.didEndLiveScrollNotification, "ended"),
        ]
        let observers = notifications.map { notification, label in
            NotificationCenter.default.addObserver(forName: notification, object: scroll, queue: .main) { _ in counts.record(label) }
        }
        func topDistance() -> CGFloat {
            document.isFlipped ? document.visibleRect.minY - document.bounds.minY : document.bounds.maxY - document.visibleRect.maxY
        }
        func rectangle(_ rect: NSRect) -> [String: Double] {
            ["x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)]
        }
        var packets: [[String: Any]] = []
        let deliveryOrigin = ContinuousClock.now
        var previousEventTimestamp: TimeInterval?
        var previousCGTimestamp: CGEventTimestamp?
        func deliver(_ packet: Packet) throws {
            try require(ownsTarget(), "The local input target changed before packet delivery")
            let event = try event(packet.phase, expected: packet.expected, delta: packet.delta)
            let timestamp = event.timestamp
            guard let cgTimestamp = event.cgEvent?.timestamp else {
                throw Failure(description: "The converted local event has no Quartz timestamp")
            }
            let elapsed = deliveryOrigin.duration(to: .now).components
            let deliveryMilliseconds = Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15
            try require(
                timestamp.isFinite && timestamp >= 0 && deliveryMilliseconds.isFinite && deliveryMilliseconds >= 0,
                "Local event timing must be finite and nonnegative"
            )
            try require(
                previousEventTimestamp.map { timestamp >= $0 } ?? true,
                "Native event occurrence times must not move backwards"
            )
            try require(
                previousCGTimestamp.map { cgTimestamp >= $0 } ?? true,
                "Quartz event occurrence times must not move backwards"
            )
            previousEventTimestamp = timestamp
            previousCGTimestamp = cgTimestamp
            let before = topDistance()
            scroll.scrollWheel(with: event)
            packets.append([
                "phase": packet.name,
                "eventType": event.type.rawValue,
                "eventTimestamp": timestamp,
                "cgTimestampNanoseconds": cgTimestamp,
                "deliveryMilliseconds": deliveryMilliseconds,
                "cgPhase": event.cgEvent?.getIntegerValueField(.scrollWheelEventScrollPhase) as Any? ?? NSNull(),
                "cocoaPhase": event.phase.rawValue,
                "deltaY": event.scrollingDeltaY,
                "eventWindowMatches": event.window === window,
                "targetWindowMatches": scroll.window === window,
                "topDistanceBefore": before,
                "clipBoundsAfter": rectangle(clip.bounds),
                "documentBoundsAfter": rectangle(document.bounds),
                "visibleRectAfter": rectangle(document.visibleRect),
            ])
        }
        var beganDelivered = false, endedDelivered = false
        var firstMovementUp: Bool?
        var outcome = "interrupted"
        defer {
            if beganDelivered, !endedDelivered {
                do {
                    try deliver(ended)
                    endedDelivered = true
                } catch {
                    XCTFail("The owned local gesture could not deliver its ending phase")
                }
            }
            observers.forEach { NotificationCenter.default.removeObserver($0) }
            let record: [String: Any] = [
                "outcome": outcome,
                "plannedChangedPackets": changed.count,
                "beganDelivered": beganDelivered,
                "endedDelivered": endedDelivered,
                "firstMovementUp": firstMovementUp as Any? ?? NSNull(),
                "liveScrollNotifications": counts.snapshot,
                "packets": packets,
            ]
            let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
                try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
                    .write(to: output.appendingPathComponent(name + ".txt"))
            } catch { XCTFail("Local scroll input evidence could not be retained") }
        }
        try require(ownsTarget(), "The local input target changed before gesture delivery")
        try deliver(began)
        beganDelivered = true
        for packet in changed {
            try Task.checkCancellation()
            try require(ownsTarget(), "The local input target changed during gesture delivery")
            let before = topDistance()
            try deliver(packet)
            try await Task.sleep(for: .milliseconds(16))
            let after = topDistance()
            packets[packets.count - 1]["topDistanceAfterYield"] = after
            packets[packets.count - 1]["clipBoundsAfterYield"] = rectangle(clip.bounds)
            packets[packets.count - 1]["documentBoundsAfterYield"] = rectangle(document.bounds)
            packets[packets.count - 1]["visibleRectAfterYield"] = rectangle(document.visibleRect)
            if firstMovementUp == nil, abs(after - before) > 1 / window.backingScaleFactor {
                firstMovementUp = after < before
                try require(firstMovementUp == true, "The first actual wheel movement was not toward the document top")
            }
        }
        try deliver(ended)
        endedDelivered = true
        await Task.yield()
        try require(firstMovementUp == true, "The local gesture produced no verified upward native movement")
        outcome = "delivered"
    }
}
