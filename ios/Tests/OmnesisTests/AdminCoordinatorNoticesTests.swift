// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A `sync.status` event carries no notices. The cached ones survive routine
/// events; an event that changes a device's state drops them, so the state's
/// own notice shows at once, and the statuses are read again for the
/// gateway's words.
@available(iOS 17.0, *)
@MainActor
final class AdminCoordinatorNoticesTests: XCTestCase {
    private final class StatusSession: URLSessionLike, @unchecked Sendable {
        private let lock = NSLock()
        private var reads = 0
        let body: String
        let statusCode: Int

        init(body: String, statusCode: Int = 200) {
            self.body = body
            self.statusCode = statusCode
        }

        var statusReads: Int {
            lock.lock()
            defer { lock.unlock() }
            return reads
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            let path = request.url?.path ?? ""
            let isStatus = path == "/admin/sync/status"
            if isStatus {
                lock.lock()
                reads += 1
                lock.unlock()
            }
            let resp = HTTPURLResponse(
                url: request.url!,
                statusCode: isStatus ? statusCode : 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            let items = isStatus ? "[\(body)]" : "[]"
            let payload = #"{"items":"# + items
                + #","removedSourceIds":[],"pageInfo":{"hasMore":false,"limit":0}}"#
            return (Data(payload.utf8), resp)
        }
    }

    private let sourceId = "notes:shared"

    private func waitFor(timeout: TimeInterval = 2.0, _ predicate: @escaping () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return predicate()
    }

    private func member(
        _ deviceId: String,
        state: String,
        errorMessage: String? = nil,
        notices: [SourceNotice]
    )
        -> SourceSyncStatus {
        SourceSyncStatus(
            sourceId: sourceId,
            deviceId: deviceId,
            state: state,
            unitName: nil,
            progress: nil,
            startedAt: nil,
            lastSyncAt: nil,
            errorMessage: errorMessage,
            erroredAt: nil,
            lastUpdated: nil,
            notices: notices
        )
    }

    private let coverage = SourceNotice(
        kind: "coverage-partial",
        severity: .info,
        title: "Some history is not here"
    )

    private let failure = SourceNotice(
        kind: "error",
        severity: .error,
        title: "The last sync failed",
        detail: "Disk unreadable"
    )

    /// studio-desk is mid-sync with a coverage note; travel-laptop is either
    /// healthy or, with `travelFailed`, failed with the gateway's notice.
    private func makeCoordinator(
        session: StatusSession,
        delay: Duration = .milliseconds(10),
        travelFailed: Bool = false,
        localDeviceId: String? = nil
    )
        -> AdminCoordinator {
        let coord = AdminCoordinator()
        coord.noticeRefresher.delay = delay
        coord.injectAdminClientForTesting(
            AdminClient(
                baseURL: URL(string: "https://stub.local")!,
                token: "t",
                session: session
            )
        )
        let travel = travelFailed
            ? member("dev-travel", state: "error", errorMessage: "Disk unreadable", notices: [failure])
            : member("dev-travel", state: "synced", notices: [])
        coord.installPreviewState(
            sources: [],
            statusesBySource: [
                sourceId: SourceSyncStatus(
                    sourceId: sourceId,
                    deviceId: nil,
                    members: [
                        member("dev-studio", state: "syncing", notices: [coverage]),
                        travel,
                    ],
                    state: "syncing",
                    unitName: nil,
                    progress: nil,
                    startedAt: nil,
                    lastSyncAt: nil,
                    errorMessage: nil,
                    erroredAt: nil,
                    lastUpdated: nil
                ),
            ],
            deviceNames: [:],
            statusSnapshot: nil,
            indexStats: nil,
            wsState: nil,
            sourceIconByType: ["notes": "icon"],
            localDeviceId: localDeviceId
        )
        return coord
    }

    private func broadcast(deviceId: String, state: String, errorMessage: String? = nil) -> JSONValue {
        var payload: [String: JSONValue] = [
            "sourceId": .string(sourceId),
            "deviceId": .string(deviceId),
            "state": .string(state),
        ]
        if let errorMessage { payload["errorMessage"] = .string(errorMessage) }
        return .object(payload)
    }

    private func device(_ coord: AdminCoordinator, _ deviceId: String) -> SourceSyncStatus? {
        coord.syncStatusesBySource[sourceId]?.status(forDeviceId: deviceId)
    }

    private static let healthyRead = #"{"sourceId":"notes:shared","state":"synced"}"#

    func testAProgressTickKeepsTheNoticesAndReadsNothing() async {
        let session = StatusSession(body: Self.healthyRead)
        let coord = makeCoordinator(session: session)

        coord.simulateSyncStatusBroadcastForTesting(broadcast(deviceId: "dev-studio", state: "syncing"))
        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertEqual(device(coord, "dev-studio")?.notices, [coverage])
        XCTAssertEqual(session.statusReads, 0)
    }

