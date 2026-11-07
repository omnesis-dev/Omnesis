// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Network
@testable import Omnesis
import XCTest

@MainActor
final class GatewayRoutingLifecycleTests: XCTestCase {
    private let host = "gateway.example.test"
    private let user = "fixture-user"
    private let password = "fixture-password"
    private let limits = GatewayRoutingProxy.Limits(handshake: 5, attempt: 5, lanBudget: 15, fallback: 5, idle: 5)

    private func proxy(
        _ network: ScriptedGatewayNetwork,
        limits: GatewayRoutingProxy.Limits? = nil,
        clock: GatewayDeadlineClock = .live
    ) throws
        -> GatewayRoutingProxy {
        let route = try XCTUnwrap(GatewayDirectRoute(origin: URL(string: "https://gateway.example.test")!, candidates: [
            GatewayDirectCandidate(address: "192.168.1.2", port: 7600),
            GatewayDirectCandidate(address: "192.168.1.3", port: 7600),
        ]))
        return try GatewayRoutingProxy(
            route: route,
            limits: limits ?? self.limits,
            listenPort: 0,
            transport: network.transport,
            clock: clock,
            credentials: { (self.user, self.password) }
        )
    }

    private func authenticate(_ client: ScriptedGatewayConnection, network: ScriptedGatewayNetwork) {
        network.listener.accept(client)
        client.state(.preparing)
        client.state(.ready)
        let authentication = Data([1, UInt8(user.utf8.count)] + Array(user.utf8) + [UInt8(password.utf8.count)] + Array(password.utf8))
        let request = Data([5, 1, 0, 3, UInt8(host.utf8.count)] + Array(host.utf8) + [1, 187])
        client.read(Data([5, 1, 2]) + authentication + request)
        XCTAssertEqual(client.writes.first?.data, Data([5, 2]))
        client.completeWrite()
        XCTAssertEqual(client.writes.first?.data, Data([1, 0]))
        client.completeWrite()
    }

    func testHalfCloseForwardsRemainingReverseDataBeforeBothDirectionsRetire() throws {
        let upstream = ScriptedGatewayConnection(), client = ScriptedGatewayConnection()
        let network = ScriptedGatewayNetwork([upstream]), proxy = try proxy(network)
        defer { proxy.close() }
        authenticate(client, network: network)
        upstream.state(.preparing)
        upstream.state(.ready)
        client.completeWrite()
        XCTAssertEqual(client.receiveBounds.last?.1, 16384)
        XCTAssertEqual(upstream.receiveBounds.last?.1, 16384)
        client.read(Data("request-tail".utf8), complete: true)
        XCTAssertEqual(upstream.writes.first?.data, Data("request-tail".utf8))
        XCTAssertEqual(upstream.writes.first?.final, true)
        upstream.completeWrite()
        XCTAssertEqual(proxy.activeStreamCount, 1)
        upstream.read(Data("delayed-response".utf8))
        XCTAssertEqual(client.writes.first?.data, Data("delayed-response".utf8))
        XCTAssertEqual(client.writes.first?.final, false)
        client.completeWrite()
        XCTAssertEqual(proxy.activeStreamCount, 1)
        upstream.read(nil, complete: true)
        XCTAssertEqual(client.writes.first?.final, true)
        client.completeWrite()
        XCTAssertEqual(proxy.activeStreamCount, 0)
        XCTAssertEqual(upstream.cancellations, 1)
        XCTAssertEqual(client.cancellations, 1)
    }

    func testResetSendCompletionsAndQueuedReadsAfterCloseCannotResumeForwarding() throws {
        for failureAt in 0 ... 2 {
            let upstream = ScriptedGatewayConnection(), client = ScriptedGatewayConnection()
            let network = ScriptedGatewayNetwork([upstream]), proxy = try proxy(network)
            authenticate(client, network: network)
            if failureAt == 0 {
                upstream.state(.ready)
                client.completeWrite(.posix(.ECONNRESET))
            } else {
                upstream.state(.ready)
                client.completeWrite()
                client.read(Data("bounded-request".utf8))
                if failureAt == 1 { upstream.completeWrite(.posix(.ECONNRESET)) } else {
                    let queuedWrite = upstream.writes.removeFirst().completion
                    proxy.close()
                    upstream.onQueue { queuedWrite(nil) }
                }
                let queuedRead = upstream.reads.removeFirst()
                upstream.onQueue { queuedRead(Data("late-response".utf8), false, nil) }
            }
            XCTAssertEqual(proxy.activeStreamCount, 0)
            upstream.state(.cancelled)
            client.state(.cancelled)
            proxy.close()
        }
    }

