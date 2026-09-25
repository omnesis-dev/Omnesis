// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// A proposed departure has no durable effect until explicitly confirmed.
public struct LocalSourceDepartureRequest: Equatable, Sendable {
    public private(set) var sourceId: String?

    public init() {}

    public mutating func propose(_ sourceId: String) {
        self.sourceId = sourceId
    }

    public mutating func cancel() {
        sourceId = nil
    }

    public mutating func confirm() -> String? {
        defer { sourceId = nil }
        return sourceId
    }

    public static let explanation =
        "Uploads from this iPhone stop. When the gateway processes the request, it detaches this "
            + "iPhone if another member remains. For a partitioned source, that deletes this iPhone's "
            + "gateway contribution; sibling streams stay. Shared or replicated data stays. If this is "
            + "the last member, the source is paused and its data retained. Ownership may pass to another member. "
            + "Membership can change before this runs. Offline requests wait for reconnect."

    public static let deletionLimits =
        "Deletion covers managed gateway data, not originals on your phone or provider, retained "
            + "backups or exported copies. It does not guarantee physical secure erasure."

    public static let wholeSourceExplanation =
        "Remove this entire source for every device. Its managed documents, analytics and sync state "
            + "are purged asynchronously. Re-adding is blocked until cleanup finishes; then enable or add "
            + "the source explicitly to ingest again."
}

