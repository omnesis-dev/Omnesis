// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
@testable import Omnesis
import XCTest

/// Every sequence a long-press recognizer can report ends the press exactly
/// once and gives scrolling back — the list must never be left unable to
/// scroll after a fan.
final class TaskPressLifecycleTests: XCTestCase {
    private let press = CGPoint(x: 290, y: 420)
    private let off = CGPoint(x: 380, y: 690)

    private func run(_ reports: [TaskPressLifecycle.Report]) -> [TaskPressLifecycle.Command] {
        var lifecycle = TaskPressLifecycle()
        let commands = reports.flatMap { lifecycle.handle($0) }
        XCTAssertFalse(lifecycle.active, "a press is left open after \(reports)")
        return commands
    }

    private func balanced(_ commands: [TaskPressLifecycle.Command]) -> Bool {
        var suspended = 0
        for command in commands {
            if command == .suspendScrolling { suspended += 1 }
            if command == .resumeScrolling { suspended -= 1 }
            if suspended < 0 || suspended > 1 { return false }
        }
        return suspended == 0
    }

    func testBeganThenEndedOffTargetEndsOnceAndResumes() {
        let commands = run([.began(press), .changed(off), .ended(off)])
        XCTAssertEqual(commands, [.suspendScrolling, .begin(press), .move(off), .end(off), .resumeScrolling])
    }

    func testCancelledAndFailedEndWithoutActing() {
        XCTAssertEqual(run([.began(press), .cancelled]), [.suspendScrolling, .begin(press), .end(nil), .resumeScrolling])
        XCTAssertEqual(run([.began(press), .failed]), [.suspendScrolling, .begin(press), .end(nil), .resumeScrolling])
    }

    func testAReportAfterTheEndChangesNothing() {
        let commands = run([.began(press), .cancelled, .ended(off), .changed(off), .failed])
        XCTAssertEqual(commands.filter { if case .end = $0 { true } else { false } }.count, 1)
        XCTAssertTrue(balanced(commands))
    }

    func testDetachingMidPressEndsItAndResumes() {
        XCTAssertEqual(run([.began(press), .changed(off), .detached]).suffix(2), [.end(nil), .resumeScrolling])
    }

    func testReportsWithoutABeginDoNothing() {
        XCTAssertEqual(run([.changed(off), .ended(off), .cancelled, .detached]), [])
    }

    func testABeginWhileOneIsOpenEndsTheStaleOneFirst() {
        let commands = run([.began(press), .began(off), .ended(off)])
        XCTAssertEqual(
            commands,
            [.suspendScrolling, .begin(press), .end(nil), .resumeScrolling, .suspendScrolling, .begin(off), .end(off), .resumeScrolling]
        )
        XCTAssertTrue(balanced(commands))
    }
}
