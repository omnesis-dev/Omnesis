// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import dnssd
import Foundation

struct NearbyGatewayDNSFailure: Error { let denied: Bool }

/// All setup, callbacks and deallocation run on the browser's one serial queue.
/// A context is retained before entering C, including when setup itself blocks.
struct SystemNearbyGatewayDNS: NearbyGatewayDNSDriver {
    struct LifetimeCalls {
        let schedule: (DNSServiceRef, DispatchQueue) -> DNSServiceErrorType
        let deallocate: (DNSServiceRef) -> Void
        static let system = LifetimeCalls(schedule: { DNSServiceSetDispatchQueue($0, $1) }, deallocate: { DNSServiceRefDeallocate($0) })
    }

    private let calls: LifetimeCalls
    private let contextReleased: () -> Void
    init(calls: LifetimeCalls = .system, contextReleased: @escaping () -> Void = {}) {
        self.calls = calls
        self.contextReleased = contextReleased
    }

    private final class Context {
        let receive: (NearbyGatewayDNSEvent) -> Void
        let port: Int
        let released: () -> Void
        deinit { released() }
        init(port: Int = 0, released: @escaping () -> Void, receive: @escaping (NearbyGatewayDNSEvent) -> Void) {
            self.port = port
            self.released = released
            self.receive = receive
        }
    }

    private final class Reference: NearbyGatewayDNSReference {
        private var reference: DNSServiceRef?
        private var context: UnsafeMutableRawPointer?
        private let queue: DispatchQueue
        private let deallocate: (DNSServiceRef) -> Void
        init(
            _ reference: DNSServiceRef,
            context: UnsafeMutableRawPointer,
            queue: DispatchQueue,
            deallocate: @escaping (DNSServiceRef) -> Void
        ) {
            self.reference = reference
            self.context = context
            self.queue = queue
            self.deallocate = deallocate
        }

        func cancel() {
            dispatchPrecondition(condition: .onQueue(queue))
            guard let reference, let context else { return }
            self.reference = nil
            self.context = nil
            // Apple requires deallocation on the same queue passed to SetDispatchQueue.
            // No callback can overlap this call on that serial queue.
            deallocate(reference)
            queue.async { Unmanaged<Context>.fromOpaque(context).release() }
        }
    }

    private static func text(_ pointer: UnsafePointer<CChar>?, limit: Int) -> String? {
        guard let pointer else { return nil }
        let length = strnlen(pointer, limit + 1)
        guard length <= limit else { return nil }
        return String(bytes: UnsafeRawBufferPointer(start: pointer, count: length), encoding: .utf8)
    }

    static func acceptsService(type: String, domain: String) -> Bool {
        type == "_omnesis._tcp." && domain == "local."
    }

    static func compatibleTXT(_ bytes: [UInt8]) -> Bool {
        guard bytes.count <= 1024 else { return false }
        var offset = 0
        var version: String?
        var scheme: String?
        while offset < bytes.count {
            let size = Int(bytes[offset])
            offset += 1
            guard size > 0, offset + size <= bytes.count else { return false }
            let item = bytes[offset ..< offset + size]
            offset += size
            guard let equal = item.firstIndex(of: 61) else { continue }
            let key = String(bytes: item[..<equal], encoding: .utf8)?.lowercased()
            let value = String(bytes: item[(equal + 1)...], encoding: .utf8)
            if key == "v" {
                guard version == nil else { return false }
                version = value
            }
            if key == "scheme" {
                guard scheme == nil else { return false }
                scheme = value
            }
        }
        return version == "1" && scheme == "https"
    }

    func create(
        on queue: DispatchQueue,
        port: Int = 0,
        receive: @escaping (NearbyGatewayDNSEvent) -> Void,
        setup: (UnsafeMutablePointer<DNSServiceRef?>, UnsafeMutableRawPointer) -> DNSServiceErrorType
    ) throws
        -> NearbyGatewayDNSReference {
        dispatchPrecondition(condition: .onQueue(queue))
        let context = Unmanaged.passRetained(Context(port: port, released: contextReleased, receive: receive)).toOpaque()
        var reference: DNSServiceRef?
        let result = setup(&reference, context)
        guard result == kDNSServiceErr_NoError, let reference else {
            if let reference { calls.deallocate(reference) }
            Unmanaged<Context>.fromOpaque(context).release()
            throw NearbyGatewayDNSFailure(denied: result == kDNSServiceErr_PolicyDenied)
        }
        let scheduled = calls.schedule(reference, queue)
        guard scheduled == kDNSServiceErr_NoError else {
            calls.deallocate(reference)
            Unmanaged<Context>.fromOpaque(context).release()
            throw NearbyGatewayDNSFailure(denied: scheduled == kDNSServiceErr_PolicyDenied)
        }
        return Reference(reference, context: context, queue: queue, deallocate: calls.deallocate)
    }

