// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

protocol NearbyGatewayDNSReference: AnyObject { func cancel() }
protocol NearbyGatewayDNSDriver {
    func browse(on queue: DispatchQueue, receive: @escaping (NearbyGatewayDNSEvent) -> Void) throws -> NearbyGatewayDNSReference
    func resolve(
        _ service: NearbyGatewayDNSService,
        on queue: DispatchQueue,
        receive: @escaping (NearbyGatewayDNSEvent) -> Void
    ) throws
        -> NearbyGatewayDNSReference
    func addresses(
        _ host: String,
        port: Int,
        interface: UInt32,
        on queue: DispatchQueue,
        receive: @escaping (NearbyGatewayDNSEvent) -> Void
    ) throws
        -> NearbyGatewayDNSReference
}

struct NearbyGatewayDNSService: Hashable { let name: String
    let interface: UInt32
}

enum NearbyGatewayDNSEvent {
    case service(NearbyGatewayDNSService, added: Bool)
    case resolved(host: String, port: Int, compatible: Bool)
    case address(String, port: Int, ttl: UInt32, added: Bool, more: Bool)
    case failed(denied: Bool)
}

/// The installation's helper owns this object. Snapshot and logical close never wait on C setup.
public final class DesktopNearbyGatewayBrowser: @unchecked Sendable {
    public enum CloseResult: Equatable, Sendable { case confirmed, blocked }
    public final class CloseHandle: @unchecked Sendable {
        private let lock = NSLock()
        private var completedAt: ContinuousClock.Instant?
        private let now: @Sendable () -> ContinuousClock.Instant
        init(now: @escaping @Sendable () -> ContinuousClock.Instant = { .now }) {
            self.now = now
        }

        private struct Waiter { let continuation: CheckedContinuation<CloseResult, Never>
            let timer: DispatchWorkItem
            let deadline: ContinuousClock.Instant
        }

        private var waiters: [UUID: Waiter] = [:]
        public var isConfirmed: Bool {
            lock.withLock { completedAt != nil }
        }

        fileprivate func finish() {
            lock.lock()
            guard completedAt == nil else { lock.unlock()
                return
            }
            let completion = now()
            completedAt = completion
            let pending = Array(waiters.values)
            waiters.removeAll()
            lock.unlock()
            for waiter in pending {
                waiter.timer.cancel()
                waiter.continuation.resume(returning: completion < waiter.deadline ? .confirmed : .blocked)
            }
        }

        private func resolve(_ id: UUID, _ result: CloseResult) {
            lock.lock()
            let waiter = waiters.removeValue(forKey: id)
            lock.unlock()
            waiter?.timer.cancel()
            waiter?.continuation.resume(returning: result)
        }

