// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum SourcePermissionHealthStatus: String, Codable, Sendable, Equatable {
    case healthy
    case permissionDegraded = "permission-degraded"
    case backgroundAccessMissing = "background-access-missing"
    case unavailable
    case unknown

    public var isDegraded: Bool {
        self == .permissionDegraded || self == .backgroundAccessMissing || self == .unavailable
    }
}

public enum PermissionRepairAction: String, Codable, Sendable, Equatable {
    case openSourceSettings = "open-source-settings"
    case openAppSettings = "open-app-settings"
    case openSystemSettings = "open-system-settings"
    case none
}

public enum PermissionRequirement: String, Codable, Sendable, Equatable {
    case required
    case optional
}

public enum BackgroundRefreshPermissionState: Sendable, Equatable {
    case available
    case denied
    case restricted
}

/// How the app presents a degraded capability. Local only: the permission
/// report the gateway receives never carries it.
public enum PermissionPresentation: Sendable, Equatable {
    /// A problem to fix, raised on home and listed in Settings.
    case attention
    /// A choice the user made on purpose, such as a selected photo library:
    /// described where the source is configured, never flagged.
    case informational
}

public struct SourcePermissionCapability: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let state: SourcePermissionHealthStatus
    public let requirement: PermissionRequirement
    public let label: String
    public let impact: String?
    public let remediation: String?
    public let repairAction: PermissionRepairAction
    public var presentation: PermissionPresentation = .attention

    private enum CodingKeys: String, CodingKey {
        case id, state, requirement, label, impact, remediation, repairAction
    }

    public init(
        id: String,
        state: SourcePermissionHealthStatus,
        requirement: PermissionRequirement,
        label: String,
        impact: String? = nil,
        remediation: String? = nil,
        repairAction: PermissionRepairAction,
        presentation: PermissionPresentation = .attention
    ) {
        self.id = id
        self.state = state
        self.requirement = requirement
        self.label = label
        self.impact = impact
        self.remediation = remediation
        self.repairAction = repairAction
        self.presentation = presentation
    }
}

public struct SourcePermissionProblem: Sendable, Equatable {
    public let sourceId: String
    public let displayName: String
    public let capability: SourcePermissionCapability

    public init(sourceId: String, displayName: String, capability: SourcePermissionCapability) {
        self.sourceId = sourceId
        self.displayName = displayName
        self.capability = capability
    }
}

public struct SourcePermissionHealthReport: Codable, Sendable, Equatable, Identifiable {
    public let sourceId: String
    /// Source-owned UI copy. The gateway route takes source identity from the
    /// path, and `AdminClient` deliberately excludes this local-only label.
    public let displayName: String
    public let checkedAt: Date
    public let validForMs: Int
    public let capabilities: [SourcePermissionCapability]

    public var id: String {
        sourceId
    }

    public var degradedCapabilities: [SourcePermissionCapability] {
        capabilities.filter(\.state.isDegraded)
    }

    /// Degraded capabilities the app flags as problems to fix.
    public var attentionCapabilities: [SourcePermissionCapability] {
        degradedCapabilities.filter { $0.presentation == .attention }
    }

    public init(
        sourceId: String,
        displayName: String,
        checkedAt: Date = Date(),
        validForMs: Int = 36 * 60 * 60 * 1000,
        capabilities: [SourcePermissionCapability]
    ) {
        self.sourceId = sourceId
        self.displayName = displayName
        self.checkedAt = checkedAt
        self.validForMs = validForMs
        self.capabilities = capabilities
    }
}