    func browse(on queue: DispatchQueue, receive: @escaping (NearbyGatewayDNSEvent) -> Void) throws -> NearbyGatewayDNSReference {
        try create(on: queue, receive: receive) { reference, context in
            DNSServiceBrowse(reference, 0, 0, "_omnesis._tcp", "local.", { _, flags, interface, error, name, type, domain, raw in
                guard let raw else { return }
                let context = Unmanaged<Context>.fromOpaque(raw).takeUnretainedValue()
                guard error == kDNSServiceErr_NoError else {
                    context.receive(.failed(denied: error == kDNSServiceErr_PolicyDenied))
                    return
                }
                guard let name = SystemNearbyGatewayDNS.text(name, limit: 255), let type = SystemNearbyGatewayDNS.text(type, limit: 64),
                      let domain = SystemNearbyGatewayDNS.text(
                          domain,
                          limit: 253
                      ),
                      SystemNearbyGatewayDNS.acceptsService(type: type, domain: domain) else { return }
                context.receive(.service(.init(name: name, interface: interface), added: flags & UInt32(kDNSServiceFlagsAdd) != 0))
            }, context)
        }
    }

    func resolve(
        _ service: NearbyGatewayDNSService,
        on queue: DispatchQueue,
        receive: @escaping (NearbyGatewayDNSEvent) -> Void
    ) throws
        -> NearbyGatewayDNSReference {
        try create(on: queue, receive: receive) { reference, context in
            DNSServiceResolve(
                reference,
                0,
                service.interface,
                service.name,
                "_omnesis._tcp",
                "local.",
                { _, _, _, error, _, host, port, length, txt, raw in
                    guard let raw else { return }
                    let context = Unmanaged<Context>.fromOpaque(raw).takeUnretainedValue()
                    guard error == kDNSServiceErr_NoError else {
                        context.receive(.failed(denied: error == kDNSServiceErr_PolicyDenied))
                        return
                    }
                    guard let host = SystemNearbyGatewayDNS.text(host, limit: 253), DesktopNearbyGatewayBrowser.localHost(host),
                          length <= 1024,
                          let txt else {
                        context.receive(.resolved(host: "", port: 0, compatible: false))
                        return
                    }
                    let bytes = Array(UnsafeBufferPointer(
                        start: UnsafeRawPointer(txt).assumingMemoryBound(to: UInt8.self),
                        count: Int(length)
                    ))
                    context.receive(.resolved(
                        host: host.lowercased(),
                        port: Int(UInt16(bigEndian: port)),
                        compatible: SystemNearbyGatewayDNS.compatibleTXT(bytes)
                    ))
                },
                context
            )
        }
    }

    func addresses(
        _ host: String,
        port: Int,
        interface: UInt32,
        on queue: DispatchQueue,
        receive: @escaping (NearbyGatewayDNSEvent) -> Void
    ) throws
        -> NearbyGatewayDNSReference {
        guard DesktopNearbyGatewayBrowser.localHost(host), host == host.lowercased(), (1 ... 65535).contains(port) else {
            throw NearbyGatewayDNSFailure(denied: false)
        }
        return try create(on: queue, port: port, receive: receive) { reference, context in
            DNSServiceGetAddrInfo(
                reference,
                0,
                interface,
                UInt32(kDNSServiceProtocol_IPv4 | kDNSServiceProtocol_IPv6),
                host,
                { _, flags, _, error, _, address, ttl, raw in
                    guard let raw else { return }
                    let context = Unmanaged<Context>.fromOpaque(raw).takeUnretainedValue()
                    // One address family may have no record while the other still resolves.
                    // On this error the remaining callback parameters are undefined.
                    if error == kDNSServiceErr_NoSuchRecord { return }
                    guard error == kDNSServiceErr_NoError else {
                        context.receive(.failed(denied: error == kDNSServiceErr_PolicyDenied))
                        return
                    }
                    guard let address else { return }
                    let pointer: UnsafeRawPointer
                    let family = Int32(address.pointee.sa_family)
                    if family == AF_INET {
                        pointer = UnsafeRawPointer(address).advanced(by: MemoryLayout<sockaddr_in>.offset(of: \sockaddr_in.sin_addr)!)
                    } else if family == AF_INET6 {
                        pointer = UnsafeRawPointer(address).advanced(by: MemoryLayout<sockaddr_in6>.offset(of: \sockaddr_in6.sin6_addr)!)
                    } else { return }
                    var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
                    guard inet_ntop(family, pointer, &buffer, socklen_t(INET6_ADDRSTRLEN)) != nil else { return }
                    context.receive(.address(
                        String(cString: buffer),
                        port: context.port,
                        ttl: ttl,
                        added: flags & UInt32(kDNSServiceFlagsAdd) != 0,
                        more: flags & UInt32(kDNSServiceFlagsMoreComing) != 0
                    ))
                },
                context
            )
        }
    }
}
