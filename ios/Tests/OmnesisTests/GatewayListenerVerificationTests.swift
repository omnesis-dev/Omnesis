// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Network
@testable import Omnesis
import XCTest

/// A session's loopback endpoint can stop accepting without its listener reporting a failure:
/// iOS reclaims the sockets of a suspended app. `verify` is what finds that out.
final class GatewayListenerVerificationTests: XCTestCase {
    private let refusedOnLoopback = NWConnection.State.waiting(.posix(.ECONNREFUSED))

    func testAListenerThatDiedSilentlyIsRebuiltOnTheSamePort() throws {
        let fixture = ListenerVerificationFixture()
        let first = ScriptedGatewayListener(), replacement = ScriptedGatewayListener()
        fixture.listeners = [first, replacement]
        let owner = fixture.started()
        defer { fixture.queue.sync { owner.close() } }

        fixture.verify(owner)
        let probe = try XCTUnwrap(fixture.probes.last)
        XCTAssertEqual(fixture.probed, ["127.0.0.1:49151"])
        XCTAssertEqual(probe.starts, 1)
        XCTAssertTrue(fixture.verdicts.isEmpty)
        fixture.queue.sync { XCTAssertTrue(owner.listening, "The listener never reported its death") }

        probe.state(refusedOnLoopback)
        XCTAssertEqual(fixture.faults, 1)
        XCTAssertEqual(first.cancellations, 1)
        XCTAssertEqual(probe.cancellations, 1)
        XCTAssertEqual(fixture.bindings, ["127.0.0.1:0", "127.0.0.1:49151"], "Rebuilt at once, with no backoff")
        XCTAssertEqual(fixture.reuse, [true, true])
        fixture.queue.sync {} // the replacement's readiness
        XCTAssertEqual(fixture.verdicts, [true])
        fixture.queue.sync {
            XCTAssertTrue(owner.listening)
            XCTAssertEqual(owner.port, 49151)
        }

        // Nothing the dead listener or its probe says later can count.
        let stale = ScriptedGatewayConnection()
        first.accept(stale)
        first.state(.ready)
        probe.state(.failed(.posix(.ECONNRESET)))
        XCTAssertEqual(stale.cancellations, 1)
        XCTAssertEqual(fixture.accepted, 0)
        XCTAssertEqual(fixture.faults, 1)
        XCTAssertEqual(fixture.bindings.count, 2)
    }

    func testAProbeNobodyAcceptsInTimeCountsAsADeadListener() throws {
        let fixture = ListenerVerificationFixture()
        let first = ScriptedGatewayListener(), replacement = ScriptedGatewayListener()
        fixture.listeners = [first, replacement]
        let owner = fixture.started()
        defer { fixture.queue.sync { owner.close() } }

        fixture.verify(owner)
        let probe = try XCTUnwrap(fixture.probes.last)
        // The kernel completed the connection, but no listener is behind it to accept.
        probe.state(.ready)
        XCTAssertTrue(fixture.verdicts.isEmpty)
        let timeout = try XCTUnwrap(fixture.clock.deadlines.last)
        fixture.clock.advance(GatewayRecoveringListener.probeTimeout)
        timeout.expire(at: fixture.clock.now)
        XCTAssertEqual(fixture.faults, 1)
        XCTAssertEqual(fixture.bindings, ["127.0.0.1:0", "127.0.0.1:49151"])
        fixture.queue.sync {}
        XCTAssertEqual(fixture.verdicts, [true])
    }

    func testAHealthyListenerIsLeftAlone() throws {
        let fixture = ListenerVerificationFixture()
        let listener = ScriptedGatewayListener()
        fixture.listeners = [listener]
        let owner = fixture.started()
        defer { fixture.queue.sync { owner.close() } }

        fixture.verify(owner)
        fixture.verify(owner)
        XCTAssertEqual(fixture.probes.count, 1, "Concurrent checks share one probe")
        let probe = try XCTUnwrap(fixture.probes.last)
        let timeout = try XCTUnwrap(fixture.clock.deadlines.last)
        probe.state(.ready)
        fixture.clock.advance(GatewayRecoveringListener.probeTimeout)
        let lateTimeout = timeout.queuedExpiry(at: fixture.clock.now)
        listener.accept(ScriptedGatewayConnection())
        XCTAssertEqual(fixture.verdicts, [true, true])
        XCTAssertEqual(probe.cancellations, 1)
        XCTAssertEqual(fixture.accepted, 1, "The accepted connection still reaches the proxy, which ends it")

        timeout.deliver(lateTimeout)
        probe.state(.cancelled)
        XCTAssertEqual(fixture.faults, 0)
        XCTAssertEqual(listener.cancellations, 0)
        XCTAssertEqual(fixture.bindings, ["127.0.0.1:0"])
        fixture.queue.sync { XCTAssertTrue(owner.listening) }

        fixture.verify(owner)
        XCTAssertEqual(fixture.probes.count, 2, "A later check probes again")
    }

