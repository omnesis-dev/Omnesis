// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Persists a per-source sync cursor on the gateway via
/// `GET/POST /sync-state/<sourceId>`.
///
/// The gateway is authoritative and refreshed at each sync cycle. The
/// in-memory cache permits continued capture while offline. On `save`, we POST first, then update the
/// cache — this prevents us from reporting a cursor as "persisted"
/// when only the in-memory copy advanced.
///
/// Sources that advance their cursor many times per second (e.g.
/// heart-rate polling on Apple Watch) should call `save` once per
/// sync page, not once per sample.
public actor CursorStore {
    private let gateway: GatewayClient
    private var cache: [String: SyncCursor] = [:]
    private var loaded: Set<String> = []
    private let log = AppLog.make(category: "collector.cursor")

    public init(gateway: GatewayClient) {
        self.gateway = gateway
    }

    /// Load the cursor for a source. On first call, fetches from the
    /// gateway; `refresh: true` refetches so member resyncs are observed.
    /// Only offline transport failures may reuse a previously loaded cursor.
    /// Without refresh, calls use cache until `save` or `invalidate`.
    public func load(for sourceId: String, refresh: Bool = false) async throws -> SyncCursor? {
        if !refresh, loaded.contains(sourceId) {
            return cache[sourceId]
        }
        do {
            let response = try await gateway.getSyncState(sourceId: sourceId)
            loaded.insert(sourceId)
            cache[sourceId] = response?.cursor
            return response?.cursor
        } catch {
            // A known cursor permits durable offline capture. Authentication,
            // server contract errors and malformed responses never fall back;
            // a successful nil response is an authoritative stream reset.
            if loaded.contains(sourceId), let transport = error as? URLError,
               [
                   .notConnectedToInternet,
                   .networkConnectionLost,
                   .cannotConnectToHost,
                   .cannotFindHost,
                   .dnsLookupFailed,
                   .timedOut,
               ].contains(transport.code) {
                return cache[sourceId]
            }
            log.warning("Cursor load failed for \(sourceId, privacy: .private): \(String(describing: error), privacy: .private)")
            throw error
        }
    }

    /// Save a cursor both on the gateway and in the local cache. If the
    /// gateway call fails, the cache is NOT updated — next `load` will
    /// re-fetch and may return the previous cursor.
    public func save(
        sourceId: String,
        cursor: SyncCursor,
        label: String? = nil,
        icon: String? = nil
    ) async throws {
        try await gateway.setSyncState(sourceId: sourceId, cursor: cursor, label: label, icon: icon)
        cache[sourceId] = cursor
        loaded.insert(sourceId)
    }

    /// Drop the cached cursor — next `load` refetches from the gateway.
    public func invalidate(sourceId: String) {
        cache.removeValue(forKey: sourceId)
        loaded.remove(sourceId)
    }
}
