// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import XCTest

/// One continuous touch with several segments — press, hold, slide, hold,
/// slide, lift — which `XCUICoordinate` cannot express (it offers one drag
/// per touch). The Tasks fan needs it: resting on "Other month…" and then
/// sliding onto a month is one gesture.
///
/// Built on XCTest's own event-synthesis classes, reached through the
/// Objective-C runtime because they are not in its public headers. When they
/// are missing the test is skipped with a message rather than passing.
struct TouchPath {
    private struct Step {
        let point: CGPoint
        let at: TimeInterval
    }

    private var steps: [Step]
    private var clock: TimeInterval = 0

    init(pressAt point: CGPoint) {
        steps = [Step(point: point, at: 0)]
    }

    /// Stay where the finger is for `seconds`. The synthesizer moves the
    /// touch smoothly between one point and the next, so a hold is a point
    /// at the same place at its end — without it the finger creeps towards
    /// the next point all through the hold.
    mutating func hold(_ seconds: TimeInterval) {
        clock += seconds
        if let point = steps.last?.point {
            steps.append(Step(point: point, at: clock))
        }
    }

    /// Slide to `point` over `seconds`, in small steps so every target on
    /// the way is entered and left.
    mutating func slide(to point: CGPoint, over seconds: TimeInterval = 0.3) {
        let from = steps.last?.point ?? point
        let count = 10
        for index in 1 ... count {
            let progress = CGFloat(index) / CGFloat(count)
            clock += seconds / Double(count)
            steps.append(Step(
                point: CGPoint(x: from.x + (point.x - from.x) * progress, y: from.y + (point.y - from.y) * progress),
                at: clock
            ))
        }
    }

    /// Lifts the finger where it is and plays the whole touch.
    func perform() throws {
        guard let pathClass = NSClassFromString("XCPointerEventPath") as? NSObject.Type,
              let recordClass = NSClassFromString("XCSynthesizedEventRecord") as? NSObject.Type
        else { throw XCTSkip("XCTest's event synthesis is not available") }

        let first = steps[0]
        let initSelector = NSSelectorFromString("initForTouchAtPoint:offset:")
        let moveSelector = NSSelectorFromString("moveToPoint:atOffset:")
        let liftSelector = NSSelectorFromString("liftUpAtOffset:")
        guard pathClass.instancesRespond(to: initSelector),
              pathClass.instancesRespond(to: moveSelector),
              pathClass.instancesRespond(to: liftSelector)
        else { throw XCTSkip("XCPointerEventPath has changed") }

        typealias InitPath = @convention(c) (AnyObject, Selector, CGPoint, Double) -> AnyObject
        typealias MovePath = @convention(c) (AnyObject, Selector, CGPoint, Double) -> Void
        typealias LiftPath = @convention(c) (AnyObject, Selector, Double) -> Void
        let allocated = pathClass.perform(NSSelectorFromString("alloc")).takeUnretainedValue()
        let initialize = unsafeBitCast(allocated.method(for: initSelector), to: InitPath.self)
        let path = initialize(allocated, initSelector, first.point, 0)
        let move = unsafeBitCast(path.method(for: moveSelector), to: MovePath.self)
        for step in steps.dropFirst() {
            move(path, moveSelector, step.point, step.at)
        }
        let lift = unsafeBitCast(path.method(for: liftSelector), to: LiftPath.self)
        lift(path, liftSelector, clock + 0.05)

        let recordInit = NSSelectorFromString("initWithName:interfaceOrientation:")
        typealias InitRecord = @convention(c) (AnyObject, Selector, NSString, Int) -> AnyObject
        let recordAllocated = recordClass.perform(NSSelectorFromString("alloc")).takeUnretainedValue()
        let makeRecord = unsafeBitCast(recordAllocated.method(for: recordInit), to: InitRecord.self)
        let record = makeRecord(recordAllocated, recordInit, "touch path" as NSString, 1)
        _ = record.perform(NSSelectorFromString("addPointerEventPath:"), with: path)

        let synthesize = NSSelectorFromString("synthesizeWithError:")
        guard record.responds(to: synthesize) else { throw XCTSkip("XCSynthesizedEventRecord cannot synthesize") }
        typealias Synthesize = @convention(c) (AnyObject, Selector, UnsafeMutablePointer<NSError?>?) -> Bool
        let run = unsafeBitCast(record.method(for: synthesize), to: Synthesize.self)
        var error: NSError?
        guard run(record, synthesize, &error) else {
            throw error ?? NSError(domain: "TouchPath", code: 1)
        }
    }
}
