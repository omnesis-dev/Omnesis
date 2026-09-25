// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(UserNotifications)
@preconcurrency import UserNotifications

/// Abstraction over `UNUserNotificationCenter` so the schedule / cancel
/// logic in `StaleSyncReminder` is testable without spinning up the
/// real iOS notification center (which requires a host app, hits the
/// system, and rejects unsigned execution from XCTest bundles).
public protocol NotificationScheduling: Sendable {
    func authorizationStatus() async -> UNAuthorizationStatus
    func add(_ request: UNNotificationRequest) async throws
    func removePendingNotificationRequests(withIdentifiers: [String])
}

/// Default `NotificationScheduling` that forwards to the real
/// `UNUserNotificationCenter.current()`.
///
/// `UNUserNotificationCenter` is thread-safe per Apple's docs but
/// isn't formally `Sendable` in the SDK headers — hence the
/// `@unchecked` annotation.
public struct SystemNotificationScheduler: NotificationScheduling, @unchecked Sendable {
    private let center: UNUserNotificationCenter

    public init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    public func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    public func add(_ request: UNNotificationRequest) async throws {
        try await center.add(request)
    }

    public func removePendingNotificationRequests(withIdentifiers ids: [String]) {
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }
}

/// Schedules a local notification N hours after the last successful
/// Apple Health sync so the user gets nudged to reopen Omnesis if
/// background sync has stalled (typical cause: app force-quit from
/// the app switcher).
///
/// Each successful sync replaces the pending notification with a new
/// one set further out in time. If syncs stop firing the most-recently
/// scheduled notification fires on its timer — even if the app process
/// has been killed, since iOS keeps scheduled local notifications
/// alive independently of the owning app.
@available(iOS 17.0, *)
public actor StaleSyncReminder {
    /// Stable identifier so each re-schedule replaces the previous
    /// pending reminder rather than stacking them up.
    public static let identifier = "dev.omnesis.stale-health-sync"

    /// 12 hours. Health data is expected to flow continuously (heart
    /// rate, steps), so 12h of silence is rare outside the force-quit
    /// case. Tuned conservatively to avoid false-positive nags — the
    /// fastest way to get the user to mute notifications is to fire
    /// them when nothing's wrong.
    public static let defaultThreshold: TimeInterval = 12 * 3600

    private let scheduler: NotificationScheduling
    private let log = AppLog.make(category: "notifications.stale-sync")

    public init(scheduler: NotificationScheduling = SystemNotificationScheduler()) {
        self.scheduler = scheduler
    }

    /// Replace any pending stale-sync reminder with a new one set to
    /// fire `delay` seconds from now. No-op when the user denied
    /// notifications — leaving a pending request for an unauthorized
    /// app just clutters the system.
    public func scheduleReminder(after delay: TimeInterval = StaleSyncReminder.defaultThreshold) async {
        let status = await scheduler.authorizationStatus()
        guard status == .authorized || status == .provisional else {
            log.debug("Skip schedule — notifications not authorized (status=\(status.rawValue, privacy: .public))")
            return
        }

        let content = UNMutableNotificationContent()
        content.title = "Check Apple Health sync"
        content.body = "Omnesis hasn't completed a Health sync recently. Open the app to check background sync and permissions."
        content.sound = .default

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: delay, repeats: false)
        let request = UNNotificationRequest(
            identifier: Self.identifier,
            content: content,
            trigger: trigger
        )

        do {
            try await scheduler.add(request)
        } catch {
            log.warning("Failed to schedule stale-sync reminder: \(String(describing: error), privacy: .private)")
        }
    }

    /// Drop the pending reminder. Called on unpair so the user doesn't
    /// get nagged about an app they've intentionally stopped using.
    public func cancelReminder() {
        scheduler.removePendingNotificationRequests(withIdentifiers: [Self.identifier])
    }
}
#endif