    func testATransitionShowsTheStatesNoticeAtOnceThenTheGatewaysAndKeepsTheNewerState() async {
        // The read is older than the event: it still has travel-laptop synced.
        let session = StatusSession(body: """
        {"sourceId":"notes:shared","state":"synced","members":[
          {"sourceId":"notes:shared","deviceId":"dev-studio","state":"synced",
           "notices":[{"kind":"coverage-partial","severity":"info","title":"Some history is not here"}]},
          {"sourceId":"notes:shared","deviceId":"dev-travel","state":"synced",
           "notices":[{"kind":"error","severity":"error","title":"Restore disk access"}]}
        ]}
        """)
        let coord = makeCoordinator(session: session)

        coord.simulateSyncStatusBroadcastForTesting(
            broadcast(deviceId: "dev-travel", state: "error", errorMessage: "Disk unreadable")
        )
        XCTAssertNil(device(coord, "dev-travel")?.notices)
        XCTAssertEqual(device(coord, "dev-travel")?.displayNotices, [failure])

        let adopted = await waitFor {
            self.device(coord, "dev-travel")?.notices?.first?.title == "Restore disk access"
        }
        XCTAssertTrue(adopted, "a transition must read the statuses and adopt their notices")
        XCTAssertEqual(device(coord, "dev-travel")?.state, "error", "the event's state is newer than the read's")
        XCTAssertEqual(device(coord, "dev-studio")?.notices, [coverage])
    }

    func testRecoveringDropsTheOldFailureAtOnce() {
        let session = StatusSession(body: Self.healthyRead)
        let coord = makeCoordinator(session: session, delay: .seconds(5), travelFailed: true)

        coord.simulateSyncStatusBroadcastForTesting(broadcast(deviceId: "dev-travel", state: "completed"))

        XCTAssertEqual(device(coord, "dev-travel")?.state, "synced")
        XCTAssertEqual(device(coord, "dev-travel")?.displayNotices, [])
        coord.noticeRefresher.cancel()
    }

    func testABurstOfTransitionsIsOneRead() async {
        let session = StatusSession(body: Self.healthyRead)
        let coord = makeCoordinator(session: session, delay: .milliseconds(150))

        coord.simulateSyncStatusBroadcastForTesting(
            broadcast(deviceId: "dev-travel", state: "error", errorMessage: "Disk unreadable")
        )
        coord.simulateSyncStatusBroadcastForTesting(broadcast(deviceId: "dev-studio", state: "completed"))
        coord.simulateSyncStatusBroadcastForTesting(broadcast(deviceId: "dev-travel", state: "syncing"))
        try? await Task.sleep(nanoseconds: 600_000_000)

        XCTAssertEqual(session.statusReads, 1)
    }

    func testClearingTheCacheCancelsAPendingRead() async {
        let session = StatusSession(body: Self.healthyRead)
        let coord = makeCoordinator(session: session, delay: .milliseconds(150))

        coord.simulateSyncStatusBroadcastForTesting(broadcast(deviceId: "dev-travel", state: "error"))
        coord.clearCaches()
        try? await Task.sleep(nanoseconds: 400_000_000)

        XCTAssertEqual(session.statusReads, 0)
    }

    func testAFullRefreshCancelsAPendingRead() async {
        let session = StatusSession(body: Self.healthyRead)
        let coord = makeCoordinator(session: session, delay: .milliseconds(150))

        coord.simulateSyncStatusBroadcastForTesting(broadcast(deviceId: "dev-travel", state: "error"))
        await coord.refreshSources()
        try? await Task.sleep(nanoseconds: 400_000_000)

        XCTAssertEqual(session.statusReads, 1, "only the full refresh reads")
    }

    func testAFailedReadKeepsTheStatesOwnNotice() async {
        let session = StatusSession(body: Self.healthyRead, statusCode: 500)
        let coord = makeCoordinator(session: session)

        coord.simulateSyncStatusBroadcastForTesting(
            broadcast(deviceId: "dev-travel", state: "error", errorMessage: "Disk unreadable")
        )
        _ = await waitFor { session.statusReads == 1 }
        try? await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(device(coord, "dev-travel")?.displayNotices, [failure])
    }

    func testADeviceThatJoinsBeforeTheReadGetsItsNotices() async {
        let session = StatusSession(body: """
        {"sourceId":"notes:shared","state":"synced","members":[
          {"sourceId":"notes:shared","deviceId":"dev-new","state":"error",
           "notices":[{"kind":"error","severity":"error","title":"Restore disk access"}]}
        ]}
        """)
        let coord = makeCoordinator(session: session)

        coord.simulateSyncStatusBroadcastForTesting(
            broadcast(deviceId: "dev-new", state: "error", errorMessage: "Disk unreadable")
        )
        XCTAssertEqual(device(coord, "dev-new")?.displayNotices.first?.title, "The last sync failed")

        let adopted = await waitFor {
            self.device(coord, "dev-new")?.notices?.first?.title == "Restore disk access"
        }
        XCTAssertTrue(adopted)
    }

    func testThisPhonesOwnFailureShowsAtOnce() async {
        let session = StatusSession(body: Self.healthyRead)
        let coord = makeCoordinator(session: session, delay: .seconds(5), localDeviceId: "dev-travel")

        await coord.forwardLifecycle(
            .error(
                sourceId: sourceId,
                displayName: "Notes",
                message: "Disk unreadable"
            )
        )

        XCTAssertEqual(device(coord, "dev-travel")?.state, "error")
        XCTAssertEqual(device(coord, "dev-travel")?.displayNotices, [failure])
        coord.noticeRefresher.cancel()
    }
}
