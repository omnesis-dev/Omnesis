// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation
@testable import Omnesis
import XCTest

@MainActor
final class GatewaySocketLivenessTests: XCTestCase {
    func testOnlyTheLiveUncancelledConnectionMayAcceptAReceiveCompletion() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let pin = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: "localhost")
        let session = pin.session
        defer { session.invalidateAndCancel() }
        let socket = try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "https://localhost:\(peer.info.targetPort)")),
            token: "device-test-token",
            session: session,
            expectedDeviceId: "00000000-0000-4000-8000-000000000901"
        )
        do {
            await socket.start()
            try await connected(socket)
            let first = await socket.frameGeneration
            try await socket.requireCurrentFrame(generation: first)
            let cancelled = Task { try await socket.requireCurrentFrame(generation: first) }
            cancelled.cancel() // this MainActor task cannot dispatch before cancellation
            do { try await cancelled.value
                XCTFail("Cancelled receive completion was accepted")
            } catch { XCTAssertTrue(error is CancellationError) }
            await socket.recoverAfterInterruption()
            try await connected(socket)
            let replacement = await socket.frameGeneration
            XCTAssertNotEqual(replacement, first)
            do { try await socket.requireCurrentFrame(generation: first)
                XCTFail("Retired connection completion was accepted")
            } catch { XCTAssertTrue(error is CancellationError) }
            try await socket.requireCurrentFrame(generation: replacement)
            await socket.stop()
            do { try await socket.requireCurrentFrame(generation: replacement)
                XCTFail("Stopped socket accepted a completion")
            } catch { XCTAssertTrue(error is CancellationError) }
        } catch {
            await socket.stop()
            throw error
        }
    }

    func testLateHelloDeadlinesPongsAndSDKFailuresCannotRetireANewerOrStoppedConnection() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let pin = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: "localhost")
        let session = pin.session
        defer { session.invalidateAndCancel() }
        let clock = LivenessDeadlineClock()
        let pongs = LivenessPongRecorder()
        let hello = Duration.seconds(11)
        let interval = Duration.seconds(12)
        let timeout = Duration.seconds(13)
        var policy = DeviceSocket.Liveness(helloTimeout: hello, pingInterval: interval, pongTimeout: timeout)
        policy.wait = { try await clock.wait($0) }
        policy.ping = { pongs.record($0, $1) }
        let socket = try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "https://localhost:\(peer.info.targetPort)")),
            token: "device-test-token",
            session: session,
            expectedDeviceId: "00000000-0000-4000-8000-000000000901",
            liveness: policy
        )
        do {
            await socket.start()
            try await connected(socket)
            // A deadline already queued before cancellation may still finish after hello.
            try await clock.release(clock.ticket(hello, occurrence: 0))
            try await Task.sleep(for: .milliseconds(100))
            let healthy = await socket.state()
            XCTAssertEqual(healthy, .connected(
                deviceId: "00000000-0000-4000-8000-000000000901",
                deviceName: "Synthetic production pairing",
                scopes: ["read", "admin"]
            ))
            try await clock.release(clock.ticket(interval, occurrence: 0))
            try await clock.release(clock.ticket(timeout, occurrence: 0)) // first ping times out
            try await connections(2, peer: peer)
            try await connected(socket)
            pongs.complete(0, error: nil) // the old task's single late pong cannot affect this task
            try await clock.release(clock.ticket(interval, occurrence: 1))
            let failedPongDeadline = try await clock.ticket(timeout, occurrence: 1)
            pongs.complete(1, error: URLError(.networkConnectionLost))
            try await connections(3, peer: peer)
            try await connected(socket)
            await clock.release(failedPongDeadline) // canceled deadline finishes after reconnection
            let staleInterval = try await clock.ticket(interval, occurrence: 2)
            await socket.recoverAfterInterruption()
            await clock.release(staleInterval)
            try await connections(4, peer: peer)
            try await connected(socket)
            try await clock.release(clock.ticket(interval, occurrence: 3))
            _ = try await clock.ticket(timeout, occurrence: 2)
            await socket.stop()
            try await clock.release(clock.ticket(hello, occurrence: 3))
            pongs.complete(2, error: URLError(.cancelled)) // SDK completion after terminal stop
            await clock.finish()
            try await Task.sleep(for: .milliseconds(1100))
            let stopped = await socket.state()
            XCTAssertEqual(stopped, .disconnected)
            XCTAssertEqual(try count(peer), 4)
        } catch {
            await socket.stop()
            await clock.finish()
            throw error
        }
    }

    private func connected(_ socket: DeviceSocket) async throws {
        let connected = await socket.waitUntilConnected(timeout: .seconds(5))
        XCTAssertTrue(connected)
        if !connected { throw URLError(.timedOut) }
    }

    private func count(_ peer: CloudPairingSOCKSPeer) throws -> Int {
        let bytes = try Data(contentsOf: URL(fileURLWithPath: peer.info.statsPath))
        let stats = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Int])
        return try XCTUnwrap(stats["controlConnections"])
    }

    private func connections(_ expected: Int, peer: CloudPairingSOCKSPeer) async throws {
        let deadline = ContinuousClock().now + .seconds(5)
        while ContinuousClock().now < deadline {
            if try count(peer) == expected { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Control socket did not reconnect with the existing device credential")
        throw URLError(.timedOut)
    }
}

/// A timer can finish concurrently with cancellation. Tests release that legitimate
/// completion explicitly rather than depending on OS scheduling at the deadline.
private actor LivenessDeadlineClock {
    private var durations: [Duration] = []
    private var continuations: [CheckedContinuation<Void, Error>?] = []

    func wait(_ duration: Duration) async throws {
        try await withCheckedThrowingContinuation { continuation in
            durations.append(duration)
            continuations.append(continuation)
        }
    }

    func ticket(_ duration: Duration, occurrence: Int) async throws -> Int {
        let deadline = ContinuousClock().now + .seconds(5)
        while ContinuousClock().now < deadline {
            let matches = durations.indices.filter { durations[$0] == duration }
            if matches.count > occurrence { return matches[occurrence] }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw URLError(.timedOut)
    }

    func release(_ index: Int) {
        let continuation = continuations[index]
        continuations[index] = nil
        continuation?.resume()
    }

    func finish() {
        for index in continuations.indices {
            let continuation = continuations[index]
            continuations[index] = nil
            continuation?.resume(throwing: CancellationError())
        }
    }
}

private final class LivenessPongRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var callbacks: [@Sendable (Error?) -> Void] = []

    func record(_: URLSessionWebSocketTask, _ callback: @escaping @Sendable (Error?) -> Void) {
        lock.lock()
        callbacks.append(callback)
        lock.unlock()
    }

    func complete(_ index: Int, error: Error?) {
        lock.lock()
        let callback = callbacks[index]
        lock.unlock()
        callback(error)
    }
}
#endif
