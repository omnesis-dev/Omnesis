// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Cancelling requests asks the real runtime to drain; it does not invent an outcome.
@MainActor
public final class DesktopBridgeReplyWaiter {
    public struct Failure: LocalizedError, Sendable {
        public let message: String
        public var errorDescription: String? {
            message
        }

        public init(_ message: String) {
            self.message = message
        }
    }

    private struct Pending {
        let ticket: UUID
        let continuation: CheckedContinuation<BridgeValue, Error>
    }

    private var pending: [String: Pending] = [:]
    private let send: (String, [String: BridgeValue]) throws -> String
    public init(send: @escaping (String, [String: BridgeValue]) throws -> String) {
        self.send = send
    }

    public func request(_ command: String, params: [String: BridgeValue] = [:]) async throws -> BridgeValue {
        try Task.checkCancellation()
        let ticket = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                do {
                    let id = try send(command, params)
                    guard pending[id] == nil else { throw Failure("Omnesis received a duplicate background request. Reopen the app.") }
                    pending[id] = Pending(ticket: ticket, continuation: continuation)
                } catch { continuation.resume(throwing: error) }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(ticket) }
        }
    }

    @discardableResult
    public func receive(_ envelope: BridgeEnvelope) -> Bool {
        guard let id = envelope.id, let request = pending.removeValue(forKey: id) else { return false }
        if envelope.ok == true { request.continuation.resume(returning: envelope.rawResult ?? .null) }
        else { request.continuation.resume(throwing: Failure(envelope.error?.message ?? "The background operation could not finish.")) }
        return true
    }

    public func failAll(_ message: String) {
        let failed = pending.values
        pending.removeAll()
        for request in failed {
            request.continuation.resume(throwing: Failure(message))
        }
    }

    private func cancel(_ ticket: UUID) {
        guard pending.values.contains(where: { $0.ticket == ticket }) else { return }
        // The original reply remains pending until cancellation/commit is acknowledged.
        do { _ = try send("cancel", [:]) }
        catch { failAll("Omnesis lost its background connection. Reopen the app before continuing.") }
    }
}