    func testStaleCandidateCallbacksCannotReplaceTheCurrentAttemptOrReopenAClosedProxy() throws {
        let old = ScriptedGatewayConnection(), current = ScriptedGatewayConnection(), client = ScriptedGatewayConnection()
        let network = ScriptedGatewayNetwork([old, current]), proxy = try proxy(network)
        authenticate(client, network: network)
        old.state(.waiting(.posix(.ENETDOWN)))
        old.state(.failed(.posix(.ECONNREFUSED)))
        old.state(.ready)
        old.state(.cancelled)
        XCTAssertEqual(client.writes.count, 0)
        current.state(.ready)
        XCTAssertEqual(proxy.connectionPath, .local)
        proxy.close()
        client.completeWrite()
        current.state(.ready)
        network.listener.state(.ready)
        XCTAssertEqual(proxy.connectionPath, .reconnecting)
        let rejected = ScriptedGatewayConnection()
        network.listener.accept(rejected)
        XCTAssertEqual(rejected.cancellations, 1)
        XCTAssertEqual(proxy.activeStreamCount, 0)
    }

    func testHandshakeReplyResetAndOwnerDeinitializationRetirePendingCallbacks() throws {
        let client = ScriptedGatewayConnection(), network = ScriptedGatewayNetwork()
        var proxy: GatewayRoutingProxy? = try self.proxy(network)
        network.listener.accept(client)
        client.state(.ready)
        client.read(Data([5, 1, 2]))
        client.completeWrite(.posix(.ECONNRESET))
        XCTAssertEqual(proxy?.activeStreamCount, 0)
        let second = ScriptedGatewayConnection()
        network.listener.accept(second)
        second.state(.ready)
        second.read(Data([5, 1, 2]))
        proxy = nil
        second.completeWrite()
        client.state(.cancelled)
        second.state(.cancelled)
        network.listener.state(.cancelled)
        let after = ScriptedGatewayConnection()
        network.listener.accept(after)
        XCTAssertEqual(after.cancellations, 1)
    }

    func testReceiveResetAndPostCloseHandshakeCompletionRemainTerminal() throws {
        for duringHandshake in [true, false] {
            let client = ScriptedGatewayConnection(), upstream = ScriptedGatewayConnection()
            let network = ScriptedGatewayNetwork([upstream]), proxy = try self.proxy(network)
            if duringHandshake {
                network.listener.accept(client)
                client.state(.ready)
                proxy.close()
                client.read(Data([5, 1, 2]))
            } else {
                authenticate(client, network: network)
                upstream.state(.ready)
                client.completeWrite()
                upstream.read(nil, error: .posix(.ECONNRESET))
            }
            XCTAssertEqual(proxy.activeStreamCount, 0)
            proxy.close()
        }
    }

    func testClosingEitherActivePathRetainsRemainingSelectionAndIgnoresUnselectedClients() throws {
        for closeLocalFirst in [true, false] {
            let local = ScriptedGatewayConnection(), rejectedFirst = ScriptedGatewayConnection()
            let rejectedSecond = ScriptedGatewayConnection(), relay = ScriptedGatewayConnection()
            let first = ScriptedGatewayConnection(), second = ScriptedGatewayConnection(), pending = ScriptedGatewayConnection()
            let network = ScriptedGatewayNetwork([local, rejectedFirst, rejectedSecond, relay]), proxy = try self.proxy(network)
            defer { proxy.close() }
            authenticate(first, network: network)
            local.state(.ready)
            first.completeWrite()
            authenticate(second, network: network)
            rejectedFirst.state(.failed(.posix(.ECONNREFUSED)))
            rejectedSecond.state(.failed(.posix(.ECONNREFUSED)))
            relay.state(.ready)
            second.completeWrite()
            network.listener.accept(pending)
            pending.state(.ready)
            if closeLocalFirst { first.state(.cancelled) } else { second.state(.cancelled) }
            network.listener.onQueue {
                XCTAssertEqual(proxy.connectionPath, closeLocalFirst ? .relay : .local)
                XCTAssertEqual(proxy.activeStreamCount, 2)
            }
            if closeLocalFirst { second.state(.cancelled) } else { first.state(.cancelled) }
            XCTAssertEqual(proxy.connectionPath, .reconnecting)
            XCTAssertEqual(proxy.activeStreamCount, 1)
        }
    }

