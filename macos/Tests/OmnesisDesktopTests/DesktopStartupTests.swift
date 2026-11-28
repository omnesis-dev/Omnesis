// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import DesktopCore
@testable import OmnesisDesktop
import XCTest

@MainActor
final class DesktopStartupTests: XCTestCase {
    private static var retainedUncertainBridges: [RuntimeBridge] = []

    func testStdoutEOFOfALiveOwnedHelperFailsTheConnectionAndDrainsItsInput() async throws {
        try await withRuntime(closeOutput: true) { fixture, bridge, count in
            var failures = 0
            bridge.onFailure = { _ in failures += 1 }
            try await bridge.start()
            try await waitUntil { failures == 1 }
            try await fixture.waitFor("eof")
            XCTAssertThrowsError(try bridge.send("status"))
            await assertStartRefused(bridge)
            XCTAssertEqual(count.value, 1)
            fixture.release()
            try await bridge.disconnectAndJoin()
            XCTAssertEqual(failures, 1)
        }
    }

    func testClosedInputOfALiveOwnedHelperFailsOnceAndRetainsItsDrain() async throws {
        var protectedWriter = false, closes = 0
        try await withRuntime(closeInput: true, inputClosure: { handle in
            protectedWriter = fcntl(handle.fileDescriptor, F_GETNOSIGPIPE) == 1
            closes += 1
            try handle.close()
        }) { fixture, bridge, count in
            var failures = 0, replies = 0
            var reportedMessage: String?
            bridge.onFailure = { message in
                failures += 1
                reportedMessage = message
            }
            bridge.onEnvelope = { _ in replies += 1 }
            try await bridge.start()
            try await fixture.waitFor("stdin-closed")
            var requestID: String?
            do {
                requestID = try bridge.send("status")
                XCTFail("A pipe without its child reader cannot accept a command")
            } catch let failure as BridgeWriteError {
                XCTAssertEqual(
                    failure.localizedDescription,
                    "Omnesis could not write to its background service. Check the connection status before trying again."
                )
                XCTAssertEqual(failure.localizedDescription, reportedMessage)
                var cause: NSError? = failure.underlying as NSError
                var brokenPipe = false
                for _ in 0 ..< 3 {
                    guard let current = cause else { break }
                    if current.domain == NSPOSIXErrorDomain, current.code == Int(EPIPE) { brokenPipe = true }
                    cause = current.userInfo[NSUnderlyingErrorKey] as? NSError
                }
                XCTAssertTrue(brokenPipe, "The actual write must fail with a bounded broken-pipe cause")
            }
            XCTAssertNil(requestID)
            XCTAssertTrue(protectedWriter, "The exact still-open writer must suppress SIGPIPE before closing")
            XCTAssertEqual(closes, 1)
            XCTAssertEqual(failures, 1)
            XCTAssertEqual(replies, 0)
            XCTAssertEqual(fixture.requestCount, 0)
            XCTAssertThrowsError(try bridge.send("status"))
            await assertStartRefused(bridge)
            XCTAssertEqual(count.value, 1)
            fixture.release()
            try await bridge.disconnectAndJoin()
            XCTAssertEqual(failures, 1, "EOF and termination cannot report the retired session again")
            try await bridge.start()
            XCTAssertEqual(count.value, 2, "A new attempt must prepare again after exact physical retirement")
        }
    }

    func testMalformedOutputRevokesPublicationButStillDrainsOwnedShutdownOutput() async throws {
        try await withRuntime(invalidOutput: true) { fixture, bridge, count in
            var failures = 0, replies = 0
            bridge.onFailure = { _ in failures += 1 }
            bridge.onEnvelope = { _ in replies += 1 }
            stage(.malformedStarting)
            try await bridge.start()
            stage(.malformedWaitingForFailure)
            try await waitUntil { failures == 1 }
            stage(.malformedFailureObserved)
            try await fixture.waitFor("drained-output")
            stage(.malformedOutputDrained)
            await assertStartRefused(bridge)
            XCTAssertEqual(count.value, 1)
            XCTAssertEqual(replies, 0)
            fixture.release()
            try await bridge.disconnectAndJoin()
            XCTAssertEqual(failures, 1)
        }
    }

