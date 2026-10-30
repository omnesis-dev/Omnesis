// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Safe runtime failure projection from the gateway's model-health service.
/// Provider response bodies and prompts are never included in this surface.
public struct ModelHealth: Decodable, Equatable, Sendable {
    public let warnings: [ModelHealthWarning]
    public var needsAttention: Bool {
        !warnings.isEmpty
    }

    public init(warnings: [ModelHealthWarning] = []) {
        self.warnings = warnings
    }
}

public struct ModelHealthWarning: Decodable, Equatable, Sendable, Identifiable {
    public let role: String
    public let assignment: String
    public let consecutiveFailures: Int
    public let firstFailedAt: Double
    public let lastFailedAt: Double
    /// Open string so a new gateway category remains readable by older apps.
    public let category: String
    public let message: String
    public var id: String {
        role
    }

    public init(
        role: String, assignment: String, consecutiveFailures: Int,
        firstFailedAt: Double, lastFailedAt: Double, category: String, message: String
    ) {
        self.role = role
        self.assignment = assignment
        self.consecutiveFailures = consecutiveFailures
        self.firstFailedAt = firstFailedAt
        self.lastFailedAt = lastFailedAt
        self.category = category
        self.message = message
    }
}