    func testCandidateUpdatesAreValidatedAndOnlyNewStreamsUseNewTCPHints() throws {
        let oldFirst = ScriptedGatewayConnection(), oldSecond = ScriptedGatewayConnection(), fresh = ScriptedGatewayConnection()
        let relay = ScriptedGatewayConnection(), first = ScriptedGatewayConnection(), second = ScriptedGatewayConnection(),
            third = ScriptedGatewayConnection()
        let network = ScriptedGatewayNetwork([oldFirst, oldSecond, fresh, relay]), proxy = try self.proxy(network)
        defer { proxy.close() }
        authenticate(first, network: network)
        let changed = [GatewayDirectCandidate(address: "192.168.50.20", port: 8443)]
        try proxy.updateCandidates(changed)
        oldFirst.state(.failed(.posix(.ECONNREFUSED)))
        XCTAssertEqual(network.endpoints, [.hostPort(host: "192.168.1.2", port: 7600), .hostPort(host: "192.168.1.3", port: 7600)])
        oldSecond.state(.ready)
        first.completeWrite()
        authenticate(second, network: network)
        XCTAssertEqual(network.endpoints.last, .hostPort(host: "192.168.50.20", port: 8443))
        fresh.state(.ready)
        second.completeWrite()
        for invalid in [
            [GatewayDirectCandidate(address: "127.0.0.1", port: 7600)],
            [GatewayDirectCandidate(address: "8.8.8.8", port: 443)],
            [GatewayDirectCandidate(address: "192.168.1.2", port: 0)],
            changed + changed,
        ] {
            XCTAssertThrowsError(try proxy.updateCandidates(invalid))
        }
        try proxy.updateCandidates([])
        authenticate(third, network: network)
        XCTAssertEqual(network.endpoints.last, .hostPort(host: "gateway.example.test", port: 443))
        relay.state(.ready)
        third.completeWrite()
        XCTAssertEqual(proxy.activeStreamCount, 3)
        XCTAssertEqual(oldSecond.cancellations, 0)
        XCTAssertEqual(fresh.cancellations, 0)
        proxy.close()
        XCTAssertThrowsError(try proxy.updateCandidates(changed))
    }

    func testFragmentedHandshakeAndEarlyEOFOrResetNeverDialAnUpstream() throws {
        for endedWithReset in [false, true] {
            let client = ScriptedGatewayConnection(), network = ScriptedGatewayNetwork(), proxy = try self.proxy(network)
            defer { proxy.close() }
            network.listener.accept(client)
            client.state(.ready)
            client.read(Data([5]))
            XCTAssertEqual(client.reads.count, 1)
            XCTAssertTrue(client.writes.isEmpty)
            client.read(Data([1, 2]))
            client.completeWrite()
            if endedWithReset { client.read(nil, error: .posix(.ECONNRESET)) } else { client.read(nil, complete: true) }
            XCTAssertEqual(proxy.activeStreamCount, 0)
            XCTAssertTrue(network.endpoints.isEmpty)
        }
    }

    func testHandshakeRejectionAndListenerFailureCannotLeaveAcceptedStreamsAlive() throws {
        let client = ScriptedGatewayConnection(), pending = ScriptedGatewayConnection()
        let network = ScriptedGatewayNetwork(), proxy = try self.proxy(network)
        defer { proxy.close() }
        network.listener.accept(client)
        client.state(.ready)
        client.read(Data([5, 1, 0]))
        XCTAssertEqual(client.writes.first?.data, Data([5, 255]))
        client.completeWrite()
        XCTAssertEqual(proxy.activeStreamCount, 0)
        network.listener.accept(pending)
        pending.state(.ready)
        network.listener.state(.waiting(.posix(.ENETDOWN)))
        XCTAssertEqual(proxy.activeStreamCount, 1)
        network.listener.state(.failed(.posix(.ECONNABORTED)))
        XCTAssertEqual(proxy.activeStreamCount, 0)
        XCTAssertEqual(pending.cancellations, 1)
        XCTAssertTrue(network.endpoints.isEmpty)
    }

    func testTerminalStreamReentryPreservesAllGuardsWithoutNewIOOrReopening() throws {
        let clock = ScriptedGatewayClock(), network = ScriptedGatewayNetwork()
        let proxy = try self.proxy(network, clock: clock.clock)
        defer { proxy.close() }
        let client = ScriptedGatewayConnection(), destination = ScriptedGatewayConnection()
        network.listener.onQueue {
            let stream = GatewayRoutingProxy.Stream(owner: proxy, client: client)
            stream.close()
            stream.close()
            stream.start()
            stream.receiveHandshake()
            stream.apply([], index: 0)
            stream.connectNext()
            stream.pump(client, to: destination)
            XCTAssertEqual(client.cancellations, 1)
            XCTAssertEqual(client.starts, 0)
            XCTAssertTrue(client.reads.isEmpty)
            XCTAssertTrue(client.writes.isEmpty)
            XCTAssertTrue(network.endpoints.isEmpty)
            XCTAssertTrue(clock.deadlines.isEmpty)
            XCTAssertEqual(proxy.activeStreamCount, 0)
        }
    }