    func testRevokedShutdownOutputDrainsWhileTheMainActorIsHeld() async throws {
        try await withRuntime(invalidOutput: true, holdDrainOutput: true) { fixture, bridge, count in
            var failures = 0, replies = 0
            bridge.onFailure = { _ in failures += 1 }
            bridge.onEnvelope = { _ in replies += 1 }
            try await bridge.start()
            try await waitUntil { failures == 1 }
            try await fixture.waitFor("eof")
            await assertStartRefused(bridge)
            let observation = try fixture.drainObservation()
            let observing = Task.detached { await observation.observe() }
            // The observer opens the real child's burst gate only after this actor is held.
            // Its completion never needs MainActor; join it before any fixture resource closes.
            let progressedWhileHeld = observation.holdMainActor()
            let observed = await observing.value
            XCTAssertTrue(progressedWhileHeld, "Revoked stdout must drain independently of MainActor")
            XCTAssertTrue(observed, "The exact owned child must publish its drained-output marker")
            XCTAssertEqual(count.value, 1)
            XCTAssertEqual(replies, 0)
            fixture.release()
            try await bridge.disconnectAndJoin()
            XCTAssertEqual(failures, 1)
        }
    }

    func testCancelledDrainWaiterCannotReleaseTheExactOwner() async throws {
        try await withRuntime { fixture, bridge, count in
            try await bridge.start()
            bridge.disconnect()
            let first = Task { try await bridge.disconnectAndJoin() }
            let second = Task { try await bridge.disconnectAndJoin() }
            var bodyError: Error?
            do {
                first.cancel()
                try await fixture.waitFor("eof")
                await assertStartRefused(bridge)
                XCTAssertEqual(count.value, 1)
                fixture.release()
                do { try await first.value
                    XCTFail("A cancelled waiter must not report successful cleanup")
                } catch is CancellationError {} catch { XCTFail("Unexpected drain outcome") }
                try await second.value
                try await bridge.start()
                XCTAssertEqual(count.value, 2)
            } catch { bodyError = error }
            fixture.release()
            _ = await first.result
            _ = await second.result
            if let bodyError { throw bodyError }
        }
    }

    func testTerminatedChildDoesNotRetireBeforeItsReaderReturns() async throws {
        let reading = StartupGate()
        try await withRuntime(beforeReading: reading, exitBeforeEOF: true) { fixture, bridge, count in
            var failures = 0, replies = 0
            bridge.onFailure = { _ in failures += 1 }
            bridge.onEnvelope = { _ in replies += 1 }
            try await bridge.start()
            try await waitUntil { reading.entered }
            fixture.release()
            try await waitUntil { failures == 1 }
            await assertStartRefused(bridge)
            XCTAssertEqual(count.value, 1)
            XCTAssertEqual(bridge.lastTermination?.status, 0, "The exact child has terminated while its reader is still held")
            reading.release()
            try await bridge.disconnectAndJoin()
            XCTAssertEqual(replies, 0, "Retired buffered envelopes cannot publish")
            XCTAssertEqual(failures, 1, "The exact termination callback reports failure once while the reader is held")
            try await bridge.start()
            XCTAssertEqual(count.value, 2)
        }
    }

    func testNonzeroExitRetiresOnlyAfterPhysicalJoinAndFreshRetryPreparesAgain() async throws {
        try await withRuntime(exitCode: 7) { fixture, bridge, count in
            try await bridge.start()
            bridge.disconnect()
            try await fixture.waitFor("eof")
            await assertStartRefused(bridge)
            fixture.release()
            try await bridge.disconnectAndJoin()
            XCTAssertEqual(bridge.lastTermination?.status, 7)
            XCTAssertEqual(bridge.lastTermination?.clean, false, "Physical retirement is not graceful portable cleanup")
            try await bridge.start()
            XCTAssertEqual(count.value, 2, "A retry must prepare a new attempt rather than reuse the retired channel")
        }
    }

