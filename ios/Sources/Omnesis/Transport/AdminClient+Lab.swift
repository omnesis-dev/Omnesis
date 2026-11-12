// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

extension AdminClient {
    public func getLab() async throws -> LabSnapshot {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/lab", body: nil)
        return try decodeOrThrow(LabSnapshot.self, from: data)
    }

    public func setLabFeature(_ id: LabFeature.FeatureID, enabled: Bool) async throws -> LabSnapshot {
        struct Body: Encodable { let enabled: Bool }
        let body = try JSONEncoder().encode(Body(enabled: enabled))
        let (data, _) = try await dispatch(method: "PUT", path: "/admin/lab/\(id.rawValue)", body: body)
        return try decodeOrThrow(LabSnapshot.self, from: data)
    }
}
