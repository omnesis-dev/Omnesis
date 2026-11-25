// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public struct DesktopArtifact: Decodable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let createdAt: String
    public let bytes: Int64
    public let encrypted: Bool
    public let protection: String?
    public let format: String?
    public var createdDate: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: createdAt) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: createdAt)
    }

    public var valid: Bool {
        id.count == 64 && id.allSatisfy { "0123456789abcdef".contains($0) } &&
            ["backup", "export"].contains(kind) && bytes >= 0
    }

    public var requiresReadableContentConsent: Bool {
        !encrypted || protection != "encrypted-payloads"
    }

    public var protectionLabel: String {
        requiresReadableContentConsent ? "Some contents can be read without a recovery code." :
            "Data payloads are encrypted. Archive metadata and file names remain readable."
    }

    public var suggestedFilename: String {
        "Omnesis-\(kind == "backup" ? "backup" : "export")-\(id.prefix(12)).tar"
    }
}
