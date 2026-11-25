// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

extension AdminClient {
    /// Current source impact, bound to the subsequent forget by its fingerprint.
    public func forgetDeviceImpact(id: String) async throws -> DeviceForgetImpact {
        let (data, _) = try await dispatch(
            method: "GET", path: "/admin/devices/\(retirementEncode(id))/forget-impact", body: nil
        )
        return try decodeOrThrow(DeviceForgetImpact.self, from: data)
    }

    /// Forget a device, keeping history by default after the owner reviews its source impact.
    public func forgetDevice(id: String, data: DeviceForgetData, impactFingerprint: String) async throws {
        var query = "forget=true"
        query += "&data=\(data.rawValue)"
        query += "&impactFingerprint=\(retirementEncode(impactFingerprint))"
        _ = try await dispatch(
            method: "DELETE", path: "/admin/devices/\(retirementEncode(id))?\(query)", body: nil
        )
    }

    private func retirementEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}