        public func join(until: ContinuousClock.Instant) async -> CloseResult {
            let id = UUID()
            return await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    lock.lock()
                    if let completedAt {
                        lock.unlock()
                        continuation.resume(returning: completedAt < until ? .confirmed : .blocked)
                        return
                    }
                    let remaining = now().duration(to: until)
                    guard remaining > .zero, !Task.isCancelled else {
                        lock.unlock()
                        continuation.resume(returning: .blocked)
                        return
                    }
                    let parts = remaining.components
                    let seconds = Double(parts.seconds) + Double(parts.attoseconds) / 1e18
                    let timer = DispatchWorkItem { [weak self] in self?.resolve(id, .blocked) }
                    waiters[id] = Waiter(continuation: continuation, timer: timer, deadline: until)
                    lock.unlock()
                    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + seconds, execute: timer)
                    if Task.isCancelled { resolve(id, .blocked) }
                }
            } onCancel: { self.resolve(id, .blocked) }
        }
    }

    private struct Timed { let address: String
        let port: Int
        let expiry: ContinuousClock.Instant
    }

    private struct Cache {
        var generation = UUID()
        var sequence = 0
        var closing = false
        var started = false
        var state = DesktopNearbyGatewayHints.State.unavailable
        var entries: [Timed] = []
        var cursor = 0
        var retryAfter: ContinuousClock.Instant?
    }

    private final class Service {
        let key: NearbyGatewayDNSService
        var resolving = false
        var didResolve = false
        var didFinishAddresses = false
        var deadline: ContinuousClock.Instant?
        var resolver: NearbyGatewayDNSReference?
        var addresses: NearbyGatewayDNSReference?
        var timeout: DispatchWorkItem?
        var refresh: DispatchWorkItem?
        var entries: [String: Timed] = [:]
        init(_ key: NearbyGatewayDNSService) {
            self.key = key
        }
    }

    private let queue: DispatchQueue
    private let driver: NearbyGatewayDNSDriver
    private let now: @Sendable () -> ContinuousClock.Instant
    private let lock = NSLock()
    private var cache = Cache()
    private let closeHandle: CloseHandle
    // Physical state belongs ONLY to queue. No C call is made while cache lock is held.
    private var browse: NearbyGatewayDNSReference?
    private var browseGeneration = UUID()
    private var services: [NearbyGatewayDNSService: Service] = [:]
    private var order: [NearbyGatewayDNSService] = []
    private var pending: [NearbyGatewayDNSService] = []
    private var active = 0

    public convenience init() {
        self.init(driver: SystemNearbyGatewayDNS())
    }

    init(
        driver: NearbyGatewayDNSDriver,
        now: @escaping @Sendable () -> ContinuousClock.Instant = { .now },
        closeNow: @escaping @Sendable () -> ContinuousClock.Instant = { .now }
    ) {
        self.driver = driver
        self.now = now
        closeHandle = CloseHandle(now: closeNow)
        queue = DispatchQueue(label: "dev.omnesis.desktop.nearby")
    }

    private var closing: Bool {
        lock.withLock { cache.closing }
    }

    public func start() {
        let admitted = lock.withLock { () -> Bool in
            guard !cache.closing, !cache.started else { return false }
            cache.started = true
            cache.state = .finding
            return true
        }
        if admitted { queue.async { [self] in startBrowse() } }
    }

    public func requestRetry() {
        let admitted = lock.withLock { () -> Bool in
            guard !cache.closing, cache.started, [.denied, .unavailable].contains(cache.state),
                  cache.retryAfter.map({ now() >= $0 }) ?? true else { return false }
            cache.retryAfter = now().advanced(by: .seconds(30))
            cache.state = .finding
            cache.generation = UUID()
            cache.sequence = 0
            return true
        }
        if admitted { queue.async { [self] in cancelPhysical()
            startBrowse()
        } }
    }

    public func snapshot() -> DesktopNearbyGatewayHints.Snapshot {
        lock.withLock {
            let time = now()
            let entries = cache.entries.filter { $0.expiry > time }
            var candidates: [DesktopNearbyGatewayHints.Candidate] = []
            var seen = Set<String>()
            for index in entries.indices {
                let entry = entries[(cache.cursor + index) % entries.count]
                guard seen.insert("\(entry.address):\(entry.port)").inserted else { continue }
                let parts = time.duration(to: entry.expiry).components
                let ms = Int(min(30000, max(0, Double(parts.seconds) * 1000 + Double(parts.attoseconds) / 1e15)))
                if ms > 0, let candidate = try? DesktopNearbyGatewayHints.Candidate(
                    address: entry.address,
                    port: entry.port,
                    remainingMs: ms
                ) {
                    candidates.append(candidate)
                }
                if candidates.count == 8 { break }
            }
            if !entries.isEmpty { cache.cursor = (cache.cursor + 1) % entries.count }
            cache.sequence = cache.sequence == 9_007_199_254_740_991 ? 0 : cache.sequence + 1
            if cache.sequence == 0 { cache.generation = UUID() }
            let state = cache.state == .ready && candidates.isEmpty ? .finding : cache.state
            return (try? .init(generation: cache.generation, sequence: cache.sequence, state: state, candidates: candidates)) ??
                .unavailable
        }
    }

    public func beginClose() -> CloseHandle {
        let first = lock.withLock { () -> Bool in
            guard !cache.closing else { return false }
            cache.closing = true
            cache.generation = UUID()
            cache.entries = []
            cache.state = .unavailable
            return true
        }
        if first {
            queue.async { [self] in
                cancelPhysical()
                // Driver deallocation queues callback-context release first, on this SAME queue.
                queue.async { [self] in closeHandle.finish() }
            }
        }
        return closeHandle
    }

    private func startBrowse() {
        guard !closing else { return }
        do {
            let generation = UUID()
            browseGeneration = generation
            let reference = try driver.browse(on: queue) { [weak self] event in
                guard let self, browseGeneration == generation else { return }
                receiveBrowse(event)
            }
            if closing { reference.cancel() } else { browse = reference }
        } catch { failure(denied: (error as? NearbyGatewayDNSFailure)?.denied == true) }
    }

    private func receiveBrowse(_ event: NearbyGatewayDNSEvent) {
        guard !closing else { return }
        switch event {
        case .failed(let denied): failure(denied: denied)
        case .service(let key, let added):
            if !added {
                remove(key)
                publish()
                pump()
                return
            }
            guard key.name.utf8.count <= 256, !key.name.isEmpty, services[key] == nil else { return }
            if services.count == 16, let victim = order.first(where: { services[$0]?.resolving == false }) {
                remove(victim)
            }
            guard services.count < 16 else { return }
            services[key] = Service(key)
            order.append(key)
            pending.append(key)
            publish()
            pump()
        default: break
        }
    }

    private func pump() {
        while !closing, active < 2, !pending.isEmpty {
            let key = pending.removeFirst()
            guard let service = services[key], !service.resolving else { continue }
            service.resolving = true
            service.deadline = now().advanced(by: .seconds(3))
            active += 1
            let timeout = DispatchWorkItem { [weak self, weak service] in
                guard let self, let service, services[key] === service, service.resolving else { return }
                expireResolution(service)
            }
            service.timeout = timeout
            queue.asyncAfter(deadline: .now() + 3, execute: timeout)
            do {
                let ref = try driver.resolve(key, on: queue) { [weak self, weak service] event in
                    guard let self, let service, !closing, services[key] === service, !service.didResolve else { return }
                    guard !service.resolving || service.deadline.map({ self.now() < $0 }) == true else {
                        expireResolution(service)
                        return
                    }
                    resolve(event, service: service)
                }
                if closing || services[key] !== service { ref.cancel() } else { service.resolver = ref }
            } catch {
                if (error as? NearbyGatewayDNSFailure)?.denied == true { failure(denied: true) } else {
                    remove(key)
                    publish()
                }
            }
        }
    }

    private func resolve(_ event: NearbyGatewayDNSEvent, service: Service) {
        switch event {
        case .failed(let denied):
            if denied { failure(denied: true) } else {
                remove(service.key)
                publish()
                pump()
            }
        case .resolved(let host, let port, let compatible):
            guard !service.didResolve else { return }
            guard compatible, Self.localHost(host), (1 ... 65535).contains(port) else {
                remove(service.key)
                publish()
                pump()
                return
            }
            service.didResolve = true
            service.resolver?.cancel()
            service.resolver = nil
            do {
                let ref = try driver.addresses(host.lowercased(), port: port, interface: service.key.interface, on: queue) { [
                    weak self,
                    weak service
                ] event in
                    guard let self, let service, !closing, services[service.key] === service, !service.didFinishAddresses else { return }
                    guard !service.resolving || service.deadline.map({ self.now() < $0 }) == true else {
                        expireResolution(service)
                        return
                    }
                    address(event, service: service)
                }
                if closing || services[service.key] !== service { ref.cancel() } else { service.addresses = ref }
            } catch {
                if (error as? NearbyGatewayDNSFailure)?.denied == true { failure(denied: true) } else {
                    remove(service.key)
                    publish()
                    pump()
                }
            }
        default: break
        }
    }

    static func localHost(_ host: String) -> Bool {
        let text = host.lowercased()
        guard text.utf8.count <= 253, text.hasSuffix(".local."), !text.contains("%") else { return false }
        return text.dropLast().split(separator: ".", omittingEmptySubsequences: false).allSatisfy {
            !$0.isEmpty && $0.utf8.count <= 63 && $0.first != "-" && $0.last != "-" &&
                $0.utf8.allSatisfy { (97 ... 122).contains($0) || (48 ... 57).contains($0) || $0 == 45 }
        }
    }

    private func address(_ event: NearbyGatewayDNSEvent, service: Service) {
        switch event {
        case .failed(let denied):
            if denied { failure(denied: true) } else {
                remove(service.key)
                publish()
                pump()
            }
        case .address(let raw, let port, let ttl, let added, _):
            if (1 ... 65535).contains(port), let address = DesktopNearbyGatewayHints.privateAddress(raw) {
                let key = "\(address):\(port)"
                if !added || ttl == 0 { service.entries.removeValue(forKey: key) }
                else if service.entries.count < 8 || service.entries[key] != nil {
                    service.entries[key] = Timed(address: address, port: port, expiry: now().advanced(by: .seconds(min(ttl, 30))))
                }
            }
            publish()
            pump()
        default: break
        }
    }

    private func expireResolution(_ service: Service) {
        if service.didResolve, service.entries.values.contains(where: { $0.expiry > now() }) {
            finishAddresses(service)
        } else {
            remove(service.key)
        }
        publish()
        pump()
    }

    private func finishAddresses(_ service: Service) {
        guard service.resolving else { return }
        active -= 1
        service.resolving = false
        service.didFinishAddresses = true
        service.addresses?.cancel()
        service.addresses = nil
        service.timeout?.cancel()
        service.timeout = nil
        let refresh = DispatchWorkItem { [weak self, weak service] in
            guard let self, let service, !closing, services[service.key] === service else { return }
            remove(service.key)
            services[service.key] = Service(service.key)
            order.append(service.key)
            pending.append(service.key)
            publish()
            pump()
        }
        service.refresh = refresh
        queue.asyncAfter(deadline: .now() + 30, execute: refresh)
    }

    private func publish() {
        let entries = order.compactMap { services[$0] }.flatMap(\.entries.values)
        lock.withLock {
            guard !cache.closing else { return }
            cache.entries = entries
            if !entries.isEmpty { cache.state = .ready }
        }
    }

    private func remove(_ key: NearbyGatewayDNSService) {
        guard let service = services.removeValue(forKey: key) else { return }
        if service.resolving { active -= 1 }
        service.timeout?.cancel()
        service.refresh?.cancel()
        service.resolver?.cancel()
        service.addresses?.cancel()
        order.removeAll { $0 == key }
        pending.removeAll { $0 == key }
    }

    private func failure(denied: Bool) {
        guard !closing else { return }
        cancelPhysical()
        lock.withLock {
            guard !cache.closing else { return }
            cache.entries = []
            cache.state = denied ? .denied : .unavailable
            cache.retryAfter = now().advanced(by: .seconds(30))
        }
    }

    private func cancelPhysical() {
        browseGeneration = UUID()
        browse?.cancel()
        browse = nil
        for key in order {
            remove(key)
        }
        pending = []
        active = 0
    }

    /// Test-only synchronization with the real serialization boundary; never used by snapshot/close.
    func synchronized() async {
        await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
    }
}
