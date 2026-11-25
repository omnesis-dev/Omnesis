// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public struct DesktopRestoreImport: Decodable, Sendable {
    public let kind: String
    public let importId: String
    public let maxBytes: Int64?
    public let imported: Bool?
    public let bytes: Int64?
    public var valid: Bool {
        kind == "desktopRestoreImport" && UUID(uuidString: importId) != nil
    }

    public var selectable: Bool {
        valid && (maxBytes ?? 0) > 0 && (maxBytes ?? .max) <= 1_099_511_627_776
    }
}

public struct DesktopRestorePreview: Decodable, Sendable {
    public enum Status: String, Decodable, Sendable { case ready, needsRecoveryCode = "needs-recovery-code" }
    public struct Summary: Decodable, Sendable {
        public let documents: Int64?
        public let sources: Int64?
        public let watches: Int64?
        public let analyticsRows: Int64?
    }

    public let kind: String
    public let importId: String
    public let status: Status
    public let needsRecoveryCode: Bool
    public let hasRecoveryEnvelope: Bool
    public let confirmationId: String?
    public let protection: String?
    public let createdAt: String?
    public let version: String?
    public let includedData: [String]?
    public let consequences: [String]?
    public let summary: Summary?
    public let willCreateRecoveryCopy: Bool?
    public let willPauseModelRoles: Bool?
    public let willPauseAutomaticDeletion: Bool?
    public var confirmation: String? {
        guard kind == "desktopRestorePreview", status == .ready, !needsRecoveryCode,
              willCreateRecoveryCopy == true, willPauseModelRoles == true, willPauseAutomaticDeletion == true, let confirmationId,
              confirmationId.count == 64,
              [summary?.documents, summary?.sources, summary?.watches, summary?.analyticsRows].compactMap({ $0 })
              .allSatisfy({ $0 >= 0 && $0 <= 9_007_199_254_740_991 }),
              confirmationId.allSatisfy({ "0123456789abcdef".contains($0) }) else { return nil }
        return confirmationId
    }

    public var originalMayBeReadable: Bool {
        protection != "encrypted-payloads"
    }
}

public struct DesktopRestoreOutcome: Decodable, Sendable {
    public enum Status: String, Decodable, Sendable { case committed, rolledBack = "rolled-back" }
    public let kind: String
    public let status: Status
    public let runtimeStopped: Bool
    public let recoveryCopyRetained: Bool
    public let sourcesPaused: Int64?
    public let watchesPaused: Int64?
    public let modelRolesPaused: Bool?
    public let automaticDeletionPaused: Bool?
    public var valid: Bool {
        kind == "desktopRestoreResult" && runtimeStopped && (status == .rolledBack || recoveryCopyRetained) &&
            (status == .rolledBack || (sourcesPaused != nil && watchesPaused != nil)) &&
            (status == .rolledBack || modelRolesPaused == true) &&
            (status == .rolledBack || automaticDeletionPaused == true) &&
            (sourcesPaused ?? 0) >= 0 && (watchesPaused ?? 0) >= 0
    }
}

public struct DesktopRestoreStatus: Decodable, Sendable {
    public enum Status: String, Decodable,
        Sendable { case idle, pending, complete, rolledBack = "rolled-back", recoveryRequired = "recovery-required" }
    public let kind: String
    public let status: Status
    public let canRecover: Bool
    public let operationId: String?
    public let recoveryCopyRetained: Bool
    public let review: DesktopRestoreReview?
    private enum CodingKeys: String, CodingKey {
        case kind, status, canRecover, operationId, recoveryCopyRetained, review
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(String.self, forKey: .kind)
        status = try values.decode(Status.self, forKey: .status)
        canRecover = try values.decode(Bool.self, forKey: .canRecover)
        operationId = try values.decodeIfPresent(String.self, forKey: .operationId)
        recoveryCopyRetained = try values.decode(Bool.self, forKey: .recoveryCopyRetained)
        // The optional reference cannot prevent access to authoritative recovery status.
        let reference = try? values.decodeIfPresent(DesktopRestoreReview.self, forKey: .review)
        review = reference?.valid == true ? reference : nil
    }

    public var recoveryOperation: String? {
        guard kind == "desktopRestoreStatus", canRecover, let operationId, UUID(uuidString: operationId) != nil else { return nil }
        return operationId
    }
}

public struct DesktopRestoreReview: Decodable, Sendable {
    public struct Retention: Decodable, Sendable {
        public let sourceId: String
        public let maxAgeDays: Double
    }

    public struct Activity: Decodable, Sendable {
        public let maxAge: String?
    }

    public let version: Int
    public let modelAssignments: [String: String?]
    public let storageRetention: [Retention]
    public let activityRetention: Activity
    public var valid: Bool {
        version == 1 && modelAssignments.count <= 100 &&
            modelAssignments.allSatisfy { !$0.key.isEmpty && $0.key.utf8.count <= 256 && ($0.value?.utf8.count ?? 0) <= 4096 } &&
            storageRetention.count <= 10000 && storageRetention.allSatisfy {
                !$0.sourceId.isEmpty && $0.sourceId.utf8.count <= 4096 && $0.maxAgeDays.isFinite && $0.maxAgeDays > 0
            } && (activityRetention.maxAge?.utf8.count ?? 0) <= 4096
    }
}
