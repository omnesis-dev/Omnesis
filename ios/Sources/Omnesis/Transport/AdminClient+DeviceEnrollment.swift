// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How a device joined, under `enrollment` on `/admin/devices` rows.
public struct DeviceEnrollmentInfo: Decodable, Equatable, Sendable {
    public let method: String?
    public let signIn: String?
    public let joinedAt: Int64?

    public init(method: String?, signIn: String? = nil, joinedAt: Int64? = nil) {
        self.method = method
        self.signIn = signIn
        self.joinedAt = joinedAt
    }
}

extension AdminClient {
    public func decidePairingApproval(requestId: String, approve: Bool, trustSignIn: Bool) async throws {
        struct Decision: Encodable { let requestId: String
            let approve: Bool
            let trustSignIn: Bool
        }
        let body = try encoder.encode(Decision(requestId: requestId, approve: approve, trustSignIn: trustSignIn))
        _ = try await dispatch(method: "POST", path: "/admin/cloud-pairing/decision", body: body)
    }

    /// `/portal/approve#<requestId>` on the address this phone reaches the gateway at. A phone the
    /// gateway asks to step up reaches it through its secure address, where the passkey works.
    public func approvalPage(requestId: String) -> URL? {
        guard UUID(uuidString: requestId) != nil else { return nil }
        return StepUpRefusal.page(gateway: baseURL, path: "/portal/approve", fragment: requestId)
    }
}
