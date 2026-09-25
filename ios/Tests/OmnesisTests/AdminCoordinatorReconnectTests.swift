// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Locks down the source-meta refetch-on-reconnect behaviour: after a
/// gateway restart the device socket reconnects, and the catalogue (icons,
/// labels, brand colors) must be re-pulled so citation sticky tabs recover
/// instead of rendering the generic placeholder for the rest of the session.
///
/// The first `.connected` is already covered by `rebuildAdmin`'s initial
/// fetch, so it must NOT refetch; every subsequent reconnect must.
@available(iOS 17.0, *)
@MainActor
final class AdminCoordinatorReconnectTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var responder: ((URLRequest) throws -> (Data, URLResponse))?
        var beforeResponse: ((URLRequest) async -> Void)?
        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            await beforeResponse?(request)
            guard let responder else { throw GatewayClient.Error.invalidResponse }
            return try responder(request)
        }
    }

    private func waitFor(
        timeout: TimeInterval = 2.0,
        _ predicate: @escaping () -> Bool
    ) async
        -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return predicate()
    }

    /// Number of `/portal/source-meta.json` pulls the stub has served.
    private final class FetchCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func bump() {
            lock.lock()
            value += 1
            lock.unlock()
        }

        var count: Int {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }

    /// A stub whose catalogue never mentions `example-phone`, so a source of
    /// that type is one the registry cannot explain however often it is asked.
    private func makeSilentCatalogueClient(counter: FetchCounter) -> AdminClient {
        let session = MockSession()
        session.responder = { req in
            let path = req.url?.path ?? ""
            if path == "/portal/source-meta.json" { counter.bump() }
            let body = if path == "/portal/source-meta.json" {
                ##"{"gmail":{"icon":"https://example.com/gmail.png","label":"Gmail"}}"##
            } else {
                #"{"items":[],"pageInfo":{"hasMore":false,"limit":0}}"#
            }
            let resp = HTTPURLResponse(
                url: req.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), resp)
        }
        return AdminClient(baseURL: URL(string: "https://stub.local")!, token: "t", session: session)
    }

    private func syncStatus(for sourceId: String) -> JSONValue {
        .object(["sourceId": .string(sourceId), "state": .string("idle")])
    }

    private func makeStubClient(removedSourceIds: [String] = [], sourceItemsJSON: String = "[]") -> AdminClient {
        let session = MockSession()
        session.responder = { req in
            let path = req.url?.path ?? ""
            let items = path == "/admin/sources" ? sourceItemsJSON : "[]"
            let removedJSON = try XCTUnwrap(String(data: JSONEncoder().encode(removedSourceIds), encoding: .utf8))
            let body = if path == "/portal/source-meta.json" {
                ##"{"gmail":{"icon":"https://example.com/gmail.png","label":"Gmail","bgColor":"#2D1716","accentColor":"#EA4335"}}"##
            } else {
                // /admin/sources, /admin/devices, sync-status, descriptors —
                // empty lists are fine for this test.
                "{\"items\":\(items),\"removedSourceIds\":\(removedJSON),"
                    + "\"pageInfo\":{\"hasMore\":false,\"limit\":0}}"
            }
            let resp = HTTPURLResponse(
                url: req.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), resp)
        }
        return AdminClient(baseURL: URL(string: "https://stub.local")!, token: "t", session: session)
    }

    func testFirstConnectSkipsRefetchAndReconnectRefetches() async {
        let coord = AdminCoordinator()
        coord.injectAdminClientForTesting(makeStubClient())

        // First connect mirrors the post-rebuild socket open: rebuildAdmin
        // already fetched, so handleState must not refetch.
        coord.simulateSocketConnectedForTesting()
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(
            coord.sourceIconByType.isEmpty,
            "first connect must not refetch the catalogue"
        )

        // Reconnect (e.g. after a gateway restart) refetches.
        coord.simulateSocketConnectedForTesting()
        let populated = await waitFor { coord.sourceIconByType["gmail"] != nil }
        XCTAssertTrue(populated, "a reconnect must refetch source-meta")
        XCTAssertEqual(coord.sourceIconByType["gmail"], "https://example.com/gmail.png")
        XCTAssertEqual(coord.sourceBgColorByType["gmail"], "#2D1716")
        XCTAssertEqual(coord.sourceAccentColorByType["gmail"], "#EA4335")
    }

    func testReconnectReconcilesRemovalWithoutAnImmediateNotification() async {
        let coord = AdminCoordinator()
        coord.installPreviewState(
            sources: [PreviewMocks.sourceAppleHealth],
            statusesBySource: [:],
            deviceNames: [:],
            statusSnapshot: nil,
            indexStats: nil,
            wsState: nil,
            sourceIconByType: [:]
        )
        coord.injectAdminClientForTesting(makeStubClient(removedSourceIds: [PreviewMocks.sourceAppleHealth.id]))
        var removed: [String] = []
        coord.setOnSourcesRemoved { ids, _ in removed.append(contentsOf: ids) }
        coord.simulateSocketConnectedForTesting()
        coord.simulateSocketConnectedForTesting()
        let reconciled = await waitFor { !removed.isEmpty }
        XCTAssertTrue(reconciled)
        XCTAssertEqual(removed, [PreviewMocks.sourceAppleHealth.id])
        XCTAssertTrue(coord.sources.isEmpty)
    }

    func testColdReconnectUsesDurableTombstonesWithoutCachedRows() async {
        let coord = AdminCoordinator()
        let sourceId = PreviewMocks.sourceAppleHealth.id
        coord.injectAdminClientForTesting(makeStubClient(removedSourceIds: [sourceId]))
        var removed: [String] = []
        coord.setOnSourcesRemoved { ids, _ in removed.append(contentsOf: ids) }
        await coord.refreshSources()
        XCTAssertEqual(removed, [sourceId])
    }

    func testColdRemovalCohortIsDeliveredTogether() async {
        let coord = AdminCoordinator()
        let sourceIds = [PreviewMocks.sourceAppleHealth.id, "photos:local"].sorted()
        coord.injectAdminClientForTesting(makeStubClient(removedSourceIds: sourceIds))
        var cohorts: [[String]] = []
        coord.setOnSourcesRemoved { ids, revision in
            guard coord.sourceRemovalDeliveryIsCurrent(revision) else { return }
            for id in ids {
                coord.dropSourceLocally(sourceId: id)
            }
            cohorts.append(ids)
        }
        await coord.refreshSources()
        XCTAssertEqual(cohorts, [sourceIds])
    }

    func testMissingLegacyRowDoesNotImplyRemoval() async {
        let coord = AdminCoordinator()
        coord.installPreviewState(
            sources: [PreviewMocks.sourceAppleHealth],
            statusesBySource: [:],
            deviceNames: [:],
            statusSnapshot: nil,
            indexStats: nil,
            wsState: nil,
            sourceIconByType: [:]
        )
        coord.injectAdminClientForTesting(makeStubClient())
        var removed: [String] = []
        coord.setOnSourcesRemoved { ids, _ in removed.append(contentsOf: ids) }
        await coord.refreshSources()
        XCTAssertTrue(removed.isEmpty)
    }

    func testTombstoneReadDuringActivationCannotUndoTheExplicitEnable() async {
        let coord = AdminCoordinator()
        let sourceId = PreviewMocks.sourceAppleHealth.id
        coord.injectAdminClientForTesting(makeStubClient(removedSourceIds: [sourceId]))
        var removed: [String] = []
        coord.setOnSourcesRemoved { ids, _ in removed.append(contentsOf: ids) }
        coord.beginSourceActivation(sourceId)
        await coord.refreshSources()
        XCTAssertTrue(removed.isEmpty)
        coord.endSourceActivation(sourceId)
        await coord.refreshSources()
        XCTAssertEqual(removed, [sourceId], "an activation that left the tombstone is still reconciled")
    }

    func testDurableResumeProtectsColdRefreshBeyondTheActivationCall() async {
        let coord = AdminCoordinator()
        let sourceId = PreviewMocks.sourceAppleHealth.id
        coord.setPendingSourceResumes([sourceId])
        coord.injectAdminClientForTesting(makeStubClient(removedSourceIds: [sourceId]))
        var removed: [String] = []
        coord.setOnSourcesRemoved { ids, _ in removed.append(contentsOf: ids) }
        await coord.refreshSources()
        XCTAssertTrue(removed.isEmpty)
        coord.setPendingSourceResumes([])
        await coord.refreshSources()
        XCTAssertEqual(removed, [sourceId])
    }

    func testDeferredRemovalDeliveryCannotDisableALaterActivation() async {
        let coord = AdminCoordinator()
        let sourceId = PreviewMocks.sourceAppleHealth.id
        coord.injectAdminClientForTesting(makeStubClient(removedSourceIds: [sourceId]))
        var applyDelivery: (() -> Void)?
        var applied: [String] = []
        coord.setOnSourcesRemoved { ids, revision in
            applyDelivery = {
                guard coord.sourceRemovalDeliveryIsCurrent(revision) else { return }
                applied.append(contentsOf: ids)
            }
        }
        await coord.refreshSources()
        coord.beginSourceActivation(sourceId)
        applyDelivery?()
        XCTAssertTrue(applied.isEmpty)
        coord.endSourceActivation(sourceId)
        await coord.refreshSources()
        applyDelivery?()
        XCTAssertEqual(applied, [sourceId])
    }

    private actor SourceReadGate {
        private var release: CheckedContinuation<Void, Never>?
        private var observed: CheckedContinuation<Void, Never>?

        func pause() async {
            await withCheckedContinuation { continuation in
                release = continuation
                observed?.resume()
                observed = nil
            }
        }

        func waitForRead() async {
            if release != nil { return }
            await withCheckedContinuation { observed = $0 }
        }

        func resume() {
            release?.resume()
            release = nil
        }
    }

    func testActivationFencesAnOlderSourceList() async throws {
        let coord = AdminCoordinator()
        let source = PreviewMocks.sourceAppleHealth
        coord.installPreviewState(
            sources: [],
            statusesBySource: [:],
            deviceNames: [:],
            statusSnapshot: nil,
            indexStats: nil,
            wsState: nil,
            sourceIconByType: [:]
        )
        let gate = SourceReadGate()
        let session = MockSession()
        session.beforeResponse = { request in
            if request.url?.path == "/admin/sources" { await gate.pause() }
        }
        let sourceJSON = try sourceItemsJSON(source)
        session.responder = { request in
            let body = request.url?.path == "/admin/sources"
                ? "{\"items\":\(sourceJSON),\"pageInfo\":{\"hasMore\":false,\"limit\":0}}"
                : "{\"items\":[],\"pageInfo\":{\"hasMore\":false,\"limit\":0}}"
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        try coord.injectAdminClientForTesting(AdminClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test-token", session: session
        ))
        var removed: [String] = []
        coord.setOnSourcesRemoved { ids, _ in removed.append(contentsOf: ids) }
        let refresh = Task { await coord.refreshSources() }
        await gate.waitForRead()
        coord.beginSourceActivation(source.id)
        await gate.resume()
        await refresh.value
        XCTAssertTrue(coord.sources.isEmpty)
        XCTAssertTrue(removed.isEmpty)
        XCTAssertNil(coord.sourcesError)
        coord.endSourceActivation(source.id)
        session.beforeResponse = nil
        await coord.refreshSources()
        XCTAssertNil(coord.sourcesError)
        XCTAssertEqual(coord.sources.map(\.id), [source.id], "the same valid response applies after the activation fence")
    }

    private func sourceItemsJSON(_ source: SourceRecord) throws -> String {
        try XCTUnwrap(String(data: JSONSerialization.data(withJSONObject: [[
            "id": source.id, "type": source.type, "accountId": source.accountId,
            "deviceId": source.deviceId, "enabled": source.enabled,
            "config": [String: String](), "createdAt": source.createdAt, "updatedAt": source.updatedAt,
            "members": source.members,
        ]]), encoding: .utf8))
    }

    func testDelayedRemovalCommandKeepsARejoinedPhoneEnabled() async throws {
        let coord = AdminCoordinator()
        let source = PreviewMocks.sourceAppleHealth
        coord.installPreviewState(
            sources: [],
            statusesBySource: [:],
            deviceNames: [:],
            statusSnapshot: nil,
            indexStats: nil,
            wsState: nil,
            sourceIconByType: [:],
            localDeviceId: source.deviceId
        )
        try coord.injectAdminClientForTesting(makeStubClient(sourceItemsJSON: sourceItemsJSON(source)))
        var removed: [String] = []
        coord.setOnSourcesRemoved { ids, _ in removed.append(contentsOf: ids) }
        coord.simulateSourceEventForTesting(DeviceSocket.Event(
            type: "source.removed", payload: .object(["sourceId": .string(source.id)])
        ))
        let refreshed = await waitFor { !coord.sources.isEmpty }
        XCTAssertTrue(refreshed)
        XCTAssertNil(coord.sourcesError)
        XCTAssertTrue(removed.isEmpty)
    }

    func testRemovalCommandWithdrawsAMemberWhileKeepingTheSharedSourceVisible() async throws {
        let coord = AdminCoordinator()
        let source = PreviewMocks.sourceAppleHealth
        coord.installPreviewState(
            sources: [],
            statusesBySource: [:],
            deviceNames: [:],
            statusSnapshot: nil,
            indexStats: nil,
            wsState: nil,
            sourceIconByType: [:],
            localDeviceId: "departed-fixture-device"
        )
        try coord.injectAdminClientForTesting(makeStubClient(sourceItemsJSON: sourceItemsJSON(source)))
        var removed: [String] = []
        coord.setOnSourcesRemoved { ids, _ in removed.append(contentsOf: ids) }
        coord.simulateSourceEventForTesting(DeviceSocket.Event(
            type: "source.removed", payload: .object(["sourceId": .string(source.id)])
        ))
        let withdrawn = await waitFor { !removed.isEmpty }
        XCTAssertTrue(withdrawn)
        XCTAssertNil(coord.sourcesError)
        XCTAssertEqual(removed, [source.id])
        XCTAssertEqual(coord.sources.map(\.id), [source.id])
    }

    /// A source whose type the catalogue does not mention is asked about once
    /// per connection, not once per sync event.
    ///
    /// The refetch exists because the catalogue is pulled at connect and a
    /// source may finish its first sync after that. But a source that has
    /// synced and is still absent has nothing to fetch — it declares no icon,
    /// and neither does its family — and asking again on the next event, and
    /// every event after it, is a request loop for the rest of the session.
    func testAnAbsentSourceIsRefetchedOncePerConnection() async {
        let counter = FetchCounter()
        let coord = AdminCoordinator()
        coord.injectAdminClientForTesting(makeSilentCatalogueClient(counter: counter))

        coord.simulateSocketConnectedForTesting()
        coord.simulateSocketConnectedForTesting()
        let loaded = await waitFor { coord.sourceIconByType["gmail"] != nil }
        XCTAssertTrue(loaded, "the reconnect must load the catalogue")
        let afterConnect = counter.count

        for _ in 0 ..< 5 {
            coord.simulateSyncStatusBroadcastForTesting(syncStatus(for: "example-phone:local"))
            try? await Task.sleep(nanoseconds: 600_000_000)
        }

        XCTAssertEqual(
            counter.count,
            afterConnect + 1,
            "an absent source earns one refetch per connection, however many events it sends"
        )
    }

    /// A source the catalogue already explains asks for nothing.
    func testAKnownSourceNeverRefetches() async {
        let counter = FetchCounter()
        let coord = AdminCoordinator()
        coord.injectAdminClientForTesting(makeSilentCatalogueClient(counter: counter))

        coord.simulateSocketConnectedForTesting()
        coord.simulateSocketConnectedForTesting()
        _ = await waitFor { coord.sourceIconByType["gmail"] != nil }
        let afterConnect = counter.count

        coord.simulateSyncStatusBroadcastForTesting(syncStatus(for: "gmail:someone@example.com"))
        try? await Task.sleep(nanoseconds: 600_000_000)

        XCTAssertEqual(counter.count, afterConnect, "a source with an icon needs no refetch")
    }

    func testConnectionHookRunsOnInitialConnectAndReconnect() async {
        let coord = AdminCoordinator()
        var connectionCount = 0
        coord.setOnConnected { connectionCount += 1 }

        coord.simulateSocketConnectedForTesting()
        let observedInitial = await waitFor { connectionCount == 1 }
        XCTAssertTrue(observedInitial)

        coord.simulateSocketConnectedForTesting()
        let observedReconnect = await waitFor { connectionCount == 2 }
        XCTAssertTrue(observedReconnect)
    }
}