    func testStoreCancellationKeepsBusyAndRejectsRetryUntilTheWholeLaunchReturns() async throws {
        let preparation = StartupGate()
        let bridge = RuntimeBridge(preparation: { _ in
            await preparation.wait()
            throw CancellationError()
        })
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge)
        var cancelling: Task<Void, Never>?
        var bodyError: Error?
        do {
            store.start()
            try await waitUntil { preparation.entered }
            cancelling = Task { await store.cancelStartup() }
            try await waitUntil { store.cancellingStartup }
            XCTAssertTrue(store.busy)
            XCTAssertFalse(store.startupCancelled)
            store.start()
            XCTAssertEqual(preparation.entries, 1)
            await assertStartRefused(bridge)
            store.command("status")
        } catch { bodyError = error }
        preparation.release()
        await cancelling?.value
        await store.cancelStartup()
        try await bridge.disconnectAndJoin()
        if let bodyError { throw bodyError }
        XCTAssertTrue(store.startupCancelled)
        XCTAssertFalse(store.busy)
        XCTAssertFalse(store.state.canOpenLibrary)
    }

    func testStoreShutdownJoinsItsControlChannelAndPreventsNewCommands() async throws {
        try await withRuntime { fixture, bridge, count in
            let store = DesktopStore(startRuntime: false, runtimeBridge: bridge)
            store.start()
            try await waitUntil { !store.launchingRuntime }
            let shuttingDown = Task { try await store.shutdownRuntime() }
            var bodyError: Error?
            do {
                try await fixture.waitFor("eof")
                XCTAssertTrue(store.shuttingDownRuntime)
                XCTAssertTrue(store.busy)
                store.start()
                store.command("status")
                XCTAssertEqual(count.value, 1)
                let frames = try String(contentsOf: fixture.script.appendingPathExtension("requests"), encoding: .utf8)
                XCTAssertEqual(frames.split(separator: "\n").count, 1, "Only the original startup status reached the child")
                fixture.release()
                try await shuttingDown.value
                XCTAssertTrue(store.shuttingDownRuntime, "Shutdown never re-enables a start while termination is pending")
            } catch { bodyError = error }
            fixture.release()
            _ = await shuttingDown.result
            if let bodyError { throw bodyError }
        }
    }

    func testFailedShutdownCompletesRPCsWithoutLeavingBusyOrRevokingVerifiedHTTP() async throws {
        let closes = StartupCount()
        try await withRuntime(inputClosure: { handle in
            closes.increment()
            try handle.close()
            throw StartupFixture.Failure.control
        }, expectCloseUncertainty: true) { fixture, bridge, count in
            let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, nativeOwnerVerified: true, monitorPrerequisites: false)
            store.start()
            try await waitUntil { !store.launchingRuntime }
            let connection = try JSONDecoder().decode(DesktopConnection.self, from: Data(
                #"{"url":"https://library.example.test","token":"fictional-token"}"#.utf8
            ))
            store.state = DesktopState(
                phase: .ready,
                mode: "joined",
                connection: connection,
                encrypted: true,
                installationId: "desktop-0000000000000001"
            )
            let api = try DesktopAPI(connection: connection)
            store.api = api
            let scope = store.apiContext
            let rpc = Task { try await store.request("updateStatus") }
            var shutdown: Task<Void, Error>?
            var bodyError: Error?
            do {
                try await waitUntil { fixture.requestCount == 2 }
                XCTAssertTrue(store.busy)
                shutdown = Task { try await store.shutdownRuntime() }
                try await fixture.waitFor("eof")
                do { _ = try await rpc.value
                    XCTFail("Closing the controller must fail its pending request")
                } catch let error as DesktopBridgeReplyWaiter.Failure {
                    XCTAssertEqual(error.message, "Omnesis is closing its background connection.")
                }
                fixture.release()
                do { try await shutdown?.value
                    XCTFail("The uncertain close receipt must refuse shutdown")
                } catch BridgeLaunchError.cleanupUnconfirmed {}
                let blocked = try XCTUnwrap(store.runtimeCleanupFailure)
                XCTAssertFalse(store.shuttingDownRuntime)
                XCTAssertFalse(store.busy, "A completed blocked error is not an in-flight operation")
                XCTAssertEqual(store.failure, blocked)
                XCTAssertFalse(store.nativeOwnerReady)
                XCTAssertTrue(store.api === api)
                XCTAssertTrue(store.apiContext === scope)
                XCTAssertTrue(scope?.isCurrent == true)
                XCTAssertTrue(store.state.canOpenLibrary, "Already verified HTTP scopes remain independently available")
                store.start()
                store.command("status")
                XCTAssertEqual(count.value, 1)
                XCTAssertEqual(closes.value, 1)
                XCTAssertEqual(store.failure, blocked)
                do { _ = try await store.request("updateStatus")
                    XCTFail("A blocked controller cannot accept new requests")
                } catch let error as DesktopBridgeReplyWaiter.Failure { XCTAssertEqual(error.message, blocked) }
            } catch { bodyError = error }
            fixture.release()
            if let shutdown { _ = await shutdown.result }
            else { try? await store.shutdownRuntime() }
            _ = await rpc.result
            if let bodyError { throw bodyError }
        }
    }

    func testRefusedControlShutdownLeavesPrerequisiteMonitoringResponsive() async throws {
        try await withRuntime(inputClosure: { handle in
            try handle.close()
            throw StartupFixture.Failure.control
        }, expectCloseUncertainty: true) { fixture, bridge, _ in
            var checks = 0
            let notifications = NotificationCenter()
            let startup = DesktopAutomaticStartup(read: { checks += 1
                return .enabled
            }, register: {})
            let store = DesktopStore(
                startRuntime: false,
                runtimeBridge: bridge,
                automaticStartup: startup,
                monitorPrerequisites: true,
                monitoringIntervals: .init(collection: .seconds(3600), system: .seconds(3600)),
                monitoringNotifications: notifications
            )
            var bodyError: Error?
            var shutdown: Task<Void, Error>?
            do {
                store.start()
                try await waitUntil { !store.launchingRuntime && checks > 0 }
                shutdown = Task { try await store.shutdownRuntime() }
                try await fixture.waitFor("eof")
                fixture.release()
                do { try await shutdown?.value
                    XCTFail("The close receipt remains uncertain")
                } catch BridgeLaunchError.cleanupUnconfirmed {}
                XCTAssertEqual(store.state.phase, .error)
                XCTAssertFalse(store.busy)
                let previous = checks
                notifications.post(name: NSApplication.didBecomeActiveNotification, object: nil)
                try await waitUntil { checks > previous }
            } catch { bodyError = error }
            fixture.release()
            _ = await shutdown?.result
            await store.stopPrerequisiteMonitoring()
            if let bodyError { throw bodyError }
        }
    }

    func testStartupWaitRejectsAPredicateThatBecomesTrueAfterItsOriginalDeadline() async {
        var now = ContinuousClock.now
        var ready = false
        do {
            try await waitUntil {
                ready
            } now: {
                now
            } pause: { now += .seconds(6)
                ready = true
            }
            XCTFail("Late readiness cannot turn an expired barrier green")
        } catch StartupFixture.Failure.barrier {} catch { XCTFail("Unexpected barrier failure") }
    }

    func testFailedLaunchDoesNotWaitForANonexistentTerminationReceipt() async throws {
        try await withRuntime { fixture, bridge, _ in
            try Data([0, 1, 2]).write(to: fixture.runtime.appendingPathComponent("runtime-exec"))
            do { try await bridge.start()
                XCTFail("Invalid executable must fail")
            } catch {}
            try await bridge.disconnectAndJoin()
        }
    }

    func testPendingPreparationIsVisibleCannotOpenLibraryAndCanBeCancelled() async {
        let bridge = RuntimeBridge(preparation: { _ in
            try await Task.sleep(for: .seconds(30))
            throw CancellationError()
        })
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge)
        store.start()
        XCTAssertTrue(store.launchingRuntime)
        XCTAssertTrue(store.busy)
        XCTAssertFalse(store.state.canOpenLibrary)
        await Task.yield()
        let clock = ContinuousClock()
        let start = clock.now
        await store.cancelStartup()
        XCTAssertLessThan(start.duration(to: clock.now), .seconds(5))
        XCTAssertFalse(store.launchingRuntime)
        XCTAssertFalse(store.busy)
        XCTAssertTrue(store.startupCancelled)
        XCTAssertFalse(store.state.canOpenLibrary)
    }

    func testLostBridgeNeverLeavesPresentationConnected() throws {
        let bridge = RuntimeBridge()
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge)
        store.state = try JSONDecoder().decode(
            DesktopState.self,
            from: Data(
                #"{"phase":"ready","mode":"joined","encrypted":true,"connection":{"url":"https://localhost:17601","token":"fixture-token"}}"#
                    .utf8
            )
        )
        XCTAssertTrue(store.state.canOpenLibrary)
        bridge.onFailure?("Fictional connection closed")
        XCTAssertFalse(store.state.canOpenLibrary)
        XCTAssertNil(store.api)
        XCTAssertEqual(store.state.phase, .waiting)
    }

    private enum Stage: String {
        case malformedStarting = "malformed-starting"
        case malformedWaitingForFailure = "malformed-waiting-for-failure"
        case malformedFailureObserved = "malformed-failure-observed"
        case malformedOutputDrained = "malformed-output-drained"
    }

    private func stage(_ stage: Stage) {
        FileHandle.standardError.write(Data("owned-startup-fixture \(stage.rawValue)\n".utf8))
    }

    private func assertStartRefused(_ bridge: RuntimeBridge, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await bridge.start()
            XCTFail("A retained drain must refuse a replacement", file: file, line: line)
        } catch BridgeLaunchError.draining {} catch { XCTFail("Unexpected replacement outcome", file: file, line: line) }
    }

    private func waitUntil(
        _ condition: () -> Bool,
        now: () -> ContinuousClock.Instant = { .now },
        pause: @MainActor () async throws -> Void = { try await Task.sleep(for: .milliseconds(10)) }
    ) async throws {
        let deadline = now() + .seconds(5)
        while !condition(), now() < deadline {
            try await pause()
        }
        guard condition(), now() < deadline else { throw StartupFixture.Failure.barrier }
    }

    private func withRuntime(
        closeOutput: Bool = false, closeInput: Bool = false, exitCode: Int = 0, beforeReading: StartupGate? = nil,
        exitBeforeEOF: Bool = false, invalidOutput: Bool = false, holdDrainOutput: Bool = false,
        inputClosure: @escaping RuntimeBridge.InputClosure = { try $0.close() },
        expectCloseUncertainty: Bool = false,
        body: @MainActor (StartupFixture, RuntimeBridge, StartupCount) async throws -> Void
    ) async throws {
        let fixture = try StartupFixture(
            closeOutput: closeOutput,
            closeInput: closeInput,
            exitCode: exitCode,
            exitBeforeEOF: exitBeforeEOF,
            invalidOutput: invalidOutput,
            holdDrainOutput: holdDrainOutput
        )
        let count = StartupCount()
        let runtime = fixture.runtime
        let bridge = RuntimeBridge(preparation: { _ in
            count.increment()
            return try (runtime, DesktopRuntimeUsageLease.acquire(runtime: runtime))
        }, beforeReading: beforeReading.map { gate in { await gate.wait() } }, inputClosure: inputClosure)
        var bodyError: Error?
        do { try await body(fixture, bridge, count) } catch { bodyError = error }
        beforeReading?.release()
        fixture.release()
        do {
            try await bridge.disconnectAndJoin()
            try fixture.removeAfterJoined()
            if expectCloseUncertainty { XCTFail("The uncertain close receipt must remain retained") }
        } catch BridgeLaunchError.cleanupUnconfirmed where expectCloseUncertainty {
            Self.retainedUncertainBridges.append(bridge)
            fixture.closeControl() // Retain files and the failed bridge owner; this is not a clean receipt.
        } catch {
            // Unconfirmed physical closure keeps the fixture evidence, never deletes it.
            fixture.closeControl()
            if let bodyError { throw StartupFixture.CleanupFailure(original: bodyError, cleanup: error) }
            throw error
        }
        if let bodyError { throw bodyError }
    }
}

