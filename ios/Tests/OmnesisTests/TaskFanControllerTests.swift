// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import CoreGraphics
@testable import Omnesis
import XCTest

/// The fan a finger drove always closes when the finger lifts — the device
/// bug was a fan left open after a press slid off its targets, which kept the
/// list from scrolling.
@available(iOS 17.0, *)
@MainActor
final class TaskFanControllerTests: XCTestCase {
    private let task = TaskRecord(id: "loop_1", title: "Book the venue tour", scheduledFor: "2026-10-20")
    private let press = CGPoint(x: 290, y: 420)

    private func controller() -> (TaskFanController, () -> [TaskFanAction]) {
        let fan = TaskFanController()
        fan.bounds = CGRect(x: 0, y: 0, width: 393, height: 700)
        var performed: [TaskFanAction] = []
        fan.perform = { action, _ in performed.append(action) }
        return (fan, { performed })
    }

    func testLiftingOffTheTargetsAfterSlidingCloses() throws {
        let (fan, performed) = controller()
        fan.open(task, at: press, today: "2026-10-14")
        let done = try XCTUnwrap(fan.session?.targets.first { $0.action == .done })
        fan.move(done.center)
        fan.move(CGPoint(x: 380, y: 690))
        fan.end(CGPoint(x: 380, y: 690))
        XCTAssertNil(fan.session)
        XCTAssertNil(fan.task)
        XCTAssertEqual(performed(), [])
    }

    func testLiftingOnATargetActsAndCloses() throws {
        let (fan, performed) = controller()
        fan.open(task, at: press, today: "2026-10-14")
        let tomorrow = try XCTUnwrap(fan.session?.targets.first { $0.action == .tomorrow })
        fan.move(tomorrow.center)
        fan.end(tomorrow.center)
        XCTAssertNil(fan.session)
        XCTAssertEqual(performed(), [.tomorrow])
    }

    func testATouchTakenAwayClosesWithoutActing() throws {
        let (fan, performed) = controller()
        fan.open(task, at: press, today: "2026-10-14")
        let done = try XCTUnwrap(fan.session?.targets.first { $0.action == .done })
        fan.move(done.center)
        fan.end(nil)
        XCTAssertNil(fan.session)
        XCTAssertEqual(performed(), [])
    }

    func testARepeatedEndIsHarmless() {
        let (fan, performed) = controller()
        fan.open(task, at: press, today: "2026-10-14")
        fan.end(press)
        fan.end(press)
        fan.end(nil)
        XCTAssertNil(fan.session)
        XCTAssertEqual(performed(), [])
    }

    /// A fan VoiceOver opened is not the finger's to close.
    func testAFanOpenedForVoiceOverIgnoresAFingerLifting() {
        let (fan, _) = controller()
        fan.rowFrames = [task.id: CGRect(x: 0, y: 380, width: 393, height: 80)]
        fan.openForAccessibility(task, today: "2026-10-14", mode: .main)
        fan.end(press)
        XCTAssertNotNil(fan.session)
        fan.dismiss()
        XCTAssertNil(fan.session)
    }
}
#endif