    func testAServingListenerThatFallsBackToWaitingIsRepaired() {
        let fixture = ListenerVerificationFixture()
        let opening = ScriptedGatewayListener(), replacement = ScriptedGatewayListener()
        opening.automaticallyReady = false
        fixture.listeners = [opening, replacement]
        let owner = fixture.make()
        defer { fixture.queue.sync { owner.close() } }
        fixture.queue.sync { owner.start() }

        opening.state(.waiting(.posix(.ENETDOWN)))
        XCTAssertEqual(fixture.faults, 0, "A listener still opening keeps its readiness deadline")
        opening.state(.ready)
        fixture.queue.sync { XCTAssertTrue(owner.listening) }

        opening.state(.waiting(.posix(.ENETDOWN)))
        XCTAssertEqual(fixture.faults, 1)
        XCTAssertEqual(opening.cancellations, 1)
        fixture.queue.sync { XCTAssertFalse(owner.listening) }
        fixture.clock.advance(1)
        fixture.clock.deadlines.last?.expire(at: fixture.clock.now)
        fixture.queue.sync {
            XCTAssertTrue(owner.listening)
            XCTAssertEqual(owner.port, 49151)
        }
        XCTAssertEqual(fixture.bindings, ["127.0.0.1:0", "127.0.0.1:49151"])
    }

    func testVerifyRunsAQueuedRepairAtOnceAndAFailedRebuildKeepsItsBackoff() throws {
        let fixture = ListenerVerificationFixture()
        let first = ScriptedGatewayListener(), second = ScriptedGatewayListener()
        fixture.listeners = [first]
        let owner = fixture.started()
        first.state(.failed(.posix(.ECONNABORTED)))
        XCTAssertEqual(fixture.bindings.count, 1, "The repair waits out its backoff")

        // No listener can be made: the check answers false and the repair stays bounded.
        fixture.verify(owner)
        XCTAssertEqual(fixture.bindings.count, 2)
        XCTAssertEqual(fixture.verdicts, [false])
        XCTAssertTrue(fixture.probes.isEmpty, "Nothing is listening, so there is nothing to probe")
        let backoff = try XCTUnwrap(fixture.clock.deadlines.last)
        XCTAssertEqual(backoff.deadline.uptimeNanoseconds - fixture.clock.now.uptimeNanoseconds, 1_000_000_000)

        fixture.listeners = [second]
        fixture.verify(owner)
        fixture.queue.sync {}
        XCTAssertEqual(fixture.verdicts, [false, true])
        XCTAssertEqual(fixture.bindings, ["127.0.0.1:0", "127.0.0.1:49151", "127.0.0.1:49151"])

        // A probe-found fault reopens once; when that fails the usual backoff applies.
        fixture.verify(owner)
        try XCTUnwrap(fixture.probes.last).state(refusedOnLoopback)
        XCTAssertEqual(fixture.verdicts, [false, true, false])
        XCTAssertEqual(fixture.bindings.count, 4)
        let retry = try XCTUnwrap(fixture.clock.deadlines.last)
        XCTAssertEqual(retry.deadline.uptimeNanoseconds - fixture.clock.now.uptimeNanoseconds, 1_000_000_000)
        fixture.queue.sync { owner.close() }
    }

    func testRetirementAnswersAPendingCheckAndNothingReopens() throws {
        let fixture = ListenerVerificationFixture()
        fixture.listeners = [ScriptedGatewayListener()]
        let owner = fixture.started()

        fixture.verify(owner)
        let probe = try XCTUnwrap(fixture.probes.last)
        let timeout = try XCTUnwrap(fixture.clock.deadlines.last)
        fixture.clock.advance(GatewayRecoveringListener.probeTimeout)
        let lateTimeout = timeout.queuedExpiry(at: fixture.clock.now)
        fixture.queue.sync { owner.close() }
        XCTAssertEqual(fixture.verdicts, [false])
        XCTAssertEqual(probe.cancellations, 1)

        timeout.deliver(lateTimeout)
        probe.state(refusedOnLoopback)
        fixture.verify(owner)
        XCTAssertEqual(fixture.verdicts, [false, false])
        XCTAssertEqual(fixture.probes.count, 1)
        XCTAssertEqual(fixture.bindings.count, 1)
        XCTAssertEqual(fixture.faults, 0)
    }

