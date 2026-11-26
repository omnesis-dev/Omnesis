// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class BackgroundOriginRegistrationTests: XCTestCase {
    private func fixture(_ body: (URL, URL) async throws -> Void) async throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("origin-registration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        let root = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(temporary.path))
        defer { try? FileManager.default.removeItem(at: root) }
        try await body(root, root.appendingPathComponent("archive"))
    }

    private func app(_ root: URL, _ name: String) throws -> URL {
        let application = root.appendingPathComponent(name + ".app")
        let runtime = application.appendingPathComponent("Contents/Resources/runtime")
        try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
        try Data("invented-registration-code".utf8).write(to: runtime.appendingPathComponent("desktop-runtime.json"))
        return application
    }

    func testMoveBetweenResolutionAndRegistrationCannotVerifyReplacementAtOldPath() async throws {
        try await fixture { root, archive in
            let original = try app(root, "Original")
            let record = try DesktopBackgroundApplicationOrigin.capture(original, archiveRoot: archive, validate: { _ in })
            let resolved = try DesktopBackgroundApplicationOrigin.resolve(record, archiveRoot: archive, validate: { _ in })
            try FileManager.default.moveItem(at: original, to: root.appendingPathComponent("Moved.app"))
            _ = try app(root, "Original")
            let registration = DesktopBackgroundOriginRegistration(application: resolved) { _, _, _ in }
            defer { registration.stop() }
            do {
                _ = try await Task.detached { try registration.verify(record, archiveRoot: archive, validate: { _ in }) }.value
                XCTFail("Replacement at the old path cannot acquire the original attachment")
            } catch {}
            XCTAssertFalse(registration.isVerified)
        }
    }

    func testReplacementDuringPostRegistrationCheckCannotPublishReadiness() async throws {
        try await fixture { root, archive in
            let original = try app(root, "Original")
            let record = try DesktopBackgroundApplicationOrigin.capture(original, archiveRoot: archive, validate: { _ in })
            let registration = DesktopBackgroundOriginRegistration(application: original) { _, _, _ in }
            defer { registration.stop() }
            do {
                _ = try await Task.detached {
                    try registration.verify(record, archiveRoot: archive, validate: { _ in
                        try FileManager.default.moveItem(at: original, to: root.appendingPathComponent("Moved.app"))
                        try FileManager.default.createDirectory(at: original, withIntermediateDirectories: true)
                    })
                }.value
                XCTFail("A post-registration identity change must fail before readiness")
            } catch {}
            XCTAssertFalse(registration.isVerified)
        }
    }

    func testPendingMoveInvalidatesProofAndStoppedOldCallbackCannotAffectSuccessor() async throws {
        try await fixture { root, archive in
            let original = try app(root, "Original")
            let record = try DesktopBackgroundApplicationOrigin.capture(original, archiveRoot: archive, validate: { _ in })
            let old = DesktopBackgroundOriginRegistration(application: original) { _, _, _ in
                XCTFail("Stopped registration callback escaped")
            }
            old.stop()
            let next = DesktopBackgroundOriginRegistration(application: original) { _, _, _ in }
            defer { next.stop() }
            _ = try await Task.detached { try next.verify(record, archiveRoot: archive, validate: { _ in }) }.value
            XCTAssertTrue(next.isVerified)
            old.accommodatePresentedItemDeletion { XCTAssertNil($0) }
            XCTAssertTrue(next.isVerified)
            next.presentedItemDidMove(to: root.appendingPathComponent("QueuedMove.app"))
            XCTAssertFalse(next.isVerified)
            XCTAssertNotEqual(old.id, next.id)
        }
    }

    func testRapidMovesDiscardOlderSameAttachmentEventsBeforeAndAfterVerification() async throws {
        final class Events: @unchecked Sendable {
            private let lock = NSLock()
            private var values: [(UInt64, URL?)] = []
            func append(_ generation: UInt64, _ location: URL?) {
                lock.lock()
                values.append((generation, location))
                lock.unlock()
            }

            func event(_ location: URL) -> UInt64? {
                lock.lock()
                defer { lock.unlock() }
                return values.last { $0.1?.path == location.path }?.0
            }
        }
        try await fixture { root, archive in
            let original = try app(root, "A")
            let record = try DesktopBackgroundApplicationOrigin.capture(original, archiveRoot: archive, validate: { _ in })
            let events = Events()
            let registration = DesktopBackgroundOriginRegistration(application: original) { _, event, location in events.append(
                event,
                location
            ) }
            defer { registration.stop() }
            let middle = root.appendingPathComponent("B.app")
            try FileManager.default.moveItem(at: original, to: middle)
            registration.presentedItemDidMove(to: middle)
            let stale = try XCTUnwrap(events.event(middle))
            XCTAssertTrue(registration.isCurrent(event: stale))
            let current = root.appendingPathComponent("C.app")
            try FileManager.default.moveItem(at: middle, to: current)
            registration.presentedItemDidMove(to: current)
            let latest = try XCTUnwrap(events.event(current))
            XCTAssertFalse(registration.isCurrent(event: stale))
            XCTAssertTrue(registration.isCurrent(event: latest))
            let verified = try await Task.detached { try registration.verify(record, archiveRoot: archive, validate: { _ in }) }.value
            XCTAssertEqual(verified.path, current.path)
            XCTAssertTrue(registration.isVerified)
            XCTAssertFalse(registration.isCurrent(event: stale))
            XCTAssertTrue(registration.isCurrent(event: latest))
            registration.accommodatePresentedItemDeletion { XCTAssertNil($0) }
            XCTAssertFalse(registration.isVerified)
            XCTAssertFalse(registration.isCurrent(event: latest))
        }
    }

    func testLivePendingClientNeverCountsAsGoneAndDifferentBirthIsExactOldIncarnationAbsence() throws {
        let identity = try DesktopBackgroundProcessIdentity.read(getpid())
        let live = DesktopBackgroundOriginStatus.Client(
            pid: getpid(),
            birth: .init(seconds: String(identity.startedSeconds), microseconds: String(identity.startedMicroseconds))
        )
        XCTAssertFalse(live.isGone())
        let previous = DesktopBackgroundOriginStatus.Client(
            pid: getpid(),
            birth: .init(seconds: String(identity.startedSeconds + 1), microseconds: String(identity.startedMicroseconds))
        )
        XCTAssertTrue(previous.isGone())
    }

    func testActualOwnedClientExitProvidesDeathProofWithoutTimeoutOrExpiry() throws {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        defer { if child.isRunning { child.terminate()
            child.waitUntilExit()
        } }
        let identity = try DesktopBackgroundProcessIdentity.read(child.processIdentifier)
        let client = DesktopBackgroundOriginStatus.Client(
            pid: identity.pid,
            birth: .init(seconds: String(identity.startedSeconds), microseconds: String(identity.startedMicroseconds))
        )
        XCTAssertFalse(client.isGone())
        child.terminate()
        child.waitUntilExit()
        XCTAssertTrue(client.isGone())
    }
}
