// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation
import Network
@testable import Omnesis
import XCTest

/// The session port a routing proxy publishes before its listener is up must be one the listener can bind.
final class GatewayLoopbackSocketTests: XCTestCase {
    func testThePortIsPickedOnTheIPv4WildcardAndCheckedFreeForIPv6BeforeItIsReleased() throws {
        let socket = ScriptedSocketOperations()
        XCTAssertEqual(try GatewayLoopbackSocket.releaseEphemeralPort(operations: socket.operations), 49152)
        XCTAssertEqual(socket.calls, [
            "open IPv4", "bind 42 0.0.0.0:0", "name 42",
            "open IPv6", "bind 142 [::]:49152", "close 142",
            "close 42",
        ])
    }

    func testANumberHeldOverIPv6StaysPickedUntilAFreeOneIsFoundThenAllAreReleased() throws {
        let socket = ScriptedSocketOperations(assignedPorts: [49152, 49153, 49154], ipv6Binds: [EADDRINUSE, EADDRINUSE, 0])
        XCTAssertEqual(try GatewayLoopbackSocket.releaseEphemeralPort(operations: socket.operations), 49154)
        // A refused number is still bound when the next one is picked, so the kernel cannot pick it again.
        XCTAssertEqual(socket.calls.filter { $0.hasPrefix("bind 4") || $0.hasPrefix("close 4") }, [
            "bind 42 0.0.0.0:0", "bind 43 0.0.0.0:0", "bind 44 0.0.0.0:0",
            "close 42", "close 43", "close 44",
        ])
        XCTAssertEqual(Set(socket.closed), [42, 43, 44, 142, 143, 144])
    }

    func testIPv6FailuresOtherThanAHolderDoNotRefuseANumber() throws {
        let unopened = ScriptedSocketOperations()
        unopened.ipv6Opens = false
        XCTAssertEqual(try GatewayLoopbackSocket.releaseEphemeralPort(operations: unopened.operations), 49152)
        XCTAssertEqual(unopened.closed, [42])
        let unavailable = ScriptedSocketOperations(ipv6Binds: [EADDRNOTAVAIL])
        XCTAssertEqual(try GatewayLoopbackSocket.releaseEphemeralPort(operations: unavailable.operations), 49152)
        XCTAssertEqual(unavailable.closed, [142, 42])
    }

    func testTheSearchGivesUpAfterItsCandidatesAndReleasesEveryOne() {
        let candidates = GatewayLoopbackSocket.portCandidates
        let socket = ScriptedSocketOperations(
            assignedPorts: (0 ..< candidates).map { 49152 + UInt16($0) },
            ipv6Binds: Array(repeating: EADDRINUSE, count: candidates)
        )
        XCTAssertThrowsError(try GatewayLoopbackSocket.releaseEphemeralPort(operations: socket.operations)) { error in
            XCTAssertEqual(error as? GatewayRoutingError, .listenerUnavailable)
        }
        XCTAssertEqual(socket.calls.filter { $0.hasPrefix("open IPv4") }.count, candidates)
        XCTAssertEqual(Set(socket.closed).count, 2 * candidates)
        XCTAssertEqual(socket.closed.count, 2 * candidates)
    }

    func testIPv4FailuresThrowAndReleaseOnlyOwnedDescriptors() {
        for stage in 0 ... 2 {
            let socket = ScriptedSocketOperations(failure: stage)
            XCTAssertThrowsError(try GatewayLoopbackSocket.releaseEphemeralPort(operations: socket.operations))
            XCTAssertEqual(socket.closed, stage == 0 ? [] : [42])
        }
        let zero = ScriptedSocketOperations(assignedPorts: [0])
        XCTAssertThrowsError(try GatewayLoopbackSocket.releaseEphemeralPort(operations: zero.operations))
        XCTAssertEqual(zero.closed, [42])
    }