    func testAListenerWithoutAnEndpointHasNothingToVerify() {
        let fixture = ListenerVerificationFixture()
        let owner = fixture.make()
        fixture.verify(owner)
        XCTAssertEqual(fixture.verdicts, [false])
        XCTAssertTrue(fixture.bindings.isEmpty)
        XCTAssertTrue(fixture.probes.isEmpty)
    }

    func testTheProxyKeepsItsEndpointAndClosesItsStreamsWhenVerifyRebuildsTheListener() throws {
        let probe = ScriptedGatewayConnection(), client = ScriptedGatewayConnection()
        let network = ScriptedGatewayNetwork([probe])
        let route = try XCTUnwrap(GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [GatewayDirectCandidate(address: "192.168.1.2", port: 7600)]
        ))
        let proxy = try GatewayRoutingProxy(route: route, limits: .production, listenPort: 0, transport: network.transport)
        defer { proxy.close() }
        network.listener.accept(client)
        XCTAssertEqual(proxy.activeStreamCount, 1)

        let verdicts = VerdictLog()
        proxy.verifyListener { verdicts.append($0) }
        XCTAssertTrue(proxy.isListening)
        XCTAssertEqual(network.endpoints.count, 1, "Only the loopback probe was dialed")
        probe.state(refusedOnLoopback)
        XCTAssertEqual(client.cancellations, 1)
        XCTAssertEqual(proxy.activeStreamCount, 0)
        XCTAssertTrue(proxy.isListening)
        XCTAssertEqual(proxy.listeningPort, 49151)
        XCTAssertEqual(verdicts.values, [true])

        proxy.close()
        let closed = expectation(description: "a closed proxy answers")
        proxy.verifyListener { serving in
            XCTAssertFalse(serving)
            closed.fulfill()
        }
        wait(for: [closed], timeout: 5)
    }

    #if os(macOS)
    /// The real Network stack: a listener cancelled behind the owner's back refuses the probe,
    /// and the same port binds again immediately.
    func testALiveListenerCancelledSilentlyIsFoundAndReboundOnItsPort() throws {
        let port = try GatewayLoopbackSocket.releaseEphemeralPort()
        let queue = DispatchQueue(label: "test.listener.live")
        let made = SilencedListeners()
        let owner = GatewayRecoveringListener(
            port: port,
            transport: GatewayNetworkTransport(
                makeConnection: GatewayNetworkTransport.live.makeConnection,
                makeListener: { try made.wrap(GatewayNetworkTransport.live.makeListener($0)) }
            ),
            clock: .live,
            queue: queue,
            ready: { _ in },
            failed: {},
            accepted: { $0.cancel() }
        )
        defer { queue.sync { owner.close() } }
        func verify(_ what: String) -> Bool {
            let answered = expectation(description: what)
            let verdicts = VerdictLog()
            queue.async {
                owner.verify {
                    verdicts.append($0)
                    answered.fulfill()
                }
            }
            wait(for: [answered], timeout: 15)
            return verdicts.values == [true]
        }

        queue.sync { owner.start() }
        XCTAssertTrue(verify("the first listener to serve"))
        XCTAssertTrue(verify("a healthy listener to pass its probe"))
        XCTAssertEqual(made.count, 1, "A healthy listener is not rebuilt")

        made.silenceAndCancelLatest()
        XCTAssertTrue(verify("the dead listener to be replaced"))
        XCTAssertEqual(made.count, 2)
        queue.sync {
            XCTAssertTrue(owner.listening)
            XCTAssertEqual(owner.port, port)
        }
        XCTAssertTrue(verify("the replacement to pass its probe"))
        XCTAssertEqual(made.count, 2)
    }

    func testARoutedSessionVerifiesOnlyAProxyItAlreadyHas() async throws {
        let route = try XCTUnwrap(GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [GatewayDirectCandidate(address: "192.168.1.2", port: 7600)]
        ))
        let factory = CountingProxyFactory()
        let owner = PinnedSession(
            spkiFingerprint: String(repeating: "a", count: 64),
            host: "gateway.example.test",
            directRoute: route,
            proxyFactory: factory
        )
        let before = await owner.verifyRouting()
        XCTAssertFalse(before)
        XCTAssertEqual(factory.count, 0, "Verifying never creates a proxy or a session")

        _ = owner.session
        XCTAssertEqual(factory.count, 1)
        let opening = await owner.verifyRouting()
        let probed = await owner.verifyRouting()
        XCTAssertTrue(opening)
        XCTAssertTrue(probed)

        owner.retireRouting()
        let retired = await owner.verifyRouting()
        XCTAssertFalse(retired)
        XCTAssertEqual(factory.count, 1)

        let unrouted = PinnedSession(fingerprintHex: String(repeating: "b", count: 64))
        let nothing = await unrouted.verifyRouting()
        XCTAssertFalse(nothing)
    }
    #endif
}

