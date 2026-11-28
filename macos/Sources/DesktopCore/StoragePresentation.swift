// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public struct DesktopStorageSnapshot: Decodable, Sendable {
    public let pressure: Pressure
    public let policy: Policy
    public let cleanupJobs: [CleanupJob]
    public let retention: [Retention]
    public struct Retention: Decodable, Sendable {
        public let sourceId: String
        public let maxAgeDays: Int?
    }

    public struct Pressure: Decodable, Sendable {
        public let state: String
        public let usageBytes: Int64?
        public let measuredAt: Double?
        public var message: String {
            switch state {
            case "blocked": "New information is paused to protect storage. Search remains available."
            case "warning": "Storage is running low. Review the limit or remove history you no longer need."
            case "normal": "Storage has room for new information."
            default: "Storage has not been measured. Refresh before making changes."
            }
        }
    }

    public struct Policy: Decodable, Sendable {
        public let maxBytes: Int64?
    }

    public struct CleanupJob: Decodable, Sendable, Identifiable {
        public let id: String
        public let target: String
        public let state: String
        public let removed: Int
        public let protected: Int
        public let hasPendingRemoval: Bool
        public let error: String?
        public var active: Bool {
            state == "queued" || state == "running"
        }

        public var outcome: String {
            if active { return "Removing history… \(removed) removed, \(protected) kept for safety." }
            if hasPendingRemoval { return "Cleanup needs attention. Some removal work remains. \(removed) removed so far." }
            switch state {
            case "completed": return "Cleanup complete. \(removed) removed, \(protected) kept for safety."
            case "cancelled": return "Cleanup cancelled. \(removed) already removed; these cannot be restored."
            default: return "Cleanup failed. \(removed) removed before it stopped."
            }
        }
    }

    public static func quotaBytes(gibibytes value: String) -> Int64? {
        guard let amount = Double(value), amount.isFinite, amount > 0, amount <= 8_388_607 else { return nil }
        let bytes = Int64(amount * 1_073_741_824)
        return bytes > 0 ? bytes : nil
    }

    public static func retentionDays(_ value: String) -> Int? {
        guard let days = Int(value), (1 ... 36500).contains(days) else { return nil }
        return days
    }

    public static func cutoff(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}
