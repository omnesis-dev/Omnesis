// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import UserNotifications
import XCTest

@available(iOS 17.0, *)
final class StaleSyncReminderTests: XCTestCase {
    func testScheduleAddsRequestWithStableIdentifierWhenAuthorized() async {
        let fake = FakeNotificationScheduler(status: .authorized)
        let reminder = StaleSyncReminder(scheduler: fake)

        await reminder.scheduleReminder(after: 3600)

        XCTAssertEqual(fake.addedRequests.count, 1)
        XCTAssertEqual(fake.addedRequests.first?.identifier, StaleSyncReminder.identifier)
        XCTAssertFalse(fake.addedRequests.first?.content.title.isEmpty ?? true)
        XCTAssertFalse(fake.addedRequests.first?.content.body.isEmpty ?? true)
        XCTAssertNotNil(fake.addedRequests.first?.content.sound)
        let trigger = fake.addedRequests.first?.trigger as? UNTimeIntervalNotificationTrigger
        XCTAssertEqual(trigger?.timeInterval, 3600)
        XCTAssertFalse(trigger?.repeats ?? true)
        XCTAssertEqual(fake.addedRequests.first?.content.title, "Check Apple Health sync")
        XCTAssertEqual(
            fake.addedRequests.first?.content.body,
            "Omnesis hasn't completed a Health sync recently. Open the app to check background sync and permissions."
        )
    }

    func testScheduleProvisionalAlsoAdds() async {
        let fake = FakeNotificationScheduler(status: .provisional)
        let reminder = StaleSyncReminder(scheduler: fake)

        await reminder.scheduleReminder()

        XCTAssertEqual(fake.addedRequests.count, 1)
    }

    func testScheduleSkipsWhenDenied() async {
        let fake = FakeNotificationScheduler(status: .denied)
        let reminder = StaleSyncReminder(scheduler: fake)

        await reminder.scheduleReminder()

        XCTAssertEqual(fake.addedRequests.count, 0)
    }

    func testScheduleSkipsWhenNotDetermined() async {
        let fake = FakeNotificationScheduler(status: .notDetermined)
        let reminder = StaleSyncReminder(scheduler: fake)

        await reminder.scheduleReminder()

        XCTAssertEqual(fake.addedRequests.count, 0)
    }

    func testCancelRemovesByStableIdentifier() async {
        let fake = FakeNotificationScheduler(status: .authorized)
        let reminder = StaleSyncReminder(scheduler: fake)

        await reminder.cancelReminder()

        XCTAssertEqual(fake.removedIdentifiers, [StaleSyncReminder.identifier])
    }
}

/// Test double for `NotificationScheduling`. Lock-guarded so it stays
/// `Sendable`-safe across the actor hop inside `StaleSyncReminder`,
/// while still letting tests read the recorded state directly.
@available(iOS 17.0, *)
final class FakeNotificationScheduler: NotificationScheduling, @unchecked Sendable {
    private let lock = NSLock()
    private var _addedRequests: [UNNotificationRequest] = []
    private var _removedIdentifiers: [String] = []
    private let status: UNAuthorizationStatus

    init(status: UNAuthorizationStatus) {
        self.status = status
    }

    var addedRequests: [UNNotificationRequest] {
        lock.lock()
        defer { lock.unlock() }
        return _addedRequests
    }

    var removedIdentifiers: [String] {
        lock.lock()
        defer { lock.unlock() }
        return _removedIdentifiers
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        status
    }

    func add(_ request: UNNotificationRequest) async throws {
        lock.lock()
        defer { lock.unlock() }
        _addedRequests.append(request)
    }

    func removePendingNotificationRequests(withIdentifiers ids: [String]) {
        lock.lock()
        defer { lock.unlock() }
        _removedIdentifiers.append(contentsOf: ids)
    }
}