    /// The real network stack. A loopback listener cannot bind a number another socket holds on a
    /// network address or on `::1`, and the kernel picks ephemeral ports in sequence: the numbers
    /// just after one pick are the next ones it hands out, so they are held here before the next
    /// pick. A pick that ignored those holders would publish a port the session cannot listen on.
    func testANumberHeldOnAnotherAddressOrFamilyIsNeverReleasedForTheSessionListener() throws {
        let previous = try GatewayLoopbackSocket.releaseEphemeralPort()
        let network = Self.networkAddress()
        var holders: [Int32] = [], held: [UInt16: String] = [:]
        defer {
            for holder in holders {
                Darwin.close(holder)
            }
        }
        for offset in 1 ... 8 where Int(previous) + offset <= Int(UInt16.max) {
            let number = previous + UInt16(offset)
            let onIPv6 = offset.isMultiple(of: 2) || network == nil
            let holder = onIPv6 ? Self.holdOnIPv6Loopback(number) : network.flatMap { Self.hold(number, on: $0) }
            if let holder {
                holders.append(holder)
                held[number] = onIPv6 ? "[::1]" : "a network address"
            }
        }
        let port = try GatewayLoopbackSocket.releaseEphemeralPort()
        XCTAssertNil(held[port], "Released port \(port) is held on \(held[port] ?? "")")

        let queue = DispatchQueue(label: "test.loopback-socket.listener")
        let ready = expectation(description: "The session listener binds the released port")
        ready.assertForOverFulfill = false
        let states = ListenerStates()
        let listener = GatewayRecoveringListener(
            port: port,
            transport: GatewayNetworkTransport(
                makeConnection: GatewayNetworkTransport.live.makeConnection,
                makeListener: { parameters in
                    let made = try GatewayNetworkTransport.live.makeListener(parameters)
                    return RecordedListener(made, record: states.append)
                }
            ),
            clock: .live,
            queue: queue,
            ready: { if $0 { ready.fulfill() } },
            failed: {},
            accepted: { $0.cancel() }
        )
        defer { queue.sync { listener.close() } }
        queue.sync { listener.start() }
        let result = XCTWaiter().wait(for: [ready], timeout: 5)
        XCTAssertEqual(result, .completed, "Listener on \(port) never ready: \(states.values)")
    }

    private static func networkAddress() -> in_addr? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0 else { return nil }
        defer { freeifaddrs(list) }
        var cursor = list
        while let item = cursor {
            cursor = item.pointee.ifa_next
            let flags = Int32(item.pointee.ifa_flags)
            guard let address = item.pointee.ifa_addr, address.pointee.sa_family == sa_family_t(AF_INET),
                  flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
            return address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
        }
        return nil
    }

    /// A socket bound to `port` on `host` that never listens, or nil when the number is taken.
    private static func hold(_ port: UInt16, on host: in_addr) -> Int32? {
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = host
        address.sin_port = port.bigEndian
        return bound(Darwin.socket(AF_INET, SOCK_STREAM, 0), to: &address)
    }

    private static func holdOnIPv6Loopback(_ port: UInt16) -> Int32? {
        var address = sockaddr_in6()
        address.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
        address.sin6_family = sa_family_t(AF_INET6)
        address.sin6_addr = in6addr_loopback
        address.sin6_port = port.bigEndian
        return bound(Darwin.socket(AF_INET6, SOCK_STREAM, 0), to: &address)
    }

    private static func bound<Address>(_ descriptor: Int32, to address: inout Address) -> Int32? {
        guard descriptor >= 0 else { return nil }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<Address>.size))
            }
        }
        guard result == 0 else {
            Darwin.close(descriptor)
            return nil
        }
        return descriptor
    }
}

private final class ListenerStates: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    var values: [String] {
        lock.withLock { recorded }
    }

    func append(_ state: String) {
        lock.withLock { recorded.append(state) }
    }
}

/// Passes a live listener through, recording its states for a failure message.
private final class RecordedListener: GatewayByteListener {
    private let wrapped: any GatewayByteListener
    private let record: (String) -> Void
    init(_ wrapped: any GatewayByteListener, record: @escaping (String) -> Void) {
        self.wrapped = wrapped
        self.record = record
    }

