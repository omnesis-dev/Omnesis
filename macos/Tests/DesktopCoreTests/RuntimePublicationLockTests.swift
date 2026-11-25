// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
@testable import DesktopCore
import XCTest

final class RuntimePublicationLockTests: XCTestCase {
    private func descriptors() throws -> (Int32, Int32) {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-publication-fixture-\(UUID().uuidString)")
        let first = Darwin.open(path.path, O_RDWR | O_CREAT | O_EXCL, 0o600)
        let second = Darwin.open(path.path, O_RDWR)
        guard first >= 0, second >= 0 else { throw CocoaError(.fileWriteUnknown) }
        addTeardownBlock { Darwin.close(first)
            Darwin.close(second)
            try? FileManager.default.removeItem(at: path)
        }
        return (first, second)
    }

    func testSharedConsumersCoexistAndExcludePublication() throws {
        let (first, second) = try descriptors()
        try DesktopRuntimePublicationLock.acquire(first, mode: .shared)
        try DesktopRuntimePublicationLock.acquire(second, mode: .shared)
        flock(second, LOCK_UN)
        XCTAssertNotEqual(flock(second, LOCK_EX | LOCK_NB), 0)
        flock(first, LOCK_UN)
        try DesktopRuntimePublicationLock.acquire(second)
        flock(second, LOCK_UN)
    }

    func testContendedLockHasBoundedTimeoutAndDoesNotStealOwner() throws {
        let (first, second) = try descriptors()
        try DesktopRuntimePublicationLock.acquire(first)
        let clock = ContinuousClock()
        let start = clock.now
        XCTAssertThrowsError(try DesktopRuntimePublicationLock.acquire(second, timeout: .milliseconds(100)))
        XCTAssertLessThan(start.duration(to: clock.now), .seconds(5))
        XCTAssertNotEqual(flock(second, LOCK_EX | LOCK_NB), 0)
        flock(first, LOCK_UN)
    }

    func testCancelledWaitReturnsWithoutReleasingAnotherOwner() async throws {
        let (first, second) = try descriptors()
        try DesktopRuntimePublicationLock.acquire(first)
        let waiter = Task.detached { try DesktopRuntimePublicationLock.acquire(second) }
        try await Task.sleep(for: .milliseconds(100))
        waiter.cancel()
        do { try await waiter.value
            XCTFail("Cancelled waiter must refuse acquisition")
        } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertNotEqual(flock(second, LOCK_EX | LOCK_NB), 0)
        flock(first, LOCK_UN)
    }
}