private final class StartupCount: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() {
        lock.withLock { count += 1 }
    }

    var value: Int {
        lock.withLock { count }
    }
}

@MainActor
private final class StartupGate {
    private var open = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private(set) var entries = 0
    var entered: Bool {
        entries > 0
    }

    func wait() async {
        entries += 1
        if open { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        open = true
        let pending = waiters
        waiters.removeAll()
        for waiter in pending {
            waiter.resume()
        }
    }
}

@MainActor
private final class StartupFixture {
    enum Failure: Error { case barrier, control }
    struct CleanupFailure: Error {
        let original: Error
        let cleanup: Error
    }

    let base: URL
    let runtime: URL
    let script: URL
    private var control: FileHandle?

    init(closeOutput: Bool, closeInput: Bool, exitCode: Int, exitBeforeEOF: Bool, invalidOutput: Bool, holdDrainOutput: Bool) throws {
        let selected = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-bridge-drain-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: selected, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        base = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(selected.path), isDirectory: true)
        let manifest = Data(
            #"{"format":1,"codeUsageProtocol":1,"processAuthorityProtocol":3,"runtimeLauncher":"runtime-exec","inventory":[{"path":"node","executable":true},{"path":"runtime-exec","executable":true}]}"#
                .utf8
        )
        let epoch = SHA256.hash(data: manifest).map { String(format: "%02x", $0) }.joined()
        runtime = base.appendingPathComponent(epoch)
        script = runtime.appendingPathComponent("packages/cli/dist/index.js")
        try FileManager.default.createDirectory(at: script.deletingLastPathComponent(), withIntermediateDirectories: true)
        try manifest.write(to: runtime.appendingPathComponent("desktop-runtime.json"))
        try Data("inert fixture entry".utf8).write(to: script)
        let fifo = script.appendingPathExtension("control")
        guard mkfifo(fifo.path, 0o600) == 0 else { throw Failure.control }
        let fd = open(fifo.path, O_RDWR | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.control }
        control = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        let close = closeOutput ? "exec 1>&-" : ":"
        let input = closeInput ? "exec 0<&-; : > \"$2.stdin-closed\"" : exitBeforeEOF ? ":" : "while IFS= read -r frame; do printf '%s\\n' \"$frame\" >> \"$2.requests\"; done"
        let lateReply = exitBeforeEOF ? "printf '%s\\n' '{\"version\":1,\"id\":\"fictional-retired-reply\",\"ok\":true,\"result\":null}'" :
            ":"
        let invalid = invalidOutput ? "printf '%s\\n' 'invalid-fictional-frame'" : ":"
        let drainOutput = invalidOutput ?
            "i=0; while [ \"$i\" -lt 4096 ]; do printf '%s\\n' 'Fictional shutdown output remains unpublished while the exact control channel drains.'; i=$((i+1)); done; : > \"$2.drained-output\"" :
            ":"
        let drainGate = holdDrainOutput ? "IFS= read -r begin < \"$2.control\"; [ \"$begin\" = drain ] || exit 1\n" : ""
        let helper = """
        #!/bin/sh
        : > "$2.started"
        \(close)
        \(invalid)
        \(input)
        : > "$2.eof"
        \(drainGate)\(drainOutput)
        IFS= read -r release < "$2.control"
        \(lateReply)
        : > "$2.exiting"
        exit \(exitCode)
        """
        let executable = runtime.appendingPathComponent("runtime-exec")
        try Data(helper.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    }

