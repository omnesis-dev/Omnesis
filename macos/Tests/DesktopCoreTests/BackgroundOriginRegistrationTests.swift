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
                _ = try await registration.verify(record, archiveRoot: archive, validate: { _ in })
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
                    try await registration.verify(record, archiveRoot: archive, validate: { _ in
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
            _ = try await next.verify(record, archiveRoot: archive, validate: { _ in })
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
            let verified = try await registration.verify(record, archiveRoot: archive, validate: { _ in })
            XCTAssertEqual(verified.path, current.path)
            XCTAssertTrue(registration.isVerified)
            XCTAssertFalse(registration.isCurrent(event: stale))
            XCTAssertTrue(registration.isCurrent(event: latest))
            registration.accommodatePresentedItemDeletion { XCTAssertNil($0) }
            XCTAssertFalse(registration.isVerified)
            XCTAssertFalse(registration.isCurrent(event: latest))
        }
    }

    func testMatchingPresenterCallbackBeyondTheDiagnosticPrefixIsClaimedExactlyOnce() {
        let events = PresenterQueueEvents()
        for _ in 0 ..< 4 {
            XCTAssertFalse(events.observeMove(rawPathEqual: false, canonicalMatch: false))
        }
        XCTAssertFalse(events.moveObservations.matchingCallbackObserved)
        XCTAssertTrue(events.observeMove(rawPathEqual: false, canonicalMatch: true))
        XCTAssertFalse(events.observeMove(rawPathEqual: false, canonicalMatch: true))
        let observations = events.moveObservations
        XCTAssertEqual(observations.values.count, 4)
        XCTAssertTrue(observations.values.allSatisfy { !$0.rawPathEqual && !$0.canonicalMatch })
        XCTAssertTrue(observations.truncated)
        XCTAssertTrue(observations.matchingCallbackObserved)
    }

    func testActualCoordinatedMovePrecedesVerificationOnTheExactPresenterQueue() async throws {
        try await fixture { root, archive in
            let original = try app(root, "QueuedOriginal")
            let moved = root.appendingPathComponent("QueuedMoved.app")
            // The destination need not exist until the real move. Canonicalize only its existing parent.
            let canonicalDestination = try DesktopCanonicalPath.resolve(root.path) + "/" + moved.lastPathComponent
            let record = try DesktopBackgroundApplicationOrigin.capture(original, archiveRoot: archive, validate: { _ in })
            let entered = expectation(description: "actual presenter move callback")
            let returned = expectation(description: "owned presenter callback returned")
            let gate = PresenterQueueGate()
            let events = PresenterQueueEvents()
            let registration = DesktopBackgroundOriginRegistration(application: original) { _, _, location in
                let rawPathEqual = location?.path == moved.path
                let canonicalMatch = location.flatMap { try? DesktopCanonicalPath.resolve($0.path) } == canonicalDestination
                guard events.observeMove(rawPathEqual: rawPathEqual, canonicalMatch: canonicalMatch) else { return }
                events.append("move")
                entered.fulfill()
                XCTAssertTrue(gate.wait(), "The owned callback hold must be released")
                events.append("callback-returning")
                returned.fulfill()
            }
            defer { registration.stop() }
            let moving = Task.detached { try Self.moveCoordinated(original, to: moved) }
            await fulfillment(of: [entered], timeout: 2)
            let verification = Task {
                try await registration.verify(record, archiveRoot: archive, validate: { current in
                    XCTAssertTrue(OperationQueue.current === registration.presentedItemOperationQueue)
                    XCTAssertEqual(try DesktopCanonicalPath.resolve(current.path), canonicalDestination)
                    let presented = try XCTUnwrap(registration.presentedItemURL)
                    XCTAssertEqual(try DesktopCanonicalPath.resolve(presented.path), canonicalDestination)
                    events.append("verify")
                })
            }
            let queued = expectation(for: NSPredicate { _, _ in
                registration.presentedItemOperationQueue.operationCount > 1
            }, evaluatedWith: nil)
            await fulfillment(of: [queued], timeout: 2)
            gate.release()
            let movedResult = await moving.result
            let verifiedResult = await verification.result
            await fulfillment(of: [returned], timeout: 2)
            // Removing the presenter is not a queue join. Drain callbacks already admitted before teardown.
            registration.stop()
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                registration.presentedItemOperationQueue.addBarrierBlock { continuation.resume() }
            }
            let observations = events.moveObservations
            // Only finite boolean facts cross the test log; callback URLs remain private.
            let facts = observations.values.map { "rawPathEqual=\($0.rawPathEqual),canonicalMatch=\($0.canonicalMatch)" }
            FileHandle.standardError.write(Data(
                "owned-presenter-move callbacks=[\(facts.joined(separator: ";"))] truncated=\(observations.truncated)\n".utf8
            ))
            try movedResult.get()
            XCTAssertEqual(try verifiedResult.get().path, moved.path)
            XCTAssertEqual(events.values, ["move", "callback-returning", "verify"])
            XCTAssertTrue(observations.matchingCallbackObserved)
            // A later legitimate change may invalidate the proof; the assertion concerns the
            // actual verification queue/object checkpoint, not permanent future authority.
        }
    }

    func testStoppedQueuedVerificationSettlesWithoutRunningValidation() async throws {
        try await fixture { root, archive in
            let application = try app(root, "Stopped")
            let record = try DesktopBackgroundApplicationOrigin.capture(application, archiveRoot: archive, validate: { _ in })
            let registration = DesktopBackgroundOriginRegistration(application: application) { _, _, _ in }
            defer { registration.stop() }
            let hold = holdPresenterQueue(registration)
            await fulfillment(of: [hold.entered], timeout: 2)
            let checking = Task {
                try await registration.verify(
                    record,
                    archiveRoot: archive,
                    validate: { _ in XCTFail("Stopped verification cannot validate") }
                )
            }
            let queued = expectation(
                for: NSPredicate { _, _ in registration.presentedItemOperationQueue.operationCount > 1 },
                evaluatedWith: nil
            )
            await fulfillment(of: [queued], timeout: 2)
            registration.stop()
            hold.gate.release()
            let result = await checking.result
            await fulfillment(of: [hold.returned], timeout: 2)
            if case .success = result { XCTFail("A stopped queued verification cannot publish a proof") }
            XCTAssertFalse(registration.isVerified)
        }
    }

    @MainActor
    func testCancelledQueuedVerificationKeepsMainActorResponsiveAndSettles() async throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("origin-registration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        let root = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(temporary.path))
        let archive = root.appendingPathComponent("archive")
        defer { try? FileManager.default.removeItem(at: root) }
        let application = try app(root, "Cancelled")
        let record = try DesktopBackgroundApplicationOrigin.capture(application, archiveRoot: archive, validate: { _ in })
        let registration = DesktopBackgroundOriginRegistration(application: application) { _, _, _ in }
        defer { registration.stop() }
        let hold = holdPresenterQueue(registration)
        await fulfillment(of: [hold.entered], timeout: 2)
        let checking = Task {
            try await registration.verify(
                record,
                archiveRoot: archive,
                validate: { _ in XCTFail("Cancelled verification cannot validate") }
            )
        }
        let queued = expectation(
            for: NSPredicate { _, _ in registration.presentedItemOperationQueue.operationCount > 1 },
            evaluatedWith: nil
        )
        await fulfillment(of: [queued], timeout: 2)
        checking.cancel()
        // Reaching this actor while its owned queue is held proves there was no synchronous queue wait.
        XCTAssertTrue(Thread.isMainThread)
        hold.gate.release()
        let result = await checking.result
        await fulfillment(of: [hold.returned], timeout: 2)
        if case .failure(let error) = result { XCTAssertTrue(error is CancellationError) }
        else { XCTFail("A canceled queued verification must settle as cancellation") }
        XCTAssertFalse(registration.isVerified)
    }

    private func holdPresenterQueue(_ registration: DesktopBackgroundOriginRegistration)
        -> (gate: PresenterQueueGate, entered: XCTestExpectation, returned: XCTestExpectation) {
        let gate = PresenterQueueGate()
        let entered = expectation(description: "owned presenter queue held")
        let returned = expectation(description: "owned presenter queue released")
        registration.presentedItemOperationQueue.addOperation {
            entered.fulfill()
            XCTAssertTrue(gate.wait(), "The owned queue hold must be released")
            returned.fulfill()
        }
        return (gate, entered, returned)
    }

    private static func moveCoordinated(_ original: URL, to destination: URL) throws {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<Void, Error>?
        coordinator.coordinate(writingItemAt: original, options: .forMoving, error: &coordinationError) { current in
            do {
                coordinator.item(at: current, willMoveTo: destination)
                try FileManager.default.moveItem(at: current, to: destination)
                coordinator.item(at: current, didMoveTo: destination)
                result = .success(())
            } catch { result = .failure(error) }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw DesktopBackgroundApplicationOrigin.Failure.changedObject }
        try result.get()
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
        /// Write fixed lifecycle stages directly so a finite runner retains progress even if XCTest buffers its output.
        func stage(_ name: String) {
            FileHandle.standardError.write(Data("owned-origin-exit \(name)\n".utf8))
        }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        stage("spawning")
        try child.run()
        defer { if child.isRunning { stage("cleanup-terminating")
            child.terminate()
            stage("cleanup-joining")
            child.waitUntilExit()
            stage("cleanup-joined")
        } }
        stage("spawned")
        let identity = try DesktopBackgroundProcessIdentity.read(child.processIdentifier)
        let client = DesktopBackgroundOriginStatus.Client(
            pid: identity.pid,
            birth: .init(seconds: String(identity.startedSeconds), microseconds: String(identity.startedMicroseconds))
        )
        XCTAssertFalse(client.isGone())
        stage("terminating")
        child.terminate()
        stage("joining")
        child.waitUntilExit()
        stage("joined")
        XCTAssertTrue(client.isGone())
    }
}

