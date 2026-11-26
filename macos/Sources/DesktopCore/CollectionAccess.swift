// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public struct DesktopPermissionAction: Decodable, Equatable, Sendable {
    public enum Kind: String, Decodable,
        Sendable { case settings = "open-system-settings", retry = "retry-access", restart = "restart-collector", folder = "choose-folder" }
    public enum Category: String, Decodable,
        Sendable { case fullDiskAccess = "full-disk-access", filesAndFolders = "files-and-folders", privacySecurity = "privacy-security" }
    public let kind: Kind
    public let category: Category?
}

public struct DesktopPermissionRequirement: Decodable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Decodable, Sendable { case protectedFiles = "protected-files", selectedFolder = "selected-folder" }
    public let id: String
    public let kind: Kind
    public let summary: String
    public let scope: String
    public let blocking: Bool
    public let actions: [DesktopPermissionAction]
}

public struct DesktopPermissionObservation: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Sendable { case readable, denied, unavailable, unsupported, notRequired = "not-required" }
    public let deviceId: String
    public let descriptorId: String
    public let sourceId: String?
    public let checkedAt: String
    public let scopeDigest: String
    public let status: Status
    public let target: String
    public let requirements: [DesktopPermissionRequirement]?
    public let publicationGuard: String?
    public var evidenceDate: Date? {
        ISO8601DateFormatter().date(from: checkedAt) ?? ISO8601DateFormatter.fractional.date(from: checkedAt)
    }

    /// This is evidence for the selected source scope, never a global OS authorization.
    public var allowsCollection: Bool {
        guard target == "unverified", scopeDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              ISO8601DateFormatter().date(from: checkedAt) != nil || ISO8601DateFormatter.fractional.date(from: checkedAt) != nil
        else { return false }
        switch status {
        case .readable: return requirements?.isEmpty == false
        case .notRequired: return requirements?.isEmpty == true
        default: return false
        }
    }
}

extension ISO8601DateFormatter {
    fileprivate static var fractional: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }
}