private final class ListenerVerificationFixture: @unchecked Sendable {
    let queue = DispatchQueue(label: "test.listener.verify")
    let clock = ScriptedGatewayClock()
    var listeners: [ScriptedGatewayListener] = []
    var probes: [ScriptedGatewayConnection] = []
    var probed: [String] = []
    var bindings: [String] = []
    var reuse: [Bool] = []
    var verdicts: [Bool] = []
    var accepted = 0
    var faults = 0

    func make() -> GatewayRecoveringListener {
        GatewayRecoveringListener(
            port: 0,
            transport: GatewayNetworkTransport(makeConnection: { endpoint, _ in
                if case .hostPort(let host, let port) = endpoint { self.probed.append("\(host):\(port.rawValue)") }
                let probe = ScriptedGatewayConnection()
                self.probes.append(probe)
                return probe
            }, makeListener: { parameters in
                if case .hostPort(let host, let port) = parameters.requiredLocalEndpoint {
                    self.bindings.append("\(host):\(port.rawValue)")
                }
                self.reuse.append(parameters.allowLocalEndpointReuse)
                guard !self.listeners.isEmpty else { throw GatewayRoutingError.listenerUnavailable }
                return self.listeners.removeFirst()
            }),
            clock: clock.clock,
            queue: queue,
            ready: { _ in },
            failed: { self.faults += 1 },
            accepted: { _ in self.accepted += 1 }
        )
    }

    /// A listener that is bound and serving.
    func started() -> GatewayRecoveringListener {
        let owner = make()
        queue.sync { owner.start() }
        queue.sync {}
        return owner
    }

    func verify(_ owner: GatewayRecoveringListener) {
        queue.sync { owner.verify { self.verdicts.append($0) } }
    }
}

private final class VerdictLog: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [Bool] = []
    var values: [Bool] {
        lock.withLock { recorded }
    }

    func append(_ verdict: Bool) {
        lock.withLock { recorded.append(verdict) }
    }
}

#if os(macOS)
/// Wraps live listeners so a test can end one the way a reclaimed socket ends: no callback.
private final class SilencedListeners: @unchecked Sendable {
    private let lock = NSLock()
    private var wrapped: [Silenced] = []
    var count: Int {
        lock.withLock { wrapped.count }
    }

    func wrap(_ listener: any GatewayByteListener) -> any GatewayByteListener {
        let next = Silenced(listener)
        lock.withLock { wrapped.append(next) }
        return next
    }

    func silenceAndCancelLatest() {
        lock.withLock { wrapped.last }?.endSilently()
    }

    private final class Silenced: GatewayByteListener, @unchecked Sendable {
        private let live: any GatewayByteListener
        private let lock = NSLock()
        private var silent = false
        init(_ live: any GatewayByteListener) {
            self.live = live
        }

        private var isSilent: Bool {
            lock.withLock { silent }
        }

        var port: UInt16? {
            live.port
        }

        func onState(_ handler: @escaping (NWListener.State) -> Void) {
            live.onState { [weak self] state in
                if self?.isSilent == false { handler(state) }
            }
        }

        func onConnection(_ handler: @escaping (any GatewayByteConnection) -> Void) {
            live.onConnection { [weak self] connection in
                if self?.isSilent == false { handler(connection) } else { connection.cancel() }
            }
        }

        func start(queue: DispatchQueue) {
            live.start(queue: queue)
        }

        func cancel() {
            live.cancel()
        }

        func endSilently() {
            lock.withLock { silent = true }
            live.cancel()
        }
    }
}

private final class CountingProxyFactory: GatewayRoutingProxyCreating, @unchecked Sendable {
    private let lock = NSLock()
    private var created = 0
    var count: Int {
        lock.withLock { created }
    }

    func create(route: GatewayDirectRoute, verifyTrust: @escaping GatewayDirectProbe.TrustVerifier) throws -> GatewayRoutingProxy {
        lock.withLock { created += 1 }
        return try GatewayRoutingProxyFactory().create(route: route, verifyTrust: verifyTrust)
    }
}
#endif