    func testHandshakeDeadlineClosesUnverifiedClientAndQueuedExpiryAfterRetirementIsHarmless() throws {
        for retireBeforeDelivery in [false, true] {
            let clock = ScriptedGatewayClock(), client = ScriptedGatewayConnection(), network = ScriptedGatewayNetwork()
            let proxy = try self.proxy(network, clock: clock.clock)
            network.listener.accept(client)
            client.state(.ready)
            clock.advance(5)
            let timer = clock.deadlines[0], callback = timer.queuedExpiry(at: clock.now)
            if retireBeforeDelivery { proxy.close() }
            timer.deliver(callback)
            XCTAssertEqual(proxy.activeStreamCount, 0)
            XCTAssertEqual(client.cancellations, 1)
            XCTAssertTrue(network.endpoints.isEmpty)
            proxy.close()
        }
    }

    func testQueuedAttemptExpiryCannotSupersedeReadyOrAReplacementCandidateAndIdleStillCloses() throws {
        for readyBeforeDelivery in [false, true] {
            let clock = ScriptedGatewayClock(), first = ScriptedGatewayConnection(), next = ScriptedGatewayConnection()
            let client = ScriptedGatewayConnection(), network = ScriptedGatewayNetwork([first, next])
            let proxy = try self.proxy(network, clock: clock.clock)
            defer { proxy.close() }
            authenticate(client, network: network)
            clock.advance(5)
            let attempt = clock.deadlines[1], queued = attempt.queuedExpiry(at: clock.now)
            if readyBeforeDelivery { first.state(.ready) } else { first.state(.failed(.posix(.ECONNREFUSED)))
                next.state(.ready)
            }
            client.completeWrite()
            let selections = network.endpoints.count
            attempt.deliver(queued)
            XCTAssertEqual(network.endpoints.count, selections)
            XCTAssertEqual(proxy.activeStreamCount, 1)
            let idle = try XCTUnwrap(clock.deadlines.last)
            clock.advance(5)
            idle.expire(at: clock.now)
            XCTAssertEqual(proxy.activeStreamCount, 0)
        }
    }

    func testSelectionDeadlinesHonorLANBudgetThenBoundRelayFailure() throws {
        let clock = ScriptedGatewayClock(), first = ScriptedGatewayConnection(), relay = ScriptedGatewayConnection()
        let client = ScriptedGatewayConnection(), network = ScriptedGatewayNetwork([first, relay])
        let short = GatewayRoutingProxy.Limits(handshake: 5, attempt: 5, lanBudget: 1, fallback: 2, idle: 5)
        let proxy = try self.proxy(network, limits: short, clock: clock.clock)
        defer { proxy.close() }
        authenticate(client, network: network)
        XCTAssertEqual(clock.deadlines[1].deadline, clock.now + 1)
        clock.advance(1)
        clock.deadlines[1].expire(at: clock.now)
        XCTAssertEqual(network.endpoints.last, .hostPort(host: "gateway.example.test", port: 443))
        clock.advance(2)
        clock.deadlines[2].expire(at: clock.now)
        XCTAssertEqual(client.writes.first?.data, Data([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]))
        client.completeWrite()
        XCTAssertEqual(proxy.activeStreamCount, 0)
    }

    func testLateAttemptDeadlineAfterOwnerDeinitCannotDialAgain() throws {
        let clock = ScriptedGatewayClock(), upstream = ScriptedGatewayConnection(), client = ScriptedGatewayConnection()
        let network = ScriptedGatewayNetwork([upstream])
        var proxy: GatewayRoutingProxy? = try self.proxy(network, clock: clock.clock)
        let (timer, callback) = withExtendedLifetime(proxy) {
            authenticate(client, network: network)
            clock.advance(5)
            let timer = clock.deadlines[1]
            return (timer, timer.queuedExpiry(at: clock.now))
        }
        proxy = nil
        timer.deliver(callback)
        XCTAssertEqual(network.endpoints.count, 1)
        XCTAssertEqual(client.cancellations, 1)
    }

    func testLiveListenerHasNoPortBeforeStartAndCanCancelWithoutStarting() throws {
        let listener = try GatewayNetworkTransport.live.makeListener(.tcp)
        XCTAssertEqual(listener.port ?? 0, 0)
        listener.cancel()
    }
}
