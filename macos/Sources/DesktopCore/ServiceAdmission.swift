// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Optional readiness evidence must never make an otherwise readable library fail decoding.
public struct DesktopServiceAdmission: Codable, Equatable, Sendable {
    public let state: String
    public let validUntil: Double?

    public init(state: String, validUntil: Double? = nil) {
        self.state = state
        self.validUntil = validUntil
    }

    private enum CodingKeys: String, CodingKey { case state, validUntil }
    public init(from decoder: Decoder) throws {
        let fields = try? decoder.container(keyedBy: CodingKeys.self)
        let candidate = try? fields?.decode(String.self, forKey: .state)
        if let candidate, ["ready", "checking", "blocked", "unavailable"].contains(candidate) { state = candidate }
        else { state = "unavailable" }
        let deadline = try? fields?.decode(Double.self, forKey: .validUntil)
        validUntil = deadline.flatMap { value in
            value.isFinite && value.rounded() == value && value > 0 && value <= 253_402_300_799_999 ? value : nil
        }
    }
}
