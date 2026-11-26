// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum DesktopRecoveryCleanupMode: String, Decodable, Sendable {
    case redundantSnapshot = "redundant-snapshot", lastCopyOldEpoch = "last-copy-old-epoch", incompleteOwned = "incomplete-owned"
}

public struct DesktopRecoveryCopySummary: Decodable, Sendable {
    public let id: String
    public let purpose: DesktopRecoveryCopiesCatalog.Purpose
    public let oldVersion: String
    public let registeredAt: String
    public let bytes: Int64
    public let order: Int64
    public var date: Date? {
        ISO8601DateFormatter.recoveryCopyDate(registeredAt)
    }

    public var valid: Bool {
        id.utf8.count == 36 && UUID(uuidString: id) != nil && oldVersion.utf8.count <= 64
            && oldVersion.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil
            && date != nil && bytes >= 0 && bytes <= 9_007_199_254_740_991 && order > 0 && order <= 9_007_199_254_740_991
    }

    public var label: String {
        let reason = purpose == .update ? "Before an update" : "Before a restoration"
        return "Copy \(order.formatted()) · \(reason) · Omnesis \(oldVersion) · \(date?.formatted(date: .abbreviated, time: .shortened) ?? "Date unavailable")"
    }
}

public struct DesktopRecoveryCleanupPreview: Decodable, Sendable, Identifiable {
    public let kind: String
    public let phase: String
    public let id: String
    public let confirmationId: String
    public let bytes: Int64?
    public let mode: DesktopRecoveryCleanupMode
    public let message: String
    public let selected: DesktopRecoveryCopySummary?
    public let keeper: DesktopRecoveryCopySummary?
    public var valid: Bool {
        guard kind == "desktopRecoveryCleanup", phase == "preview", UUID(uuidString: id) != nil,
              confirmationId.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              message.utf8.count <= 2048, !message.isEmpty else { return false }
        if mode == .incompleteOwned { return bytes == nil && selected == nil && keeper == nil }
        guard let selected, selected.valid, selected.id == id, bytes == selected.bytes else { return false }
        if mode == .redundantSnapshot { return keeper?.valid == true && keeper?.id != id }
        return keeper == nil
    }
}

public struct DesktopRecoveryCleanupOutcome: Decodable, Sendable {
    public let kind: String
    public let phase: String
    public let id: String
    public let operationId: String
    public let bytes: Int64?
    public var valid: Bool {
        kind == "desktopRecoveryCleanup" && phase == "removed" && UUID(uuidString: id) != nil
            && UUID(uuidString: operationId) != nil && (bytes.map { $0 >= 0 && $0 <= 9_007_199_254_740_991 } ?? true)
    }
}

extension ISO8601DateFormatter {
    static func recoveryCopyDate(_ value: String) -> Date? {
        guard value.utf8.count <= 40 else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