private final class PresenterQueueGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var released = false
    func wait() -> Bool {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(5)
        while !released {
            if !condition.wait(until: deadline) { return false }
        }
        return Date() < deadline
    }

    func release() {
        condition.lock()
        released = true
        condition.broadcast()
        condition.unlock()
    }
}

private final class PresenterQueueEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    struct MoveObservation {
        let rawPathEqual: Bool
        let canonicalMatch: Bool
    }

    private var callbacks: [MoveObservation] = []
    private var callbacksTruncated = false
    private var claimedMatchingCallback = false
    /// Record every bounded observation, but hold and fulfill only the first matching callback.
    func observeMove(rawPathEqual: Bool, canonicalMatch: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if callbacks.count < 4 {
            callbacks.append(.init(rawPathEqual: rawPathEqual, canonicalMatch: canonicalMatch))
        } else {
            callbacksTruncated = true
        }
        guard canonicalMatch, !claimedMatchingCallback else { return false }
        claimedMatchingCallback = true
        return true
    }

    var moveObservations: (values: [MoveObservation], truncated: Bool, matchingCallbackObserved: Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (callbacks, callbacksTruncated, claimedMatchingCallback)
    }

    func append(_ value: String) {
        lock.lock()
        recorded.append(value)
        lock.unlock()
    }

    var values: [String] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }
}