    func waitFor(_ stage: String) async throws {
        let marker = script.appendingPathExtension(stage)
        let deadline = ContinuousClock.now + .seconds(5)
        while !FileManager.default.fileExists(atPath: marker.path), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard FileManager.default.fileExists(atPath: marker.path), ContinuousClock.now < deadline else { throw Failure.barrier }
    }

    var requestCount: Int {
        (try? String(contentsOf: script.appendingPathExtension("requests"), encoding: .utf8).split(separator: "\n").count) ?? 0
    }

    func drainObservation() throws -> StartupDrainObservation {
        guard let control else { throw Failure.control }
        return StartupDrainObservation(control: control, marker: script.appendingPathExtension("drained-output"))
    }

    func release() {
        try? control?.write(contentsOf: Data("release\n".utf8))
    }

    func closeControl() {
        try? control?.close()
        control = nil
    }

    func removeAfterJoined() throws {
        closeControl()
        try FileManager.default.removeItem(at: base)
    }
}

/// The test's bounded hold observes a real pipe writer while MainActor cannot service reader work.
private final class StartupDrainObservation: @unchecked Sendable {
    private let condition = NSCondition()
    private let control: FileHandle
    private let marker: URL
    private var actorHeld = false
    private var finished = false
    private var observed = false

    init(control: FileHandle, marker: URL) {
        self.control = control
        self.marker = marker
    }

