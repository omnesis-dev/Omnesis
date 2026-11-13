// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

extension AdminClient {
    /// POST `/admin/sources/:id/resync` — read the whole source again in
    /// `mode`: in place deletes nothing, from scratch deletes what the
    /// source indexed first. Only a gateway whose source listing carries
    /// `resyncModes` reads the mode; an older one ignores it and deletes.
    public func resyncSource(sourceId: String, mode: SourceResyncMode) async throws {
        struct Body: Encodable { let mode: String }
        let encodedId = sourceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sourceId
        _ = try await dispatch(
            method: "POST",
            path: "/admin/sources/\(encodedId)/resync",
            body: encoder.encode(Body(mode: mode.rawValue))
        )
    }

    /// Send the requests of one resync, in order, stopping at the first
    /// that fails.
    func runResync(_ steps: [SourceResyncStep], sourceId: String) async throws {
        for step in steps {
            switch step {
            case .resync(let mode): try await resyncSource(sourceId: sourceId, mode: mode)
            case .deleteAll: try await deleteAllForSource(sourceId: sourceId)
            case .sync: try await syncSource(sourceId: sourceId)
            }
        }
    }
}
