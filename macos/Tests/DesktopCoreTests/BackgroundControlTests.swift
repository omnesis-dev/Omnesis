// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class BackgroundControlTests: XCTestCase {
    private func binding() -> DesktopBackgroundLaunchProtocol.Binding {
        let identity = SHA256.hash(data: Data(UUID().uuidString.utf8)).map { String(format: "%02x", $0) }.joined()
        return .init(configDirHash: identity, instance: "desktop-" + identity.prefix(16), secretService: "dev.omnesis.desktop." + identity)
    }

    private static func peer() throws -> DesktopBackgroundPeerTrust.Peer {
        try .init(
            pid: getpid(),
            executable: URL(fileURLWithPath: "/example/runtime-exec"),
            kind: .client,
            identity: DesktopBackgroundProcessIdentity.read(getpid())
        )
    }

    private func cleanup(_ binding: DesktopBackgroundLaunchProtocol.Binding) throws {
        let directory = try DesktopBackgroundSocket.path(binding).deletingLastPathComponent()
        // Only this invented UUID-derived endpoint, after the exact server has joined its socket work.
        try? FileManager.default.removeItem(at: directory.appendingPathComponent("owner.lock"))
        try? FileManager.default.removeItem(at: directory)
    }

    func testActualPrivateSocketRoundTripAndExclusiveOwner() async throws {
        let selected = binding()
        let epoch = String(repeating: "a", count: 64)
        var server: DesktopBackgroundControlServer? = try .init(
            binding: selected,
            verify: { _, _ in try Self.peer() },
            handler: { request, _ in
                .init(request: request, epoch: epoch, state: .helperIdle)
            }
        )
        defer { server?.stop()
            server = nil
            try? cleanup(selected)
        }
        XCTAssertThrowsError(try DesktopBackgroundControlServer(
            binding: selected,
            verify: { _, _ in try Self.peer() },
            handler: { request, _ in
                .init(request: request, epoch: epoch, state: .helperIdle)
            }
        ))
        let request = DesktopBackgroundLaunchProtocol.Request(action: .hello, binding: selected, expectedEpoch: epoch)
        let reply = try await Task.detached {
            try DesktopBackgroundControlClient.exchange(request, timeout: .seconds(2), verify: { _ in })
        }.value
        XCTAssertEqual(reply.state, .helperIdle)
        let endpoint = try DesktopBackgroundSocket.path(selected)
        var status = stat()
        XCTAssertEqual(lstat(endpoint.path, &status), 0)
        XCTAssertEqual(status.st_mode & 0o777, 0o600)
        server?.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: endpoint.path))
    }

    func testGenerationMismatchCanBeObservedOnlyThroughHelloOnStableEndpoint() async throws {
        let selected = binding()
        let old = DesktopBackgroundLaunchProtocol.Binding(
            configDirHash: selected.configDirHash, instance: "desktop-" + String(repeating: "b", count: 16),
            secretService: "dev.omnesis.desktop." + String(repeating: "b", count: 64)
        )
        let epoch = String(repeating: "a", count: 64)
        let server = try DesktopBackgroundControlServer(binding: old, verify: { _, _ in try Self.peer() }, handler: { request, _ in
            .init(request: request, binding: old, epoch: epoch, state: .scopeMismatch)
        })
        defer { server.stop()
            try? cleanup(selected)
        }
        XCTAssertEqual(try DesktopBackgroundSocket.path(selected), try DesktopBackgroundSocket.path(old))
        let request = DesktopBackgroundLaunchProtocol.Request(action: .hello, binding: selected, expectedEpoch: epoch)
        let reply = try await Task.detached {
            try DesktopBackgroundControlClient.exchange(request, timeout: .seconds(2), verify: { _ in })
        }.value
        XCTAssertEqual(reply.binding, old)
        XCTAssertEqual(reply.state, .scopeMismatch)
    }

    func testFailedPeerVerificationNeverDispatchesRequest() async throws {
        let selected = binding()
        let epoch = String(repeating: "a", count: 64)
        let server = try DesktopBackgroundControlServer(binding: selected, verify: { _, _ in
            throw DesktopBackgroundPeerTrust.Failure.untrustedPeer
        }, handler: { request, _ in
            XCTFail("Untrusted peers cannot dispatch even fixed launch metadata")
            return .init(request: request, epoch: epoch, state: .helperIdle)
        })
        defer { server.stop()
            try? cleanup(selected)
        }
        let request = DesktopBackgroundLaunchProtocol.Request(action: .hello, binding: selected, expectedEpoch: epoch)
        do {
            _ = try await Task.detached {
                try DesktopBackgroundControlClient.exchange(request, timeout: .seconds(1), verify: { _ in })
            }.value
            XCTFail("A refused peer cannot report helper readiness")
        } catch {}
    }

    func testUnavailableEndpointDeadlineIsBoundedAndNeverReportsMismatch() async throws {
        let selected = binding()
        let request = DesktopBackgroundLaunchProtocol.Request(
            action: .hello,
            binding: selected,
            expectedEpoch: String(repeating: "a", count: 64)
        )
        let began = ContinuousClock.now
        do {
            _ = try await Task.detached {
                try DesktopBackgroundControlClient.exchange(request, timeout: .milliseconds(100), verify: { _ in })
            }.value
            XCTFail("An absent helper is not an authenticated older helper")
        } catch { XCTAssertLessThan(began.duration(to: .now), .seconds(2)) }
    }

    func testDroppedReleaseAcknowledgmentCompletesOnlyAfterDrainEvenIfServerStopped() async throws {
        for stopServer in [false, true] {
            let selected = binding()
            let epoch = String(repeating: "a", count: 64)
            let entered = expectation(description: "release handler began")
            let released = expectation(description: "drained release completed")
            let drain = DeferredReleaseDrain()
            let count = ReleaseCount(), returned = ReleaseCount()
            let server = try DesktopBackgroundControlServer(
                binding: selected, verify: { _, _ in try Self.peer() },
                released: { count.increment()
                    released.fulfill()
                },
                handler: { request, _ in
                    entered.fulfill()
                    await drain.wait()
                    returned.increment()
                    return .init(request: request, epoch: epoch, state: .ownerReleased)
                }
            )
            defer { drain.finish()
                server.stop()
                try? cleanup(selected)
            }
            let socket = try connected(selected)
            let request = DesktopBackgroundLaunchProtocol.Request(action: .releaseOwner, binding: selected, expectedEpoch: epoch)
            try DesktopBackgroundSocket.send(
                DesktopBackgroundLaunchProtocol.encode(request),
                to: socket,
                deadline: .now.advanced(by: .seconds(2))
            )
            await fulfillment(of: [entered], timeout: 2)
            socket.cancel() // Simulates a cancelled rebind client before the acknowledgment.
            if stopServer { server.stop() }
            XCTAssertEqual(count.value, 0, "Disconnect/stop is not proof that the owned child drained")
            drain.finish()
            await fulfillment(of: [released], timeout: 2)
            XCTAssertEqual(
                count.value,
                1,
                "ACK_LOSS_DIAGNOSTIC stopped=\(stopServer) handlerReturned=\(returned.value > 0) callback=\(count.value)"
            )
        }
    }

    func testConcurrentCommittedReleasesNotifyOnceAndBlockedOrThrowingHandlersNeverRelease() async throws {
        let selected = binding()
        let epoch = String(repeating: "a", count: 64)
        let entered = expectation(description: "both release requests await the same owned drain")
        entered.expectedFulfillmentCount = 2
        let released = expectation(description: "one release completion")
        let drain = DeferredReleaseDrain()
        let count = ReleaseCount()
        let server = try DesktopBackgroundControlServer(
            binding: selected, verify: { _, _ in try Self.peer() },
            released: { count.increment()
                released.fulfill()
            },
            handler: { request, _ in
                if request.action == .hello { return .init(request: request, epoch: epoch, state: .lifecycleBlocked) }
                if request.action == .ensureDaemon { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
                entered.fulfill()
                await drain.wait()
                return .init(request: request, epoch: epoch, state: .ownerReleased)
            }
        )
        defer { drain.finish()
            server.stop()
            try? cleanup(selected)
        }
        let blocked = DesktopBackgroundLaunchProtocol.Request(action: .hello, binding: selected, expectedEpoch: epoch)
        let reply = try await Task.detached {
            try DesktopBackgroundControlClient.exchange(blocked, timeout: .seconds(2), verify: { _ in })
        }.value
        XCTAssertEqual(reply.state, .lifecycleBlocked)
        // A thrown handler is a connection failure, never semantic release completion.
        let throwing = DesktopBackgroundLaunchProtocol.Request(action: .ensureDaemon, binding: selected, expectedEpoch: epoch)
        do {
            _ = try await Task.detached {
                try DesktopBackgroundControlClient.exchange(throwing, timeout: .seconds(2), verify: { _ in })
            }.value
            XCTFail("A handler failure cannot produce an acknowledgment")
        } catch {}
        XCTAssertEqual(count.value, 0)
        let sockets = try [connected(selected), connected(selected)]
        for socket in sockets {
            let request = DesktopBackgroundLaunchProtocol.Request(action: .releaseOwner, binding: selected, expectedEpoch: epoch)
            try DesktopBackgroundSocket.send(
                DesktopBackgroundLaunchProtocol.encode(request),
                to: socket,
                deadline: .now.advanced(by: .seconds(2))
            )
        }
        await fulfillment(of: [entered], timeout: 2)
        XCTAssertEqual(count.value, 0)
        drain.finish()
        for socket in sockets {
            _ = try await Task.detached {
                try DesktopBackgroundSocket.receive(socket, deadline: .now.advanced(by: .seconds(2)))
            }.value
        }
        await fulfillment(of: [released], timeout: 2)
        XCTAssertEqual(count.value, 1)
    }

    func testReplyDeliveryDetectsPeerEOFAndNeverConsumesUnexpectedPeerData() throws {
        for eof in [true, false] {
            var descriptors = [Int32](repeating: -1, count: 2)
            guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else { throw DesktopBackgroundSocket.Failure.unavailable }
            let reader = try DesktopBackgroundSocket.Handle(descriptors[0])
            let peer = try DesktopBackgroundSocket.Handle(descriptors[1])
            if eof { peer.cancel() }
            else {
                var byte: UInt8 = 7
                XCTAssertEqual(Darwin.send(peer.fd, &byte, 1, 0), 1)
            }
            let began = ContinuousClock.now
            XCTAssertThrowsError(try DesktopBackgroundSocket.send(
                Data("reply".utf8),
                to: reader,
                deadline: .now.advanced(by: .seconds(2))
            ))
            XCTAssertLessThan(began.duration(to: .now), .seconds(1))
            if !eof {
                var byte: UInt8 = 0
                XCTAssertEqual(Darwin.recv(reader.fd, &byte, 1, 0), 1)
                XCTAssertEqual(byte, 7, "Checking for a protocol violation must not consume caller bytes")
            }
        }
    }

    private func connected(_ binding: DesktopBackgroundLaunchProtocol.Binding) throws -> DesktopBackgroundSocket.Handle {
        let raw = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard raw >= 0 else { throw DesktopBackgroundSocket.Failure.unavailable }
        let socket = try DesktopBackgroundSocket.Handle(raw)
        guard try DesktopBackgroundSocket.address(DesktopBackgroundSocket.path(binding), { Darwin.connect(raw, $0, $1) }) == 0
        else { throw DesktopBackgroundSocket.Failure.unavailable }
        return socket
    }
}

private final class DeferredReleaseDrain: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if completed { lock.unlock()
                continuation.resume()
            } else { waiters.append(continuation)
                lock.unlock()
            }
        }
    }

    func finish() {
        lock.lock()
        completed = true
        let owned = waiters
        waiters = []
        lock.unlock()
        owned.forEach { $0.resume() }
    }
}

private final class ReleaseCount: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int {
        lock.withLock { count }
    }

    func increment() {
        lock.withLock { count += 1 }
    }
}