    @MainActor
    func holdMainActor() -> Bool {
        XCTAssertTrue(Thread.isMainThread)
        condition.lock()
        defer { condition.unlock() }
        actorHeld = true
        condition.broadcast()
        let deadline = Date().addingTimeInterval(5)
        while !finished {
            if !condition.wait(until: deadline) { return false }
        }
        return observed && Date() < deadline
    }

    private func waitForActorHold() -> Bool {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(5)
        while !actorHeld {
            if !condition.wait(until: deadline) { return false }
        }
        return Date() < deadline
    }

    private func finish(_ value: Bool) {
        condition.lock()
        observed = value
        finished = true
        condition.broadcast()
        condition.unlock()
    }

    func observe() async -> Bool {
        var observed = false
        defer { finish(observed) }
        guard waitForActorHold() else { return false }
        do { try control.write(contentsOf: Data("drain\n".utf8)) }
        catch { return false }
        let deadline = ContinuousClock.now + .seconds(5)
        while !FileManager.default.fileExists(atPath: marker.path), ContinuousClock.now < deadline {
            do { try await Task.sleep(for: .milliseconds(10)) }
            catch { return false }
        }
        observed = FileManager.default.fileExists(atPath: marker.path) && ContinuousClock.now < deadline
        return observed
    }
}