/// Durable outbox keeping the gateway's view of which sources this phone
/// hosts in step with the phone's own opt-in switches.
///
/// A tap on a source's switch is the only moment its intent exists, so the
/// intent is written down before the gateway is asked. An app killed
/// mid-request, or a gateway that never answered, must not leave the phone
/// hosting a source whose switch reads off — nor off one whose switch reads
/// on. At most one intent is queued per source on a gateway: the latest
/// replaces the earlier, so turning a source back on retires a detach the
/// gateway has not seen yet instead of racing it.
///
/// Every intent records both the durable device id and the pairing generation
/// it was taken under. A repair deliberately keeps the device id but receives
/// a fresh generation, so work from the old credential is still dropped.
///
/// Carrying out a `detach`:
///   - the gateway drops this device from the source's hosts → done;
///   - the source no longer exists (404) → done;
///   - 409 `LAST_MEMBER` (this device is the only host) → the source is
///     paused instead, then done; a failed pause keeps the intent, and the
///     next attempt re-detaches, gets `LAST_MEMBER` again and re-pauses;
///   - 409 `DEVICE_NOT_MEMBER` (nothing for this device to leave) → done;
///   - a `terminalRefusals` code → dropped, since a later pass would earn
///     the identical answer;
///   - anything else (offline, 5xx) → the intent stays for the next attempt.
///
/// Carrying out a `resume`:
///   - the gateway has no row for the source → create it under this durable,
///     explicit activation; cleanup/network failures retain the intent;
///   - the row exists without this device among its hosts → join it;
///   - the row is paused → enable it;
///   - refusals and failures settle exactly as they do for a detach.
///
/// A refusal is reported to the caller as well as logged. A phone whose
/// `resume` was refused hosts nothing, however its switch reads, so the
/// surface that asked has to hear about it — see `Pass.refusals`.
public actor LocalSourceMembershipCoordinator {
    /// What this phone wants its membership of a source to become.
    public enum Operation: String, Codable, Sendable {
        /// Stop hosting the source. A partitioned source removes this
        /// device's stream when a sibling remains; a last-member refusal is
        /// represented as a pause and retains the data.
        case detach
        /// Host the source again, and unpause a source this device paused
        /// when it left as the source's only host.
        case resume
    }

    /// One intent the gateway has not been told about yet.
    public struct Intent: Codable, Hashable, Sendable {
        public let gateway: String
        public let sourceId: String
        /// The gateway-assigned device id this intent was taken under. Nil
        /// in a blob written before the field existed: such an intent is
        /// carried out under whatever pairing is current, because dropping
        /// it would silently abandon a departure the user asked for, while
        /// replaying one at worst re-detaches an already-detached device —
        /// `DEVICE_NOT_MEMBER`, which settles.
        public let deviceId: String?
        /// Gateway token-row id for the exact pairing that recorded this
        /// intent. Nil is the legacy contract and only matches a legacy pair.
        public let pairingGeneration: String?
        public let operation: Operation
        /// Identifies this exact user action. Legacy records keep nil across reads.
        public let operationId: UUID?

        public init(
            gateway: String,
            sourceId: String,
            deviceId: String?,
            pairingGeneration: String? = nil,
            operation: Operation = .detach,
            operationId: UUID = UUID()
        ) {
            self.gateway = gateway
            self.sourceId = sourceId
            self.deviceId = deviceId
            self.pairingGeneration = pairingGeneration
            self.operation = operation
            self.operationId = operationId
        }

        public init(from decoder: Decoder) throws {
            // `CodingKeys` is the compiler-synthesized one — `encode(to:)`
            // stays synthesized, so spelling it out would only restate the
            // property names.
            let container = try decoder.container(keyedBy: CodingKeys.self)
            gateway = try container.decode(String.self, forKey: .gateway)
            sourceId = try container.decode(String.self, forKey: .sourceId)
            deviceId = try container.decodeIfPresent(String.self, forKey: .deviceId)
            pairingGeneration = try container.decodeIfPresent(
                String.self,
                forKey: .pairingGeneration
            )
            // An intent persisted without an operation is a detach.
            operation = try container.decodeIfPresent(Operation.self, forKey: .operation) ?? .detach
            operationId = try container.decodeIfPresent(UUID.self, forKey: .operationId)
        }
    }

    /// An intent the gateway refused in a way a later pass would earn
    /// identically. Carries the refusal's code rather than its message: the
    /// gateway's prose names source ids and, for some codes, a CLI remedy,
    /// neither of which belongs on a phone. The caller turns the code into
    /// its own copy.
    public struct Refusal: Equatable, Sendable {
        public let sourceId: String
        public let operation: Operation
        public let code: String
        public let operationId: UUID?
        public let gateway: String

        public init(sourceId: String, operation: Operation, code: String, operationId: UUID? = nil, gateway: String = "") {
            self.sourceId = sourceId
            self.operation = operation
            self.code = code
            self.operationId = operationId
            self.gateway = gateway
        }
    }

    /// What one reconcile pass did.
    public struct Pass: Equatable, Sendable {
        /// Whether anything settled, so the caller can refresh its view of
        /// the source registry.
        public var settled: Bool
        /// Refusals earned during the pass, in the order they were earned.
        public var refusals: [Refusal]

        public init(settled: Bool = false, refusals: [Refusal] = []) {
            self.settled = settled
            self.refusals = refusals
        }
    }

    /// How one intent ended.
    private enum Settlement: Equatable {
        /// The gateway now reflects the intent; retire it.
        case settled
        /// Refused for good — retire it, and tell the caller the code.
        case refused(String)
        /// Nothing conclusive; keep it for the next pass.
        case deferred
    }

    /// The gateway calls a reconcile pass needs, injected so the outbox
    /// semantics are testable without HTTP.
    public struct Executor: Sendable {
        public var isCurrentSession: @Sendable () async -> Bool
        /// `GET /admin/sources`.
        public var sources: @Sendable () async throws -> [SourceRecord]
        /// Explicit registration through `POST /admin/sources`.
        public var create: @Sendable (_ sourceId: String, _ deviceId: String) async throws -> Void
        /// `POST /admin/sources/:id/members`.
        public var join: @Sendable (_ sourceId: String, _ deviceId: String) async throws -> Void
        /// `DELETE /admin/sources/:id/members/:deviceId`.
        public var detach: @Sendable (_ sourceId: String, _ deviceId: String) async throws -> Void
        /// `PATCH /admin/sources/:id {enabled}`.
        public var setEnabled: @Sendable (_ sourceId: String, _ enabled: Bool) async throws -> Void

        public init(
            isCurrentSession: @escaping @Sendable () async -> Bool = { true },
            sources: @escaping @Sendable () async throws -> [SourceRecord],
            create: @escaping @Sendable (_ sourceId: String, _ deviceId: String) async throws -> Void,
            join: @escaping @Sendable (_ sourceId: String, _ deviceId: String) async throws -> Void,
            detach: @escaping @Sendable (_ sourceId: String, _ deviceId: String) async throws -> Void,
            setEnabled: @escaping @Sendable (_ sourceId: String, _ enabled: Bool) async throws -> Void
        ) {
            self.isCurrentSession = isCurrentSession
            self.sources = sources
            self.create = create
            self.join = join
            self.detach = detach
            self.setEnabled = setEnabled
        }
    }

    static let lastMemberCode = "LAST_MEMBER"
    static let deviceNotMemberCode = "DEVICE_NOT_MEMBER"

    /// Refusals a later pass would earn identically: the source's type takes
    /// one host at a time and another device has it, this device's kind
    /// cannot host the type, or this device is revoked. Retrying spends
    /// battery to be told the same thing, so the intent is dropped.
    static let terminalRefusals: Set<String> = [
        "SOURCE_ALREADY_HOSTED",
        "DEVICE_CANNOT_HOST_TYPE",
        "DEVICE_REVOKED",
    ]

    /// Whether the gateway refused in a way a later attempt would earn
    /// identically, so the intent is dropped instead of retried forever.
    static func isTerminalRefusal(_ error: GatewayClient.Error) -> Bool {
        guard let code = error.gatewayCode else { return false }
        return terminalRefusals.contains(code)
    }

    /// The stored key predates the resume operation; it stays as written so
    /// intents an earlier build queued are still found and carried out.
    private static let key = "omnesis.localSourceRemoval.pending"
    private let defaults: KeyValueDefaults
    private let log = AppLog.make(category: "sources.membership")
    /// Callers wait for the current drain before starting their session's pass.
    private var latestActionIds: [String: [String: UUID]] = [:]
    private var draining = false
    private var drainWaiters: [CheckedContinuation<Void, Never>] = []

    public init(defaults: KeyValueDefaults = UserDefaults.standard) {
        self.defaults = defaults
    }

    /// Queues `operation` for `sourceId`, replacing whatever was queued for
    /// the same source on the same gateway. The latest tap is what this
    /// phone means; an earlier intent the gateway never saw is not owed to it.
    public func record(
        _ operation: Operation,
        sourceId: String,
        gateway: URL,
        deviceId: String,
        pairingGeneration: String? = nil,
        operationId: UUID = UUID()
    ) {
        let intent = Intent(
            gateway: gateway.absoluteString,
            sourceId: sourceId,
            deviceId: deviceId,
            pairingGeneration: pairingGeneration,
            operation: operation,
            operationId: operationId
        )
        latestActionIds[intent.gateway, default: [:]][sourceId] = operationId
        var queue = load().filter { !($0.gateway == intent.gateway && $0.sourceId == intent.sourceId) }
        queue.append(intent)
        save(queue)
    }

    /// Carry out every intent scoped to `gateway` as `deviceId`, oldest
    /// first. Returns what the pass did, so the caller can refresh its view
    /// of the source registry and answer for anything the gateway refused.
    @discardableResult
    public func reconcile(
        gateway: URL,
        deviceId: String,
        pairingGeneration: String? = nil,
        using executor: Executor
    ) async
        -> Pass {
        while draining {
            await withCheckedContinuation { drainWaiters.append($0) }
        }
        draining = true
        defer {
            draining = false
            let waiters = drainWaiters
            drainWaiters.removeAll()
            for waiter in waiters {
                waiter.resume()
            }
        }
        guard await executor.isCurrentSession() else { return Pass() }

        let gatewayKey = gateway.absoluteString
        var attempted: Set<Intent> = []
        var pass = Pass()
        // The queue is re-read each turn so an intent recorded while this
        // pass awaited the gateway is carried out by it; `attempted` stops a
        // failing intent from being retried inside the same pass.
        while let intent = load()
            .first(where: { $0.gateway == gatewayKey && !attempted.contains($0) }) {
            guard await executor.isCurrentSession() else { break }
            guard load().contains(intent) else { continue }
            attempted.insert(intent)
            if latestActionIds[intent.gateway]?[intent.sourceId] == nil, let operationId = intent.operationId {
                latestActionIds[intent.gateway, default: [:]][intent.sourceId] = operationId
            }
            let belongsToAnotherDevice = intent.deviceId.map { $0 != deviceId } ?? false
            if belongsToAnotherDevice || intent.pairingGeneration != pairingGeneration {
                log.info("Dropping a source-membership intent recorded under a previous pairing")
                retire(intent)
                continue
            }
            let settlement = await perform(intent, deviceId: deviceId, using: executor)
            guard await executor.isCurrentSession() else { break }
            guard load().contains(intent) else { continue }
            switch settlement {
            case .settled:
                retire(intent)
                pass.settled = true
            case .refused(let code):
                retire(intent)
                pass.settled = true
                pass.refusals.append(
                    Refusal(
                        sourceId: intent.sourceId,
                        operation: intent.operation,
                        code: code,
                        operationId: intent.operationId,
                        gateway: intent.gateway
                    )
                )
            case .deferred:
                break
            }
        }
        pass.refusals.removeAll {
            latestActionIds[$0.gateway]?[$0.sourceId] != $0.operationId
        }
        return pass
    }

    /// Every intent queued for `gateway`, oldest first.
    public func pending(gateway: URL) -> [Intent] {
        load().filter { $0.gateway == gateway.absoluteString }
    }

    /// How the intent ended on the gateway. Source ids are deliberately
    /// absent from logs.
    private func perform(_ intent: Intent, deviceId: String, using executor: Executor) async -> Settlement {
        switch intent.operation {
        case .detach:
            await detach(intent.sourceId, deviceId: deviceId, using: executor)
        case .resume:
            await resume(intent.sourceId, deviceId: deviceId, using: executor)
        }
    }

    private func detach(_ sourceId: String, deviceId: String, using executor: Executor) async -> Settlement {
        do {
            try await executor.detach(sourceId, deviceId)
            return .settled
        } catch GatewayClient.Error.notFound {
            return .settled
        } catch let error as GatewayClient.Error where error.gatewayCode == Self.deviceNotMemberCode {
            return .settled
        } catch let error as GatewayClient.Error where error.gatewayCode == Self.lastMemberCode {
            return await setEnabled(sourceId, false, using: executor)
        } catch let error as GatewayClient.Error where Self.isTerminalRefusal(error) {
            let code = error.gatewayCode ?? ""
            log.info("Local source detach refused for good: \(code, privacy: .public)")
            return .refused(code)
        } catch {
            log.debug("Local source detach deferred: \(String(describing: error), privacy: .private)")
            return .deferred
        }
    }

    private func resume(_ sourceId: String, deviceId: String, using executor: Executor) async -> Settlement {
        do {
            let rows = try await executor.sources()
            guard let row = rows.first(where: { $0.id == sourceId }) else {
                try await executor.create(sourceId, deviceId)
                return .settled
            }
            if !row.hosts(deviceId) {
                try await executor.join(sourceId, deviceId)
            }
            if !row.enabled {
                try await executor.setEnabled(sourceId, true)
            }
            return .settled
        } catch GatewayClient.Error.notFound {
            // A concurrent removal between listing and joining retries the
            // durable activation against the next authoritative inventory.
            return .deferred
        } catch let error as GatewayClient.Error where Self.isTerminalRefusal(error) {
            let code = error.gatewayCode ?? ""
            log.info("Local source resume refused for good: \(code, privacy: .public)")
            return .refused(code)
        } catch {
            log.debug("Local source resume deferred: \(String(describing: error), privacy: .private)")
            return .deferred
        }
    }

    private func setEnabled(_ sourceId: String, _ enabled: Bool, using executor: Executor) async -> Settlement {
        do {
            try await executor.setEnabled(sourceId, enabled)
            return .settled
        } catch GatewayClient.Error.notFound {
            return .settled
        } catch {
            log.debug("Local source enable/pause deferred: \(String(describing: error), privacy: .private)")
            return .deferred
        }
    }

    /// Retires an intent once carried out. Only an identical intent is
    /// removed: one recorded for the same source while this was in flight is
    /// newer and still owed to the gateway.
    private func retire(_ intent: Intent) {
        save(load().filter { $0 != intent })
    }

    private func load() -> [Intent] {
        guard let data = defaults.object(forKey: Self.key) as? Data else { return [] }
        guard let decoded = try? JSONDecoder().decode([Intent].self, from: data) else {
            // Nothing in an unreadable blob can be recovered, and leaving it
            // in place makes every later read fail the same way — the phone
            // would drift from its switches in silence. Drop it, loudly, so
            // a shape change shows up in the log instead.
            log.error(
                "Discarding an unreadable source-membership outbox (\(data.count, privacy: .public) bytes)"
            )
            defaults.removeObject(forKey: Self.key)
            return []
        }
        return decoded
    }

    private func save(_ intents: [Intent]) {
        if intents.isEmpty {
            defaults.removeObject(forKey: Self.key)
        } else if let data = try? JSONEncoder().encode(intents) {
            defaults.set(data, forKey: Self.key)
        }
    }
}
