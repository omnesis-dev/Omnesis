// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(UserNotifications)
import Foundation
import UserNotifications

/// Simulator-only empirical probe. It records what iOS retained *after* the
/// service extension returned, rather than trusting what the extension tried
/// to set before calling its content handler.
enum PushSpikeInspector {
    static func runIfRequested() {
        guard let path = ProcessInfo.processInfo.environment["PUSH_SPIKE_INSPECT_PATH"] else {
            return
        }
        Task {
            let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
            let rows = delivered.map { notification in
                let content = notification.request.content
                return Row(
                    title: content.title,
                    body: content.body,
                    badge: content.badge?.intValue,
                    interruptionLevel: name(content.interruptionLevel)
                )
            }
            let report = Report(delivered: rows)
            guard let data = try? JSONEncoder().encode(report) else { return }
            try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
    }

    private static func name(_ level: UNNotificationInterruptionLevel) -> String {
        switch level {
        case .passive: "passive"
        case .active: "active"
        case .timeSensitive: "time-sensitive"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }

    private struct Report: Encodable { let delivered: [Row] }
    private struct Row: Encodable {
        let title: String
        let body: String
        let badge: Int?
        let interruptionLevel: String
    }
}
#endif
