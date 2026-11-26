// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// One immutable presentation/dispatch scope. Revocation is permanent, including an A→B→A replacement.
@MainActor
final class DesktopAPIContext: Identifiable {
    let id: UInt64
    let api: DesktopAPI
    private(set) var isCurrent = true
    private var operations: [UUID: Task<Void, Never>] = [:]
    private var cleanup: [UUID: @MainActor () async -> Void] = [:]
    private struct Request { let cancel: () -> Void
        let join: () async -> Void
    }

    private final class Completion {
        private var finished = false
        private var waiters: [CheckedContinuation<Void, Never>] = []
        func wait() async {
            guard !finished else { return }
            await withCheckedContinuation { waiters.append($0) }
        }

        func finish() {
            finished = true
            let pending = waiters
            waiters = []
            pending.forEach { $0.resume() }
        }
    }

    private var requests: [UUID: Request] = [:]
    private var predecessor: DesktopAPIContext?

    init(api: DesktopAPI, id: UInt64, predecessor: DesktopAPIContext? = nil) {
        self.api = api
        self.id = id
        self.predecessor = predecessor
    }

    func check() throws {
        try Task.checkCancellation()
        guard isCurrent else { throw CancellationError() }
    }

    /// An issuing request may supply exact-result cleanup instead of dropping a late credential.
    /// Every other request is canceled and joined before the successor dispatches.
    func perform<T>(
        discard: (@MainActor (T, DesktopAPI) async -> Void)? = nil,
        _ operation: @escaping @MainActor (DesktopAPI) async throws -> T
    ) async throws
        -> T {
        try check()
        if let previous = predecessor {
            await previous.drain()
            if predecessor === previous { predecessor = nil }
            try check()
        }
        let key = UUID()
        let cancelsRequest = discard == nil
        let task = Task { @MainActor [self] in
            try check()
            return try await operation(api)
        }
        let completion = Completion()
        requests[key] = Request(cancel: { if cancelsRequest { task.cancel() } }, join: { await completion.wait() })
        defer {
            completion.finish()
            requests.removeValue(forKey: key)
        }
        let value = try await withTaskCancellationHandler(
            operation: { try await task.value },
            onCancel: { if cancelsRequest { task.cancel() } }
        )
        do { try check() }
        catch {
            await discard?(value, api)
            throw error
        }
        return value
    }

    func request<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> T {
        try await perform { try await $0.request(method, path, body: body) }
    }

    func mutate(_ method: String, _ path: String, body: [String: Any] = [:]) async throws {
        let _: DesktopAPI.LooseReply = try await request(method, path, body: body)
    }

    @discardableResult func run(_ operation: @escaping @MainActor (DesktopAPIContext) async -> Void) -> Task<Void, Never>? {
        guard isCurrent else { return nil }
        let key = UUID()
        let task = Task { [self] in
            defer { operations.removeValue(forKey: key) }
            guard !Task.isCancelled, isCurrent else { return }
            await operation(self)
        }
        operations[key] = task
        return task
    }

    /// Only exact issuing-scope cleanup may outlive normal dispatch authority.
    func retainCleanup(_ operation: @escaping @MainActor () async -> Void) throws -> UUID {
        try check()
        let key = UUID()
        cleanup[key] = operation
        return key
    }

    func releaseCleanup(_ key: UUID) {
        cleanup.removeValue(forKey: key)
    }

    func invalidate() {
        guard isCurrent else { return }
        isCurrent = false
        operations.values.forEach { $0.cancel() }
        requests.values.forEach { $0.cancel() }
        let retiring = cleanup
        cleanup = [:]
        for (key, operation) in retiring {
            operations[key] = Task { [self] in
                await operation()
                operations.removeValue(forKey: key)
            }
        }
    }

    func drain() async {
        if let previous = predecessor {
            await previous.drain()
            if predecessor === previous { predecessor = nil }
        }
        for operation in Array(operations.values) {
            await operation.value
        }
        for request in Array(requests.values) {
            await request.join()
        }
    }
}
