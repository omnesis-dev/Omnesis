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
        // Validate the complete input before beginning; no fallback reverses or enlarges it.
        let began = try event(.began, expected: .began, delta: 0)
        let ended = try event(.ended, expected: .ended, delta: 0)
        var changed: [NSEvent] = []
        var remaining = plannedPixels
        for _ in 0 ..< Int(count) {
            let pixels = min(packetSize, remaining)
            try changed.append(event(.changed, expected: .changed, delta: Int32(pixels)))
            remaining -= pixels
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
        func deliver(_ event: NSEvent, phase: String) {
            let before = topDistance()
            scroll.scrollWheel(with: event)
            packets.append([
                "phase": phase,
                "eventType": event.type.rawValue,
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
            if beganDelivered, !endedDelivered { deliver(ended, phase: "ended")
                endedDelivered = true
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
        deliver(began, phase: "began")
        beganDelivered = true
        for event in changed {
            try Task.checkCancellation()
            try require(ownsTarget(), "The local input target changed during gesture delivery")
            let before = topDistance()
            deliver(event, phase: "changed")
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
        deliver(ended, phase: "ended")
        endedDelivered = true
        await Task.yield()
        try require(firstMovementUp == true, "The local gesture produced no verified upward native movement")
        outcome = "delivered"
    }
}