    var port: UInt16? {
        wrapped.port
    }

    func onState(_ handler: @escaping (NWListener.State) -> Void) {
        wrapped.onState { state in
            self.record("\(state)")
            handler(state)
        }
    }

    func onConnection(_ handler: @escaping (any GatewayByteConnection) -> Void) {
        wrapped.onConnection(handler)
    }

    func start(queue: DispatchQueue) {
        wrapped.start(queue: queue)
    }

    func cancel() {
        wrapped.cancel()
    }
}

/// Scripted socket calls. IPv4 sockets are numbered from 42 and IPv6 sockets from 142.
final class ScriptedSocketOperations {
    /// The IPv4 call that fails: 0 open, 1 bind, 2 name.
    let failure: Int?
    /// The port each IPv4 bind is given, in turn; the last one repeats.
    let assignedPorts: [UInt16]
    /// The `errno` of each IPv6 bind, in turn; 0 binds. Binds past the end succeed.
    var ipv6Binds: [Int32]
    var ipv6Opens = true
    private(set) var calls: [String] = []
    private(set) var closed: [Int32] = []
    private var nextIPv4: Int32 = 42
    private var nextIPv6: Int32 = 142
    private var named = 0
    private var error: Int32 = 0

    init(failure: Int? = nil, assignedPorts: [UInt16] = [49152], ipv6Binds: [Int32] = []) {
        self.failure = failure
        self.assignedPorts = assignedPorts
        self.ipv6Binds = ipv6Binds
    }

    var operations: GatewayUnavailableSocketOperations {
        GatewayUnavailableSocketOperations(
            open: { self.open($0) },
            bind: { self.bind($0, $1, $2) },
            name: { descriptor, address, size in
                self.calls.append("name \(descriptor)")
                XCTAssertEqual(size.pointee, socklen_t(MemoryLayout<sockaddr_in>.size))
                let port = self.assignedPorts[min(self.named, self.assignedPorts.count - 1)]
                self.named += 1
                address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_port = port.bigEndian }
                return self.failure == 2 ? -1 : 0
            },
            close: {
                self.calls.append("close \($0)")
                self.closed.append($0)
            },
            lastError: { self.error }
        )
    }

    private func open(_ family: Int32) -> Int32 {
        if family == AF_INET6 {
            calls.append("open IPv6")
            guard ipv6Opens else { return -1 }
            defer { nextIPv6 += 1 }
            return nextIPv6
        }
        XCTAssertEqual(family, AF_INET)
        calls.append("open IPv4")
        guard failure != 0 else { return -1 }
        defer { nextIPv4 += 1 }
        return nextIPv4
    }

    private func bind(_ descriptor: Int32, _ address: UnsafePointer<sockaddr>, _ size: socklen_t) -> Int32 {
        if address.pointee.sa_family == sa_family_t(AF_INET6) {
            XCTAssertEqual(size, socklen_t(MemoryLayout<sockaddr_in6>.size))
            let (wildcard, port) = address.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) {
                var any = in6addr_any, host = $0.pointee.sin6_addr
                return (memcmp(&host, &any, MemoryLayout<in6_addr>.size) == 0, UInt16(bigEndian: $0.pointee.sin6_port))
            }
            calls.append("bind \(descriptor) [\(wildcard ? "::" : "?")]:\(port)")
            error = ipv6Binds.isEmpty ? 0 : ipv6Binds.removeFirst()
            return error == 0 ? 0 : -1
        }
        XCTAssertEqual(size, socklen_t(MemoryLayout<sockaddr_in>.size))
        let (host, port) = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
            (String(cString: inet_ntoa($0.pointee.sin_addr)), UInt16(bigEndian: $0.pointee.sin_port))
        }
        calls.append("bind \(descriptor) \(host):\(port)")
        return failure == 1 ? -1 : 0
    }
}
