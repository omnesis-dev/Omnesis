// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public struct DesktopRecoveryStatus: Decodable, Sendable {
    public let available: Bool
    public let hasEnvelope: Bool
    public let envelopeValid: Bool
}

public struct DesktopRecoveryDraft: Decodable, Sendable {
    public let draftId: String
    public let expiresAt: Double
    public let recoveryCode: String
    public let envelope: BridgeValue
    public var expired: Bool {
        Date().timeIntervalSince1970 * 1000 >= expiresAt
    }

    public func envelopeData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(envelope)
    }
}

public struct DesktopRecoveryCommit: Decodable, Sendable {
    public let saved: Bool
}

public struct DesktopRecoveryImportOutcome: Decodable, Sendable {
    public let kind: String
    public let status: String
    public var verified: Bool {
        kind == "desktopRecoveryImport" && ["restored", "already-available"].contains(status)
    }
}
