// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Whether the paired gateway adds graph context to `POST /search`, as last
/// read from `GET /search/readiness`. One `SearchClient` talks to one
/// gateway with one token, so the answer is kept for that client and asked
/// again only after `invalidate()` — which the app calls whenever it re-reads
/// the gateway's `/status` or the device socket reconnects, the moments a
/// gateway update or restart becomes visible.
///
/// Only a conclusive answer is kept: a decoded readiness body, or a refusal
/// the gateway itself sent (an older gateway's 404, a 403). A transport
/// failure or a server error leaves the capability unknown, so the next
/// search asks again.
final class SearchGraphCapability: @unchecked Sendable {
    private let lock = NSLock()
    private var known: Bool?
    private var generation = 0

    /// The kept answer, with the generation a probe must present to store a
    /// new one. An `invalidate()` while a probe is in flight bumps the
    /// generation, so that probe's now-stale answer is discarded.
    func read() -> (value: Bool?, generation: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (known, generation)
    }

    func store(_ value: Bool, generation probed: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard probed == generation else { return }
        known = value
    }

    func invalidate() {
        lock.lock()
        defer { lock.unlock() }
        known = nil
        generation &+= 1
    }

    /// Whether a readiness failure is the gateway's own conclusive answer
    /// rather than a transient one worth asking about again.
    static func isConclusive(_ error: Error) -> Bool {
        guard let gatewayError = error as? GatewayClient.Error else { return false }
        switch gatewayError {
        case .notFound, .forbidden: return true
        default: return false
        }
    }
}
