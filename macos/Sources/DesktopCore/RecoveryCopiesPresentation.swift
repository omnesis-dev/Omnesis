// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public struct DesktopRecoveryCopiesCatalog: Decodable, Sendable {
    public let kind: String
    public let limit: Int
    public let items: [Copy]
    public let partialCopies: [PartialCopy]
    public let pending: Pending?
    public let unregisteredCopies: Int

    public struct Copy: Decodable, Sendable, Identifiable {
        public let id: String
        public let purpose: Purpose
        public let oldVersion: String
        public let registeredAt: String
        public let bytes: Int64
        public let pinned: Bool
        public let order: Int64
        public let disposition: Disposition
        public let canReview: Bool
        public var retainedDate: Date? {
            ISO8601DateFormatter.recoveryCopyDate(registeredAt)
        }

        public var protectionLabel: String {
            switch disposition {
            case .pinned: "Kept by your choice"
            case .currentOperation: "Needed for the current update or restoration"
            case .latest: "Latest recovery copy is kept"
            case .redundantSnapshot: "An additional recovery copy is kept"
            case .lastCopyOldEpoch: "Kept for an earlier copy of Omnesis"
            case .unavailable: "Copy unavailable; its saved record is kept"
            }
        }
    }

    public struct PartialCopy: Decodable, Sendable {
        public let id: String
        public let purpose: Purpose
        public let staging: Bool
        public let ownership: Ownership
        public let canReview: Bool
    }

    public struct Pending: Decodable, Sendable {
        public let id: String
        public let phase: Phase
        public let canCancel: Bool
        public let snapshotId: String?
        public let staging: Bool?
        public let mode: DesktopRecoveryCleanupMode?
        public let keeperId: String?
        public var hasCleanupBinding: Bool {
            snapshotId.map { UUID(uuidString: $0) != nil } == true && staging != nil && mode != nil
                && (mode != .redundantSnapshot || (keeperId.map { UUID(uuidString: $0) != nil && $0 != snapshotId } == true))
        }

        public enum Phase: String, Decodable, Sendable { case planned, deleting }
    }

    public enum Purpose: String, Decodable, Sendable { case update, restore }
    public enum Ownership: String, Decodable, Sendable { case verified, unknown }
    public enum Disposition: String, Decodable, Sendable {
        case pinned, latest, unavailable
        case currentOperation = "current-operation", redundantSnapshot = "redundant-snapshot", lastCopyOldEpoch = "last-copy-old-epoch"
    }

    public var valid: Bool {
        kind == "desktopRecoveryCopies" && (1 ... 128).contains(limit) && items.count <= limit && partialCopies.count <= 4
            && unregisteredCopies >= 0 && Set(items.map(\.id)).count == items.count
            && items.allSatisfy { UUID(uuidString: $0.id) != nil && $0.bytes >= 0 && $0.order >= 0 && $0.oldVersion.utf8.count <= 128 }
            && partialCopies.allSatisfy { UUID(uuidString: $0.id) != nil }
            && (pending.map { UUID(uuidString: $0.id) != nil && ($0.phase != .deleting || !$0.canCancel) } ?? true)
    }
}
