// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A gateway running its own Tailscale device notifies the owner's phone when a device waits
/// to join (`tailscale-join`) and when one joined (`tailscale-joined`); one with the cloud
/// account does the same for a sign-in that waits (`device-pairing`) or joined
/// (`device-joined`). The app routes all of them and says so, through its capabilities and on
/// each claim; a gateway without either feature never sends them.
final class TailscaleJoinNotificationTests: XCTestCase {
    // MARK: - Routing

    func testAWaitingDeviceOpensWaitingToJoin() {
        for payload: [String: Any] in [
            ["kind": "tailscale-join"],
            ["kind": "tailscale-join", "targetId": "tailscale-join"],
        ] {
            XCTAssertEqual(PushTarget.fromUserInfo(["omnesis": payload]), .tailscaleJoinRequests, "\(payload)")
        }
        XCTAssertEqual(PushTarget.tailscaleJoinRequests.kindName, "tailscale-join")
        XCTAssertTrue(PushTarget.tailscaleJoinRequests.opensDevices)
    }

    func testADeviceThatJoinedThroughTailscaleOpensDevices() {
        XCTAssertEqual(PushTarget.fromUserInfo(["omnesis": ["kind": "tailscale-joined", "targetId": "devices"]]), .deviceJoined)
        XCTAssertEqual(PushTarget.fromUserInfo(["omnesis": ["kind": "tailscale-joined"]]), .deviceJoined)
        XCTAssertTrue(PushTarget.deviceJoined.opensDevices)
    }

    func testTheCloudAccountKindsRoute() {
        let pairing: [AnyHashable: Any] = ["omnesis": ["kind": "device-pairing", "targetId": "pairing"]]
        let joined: [AnyHashable: Any] = ["omnesis": ["kind": "device-joined", "targetId": "devices"]]
        XCTAssertEqual(PushTarget.fromUserInfo(pairing), .pairingRequests())
        XCTAssertEqual(PushTarget.fromUserInfo(joined), .deviceJoined)
        XCTAssertEqual(PushTarget.fromUserInfo(["omnesis": ["kind": "device-joined"]]), .deviceJoined)
        XCTAssertEqual(PushTarget.deviceJoined.kindName, "device-joined")
        XCTAssertTrue(PushTarget.pairingRequests().opensDevices)
        XCTAssertFalse(PushTarget.accessAuthorization.opensDevices)
    }

    @MainActor
    func testBothLandBesideTheDeviceListsHomeSection() {
        XCTAssertEqual(homeTab(for: .tailscaleJoinRequests), .agent)
        XCTAssertEqual(homeTab(for: .deviceJoined), .agent)
    }

    /// A claimed banner rendered on the phone carries what the tap routes on: the gateway's
    /// typed route for these kinds is the kind alone.
    func testClaimedBannersRouteOnTheirKind() throws {
        for (kind, targetId, expected) in [
            ("tailscale-join", "tailscale-join", PushTarget.tailscaleJoinRequests),
            ("tailscale-joined", "devices", PushTarget.deviceJoined),
        ] {
            let json = #"{"id":"00000000-0000-4000-8000-000000000101","kind":"\#(kind)","targetId":"\#(targetId)","#
                + #""title":"Device waiting to join","body":"maya-laptop wants to join through Tailscale. Tap to review.","#
                + #""collapseId":"\#(kind):1","remaining":1,"route":{"kind":"\#(kind)"}}"#
            let claimed = try JSONDecoder().decode(ClaimedNotification.self, from: Data(json.utf8))
            XCTAssertEqual(PushTarget.fromUserInfo(claimed.userInfo), expected, kind)
        }
    }

    // MARK: - Claims

    func testEveryClaimSaysItRoutesBothKindsOfJoin() async throws {
        let seen = RequestRecorder()
        let claimer = try NotificationClaimer(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.test")),
            token: "omn_device"
        ) { request in
            seen.append(request)
            let response = try XCTUnwrap(HTTPURLResponse(
                url: XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            ))
            return (Data(#"{"ok":true}"#.utf8), response)
        }
        _ = try? await claimer.claim()
        try await claimer.confirm(id: "00000000-0000-4000-8000-000000000101")
        let claims = seen.all.filter { $0.url?.path == "/notifications/claim" }
        XCTAssertEqual(claims.map { $0.value(forHTTPHeaderField: "X-Omnesis-Tailscale-Join-Notifications") }, ["1"])
        XCTAssertEqual(claims.map { $0.value(forHTTPHeaderField: "X-Omnesis-Pairing-Notifications") }, ["1"])
        let confirms = seen.all.filter { $0.url?.path == "/notifications/confirm" }
        XCTAssertEqual(confirms.count, 1)
        XCTAssertTrue(confirms.allSatisfy { $0.value(forHTTPHeaderField: "X-Omnesis-Tailscale-Join-Notifications") == nil })
        XCTAssertTrue(confirms.allSatisfy { $0.value(forHTTPHeaderField: "X-Omnesis-Pairing-Notifications") == nil })
    }

    // MARK: - Capabilities

    func testCapabilitiesAdvertiseBothKindsOfJoin() throws {
        let capabilities = PairingCapabilities.ios(version: "1.0.0")
        XCTAssertEqual(capabilities.tailscaleJoinNotifications, true)
        XCTAssertEqual(capabilities.pairingNotifications, true)
        XCTAssertEqual(capabilities.jsonObject["tailscaleJoinNotifications"], .bool(true))
        XCTAssertEqual(capabilities.jsonObject["pairingNotifications"], .bool(true))

        // The pairing exchange body.
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(capabilities)) as? [String: Any])
        XCTAssertEqual(body["tailscaleJoinNotifications"] as? Bool, true)
        XCTAssertEqual(body["pairingNotifications"] as? Bool, true)

        // The WebSocket hello.
        let hello = DeviceSocket.helloCommand(id: "hello-1", capabilities: capabilities)
        guard case .object(let payload)? = hello["payload"],
              case .object(let sent)? = payload["capabilities"]
        else { return XCTFail("expected hello capabilities") }
        XCTAssertEqual(sent["tailscaleJoinNotifications"], .bool(true))
        XCTAssertEqual(sent["pairingNotifications"], .bool(true))
    }

    func testThePairExchangeAdvertisesBothKindsOfJoin() async throws {
        let exchange = StubExchange()
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "test-phone", name: "Test phone", kind: "ios"),
            tokenId: "generation",
            token: "omn_new",
            scopes: ["read"]
        ))
        let service = PairingService(store: InMemoryStore(), exchange: exchange)
        _ = try await service.pairAsync(raw: #"{"v":2,"gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB"}"#)
        XCTAssertEqual(exchange.lastCapabilities?.tailscaleJoinNotifications, true)
        XCTAssertEqual(exchange.lastCapabilities?.pairingNotifications, true)
    }

    func testCapabilitiesFromAnOlderAppStillDecode() throws {
        let encoded = try JSONEncoder().encode(PairingCapabilities.ios(version: "1.0.0"))
        var older = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(older.removeValue(forKey: "tailscaleJoinNotifications") as? Bool, true)
        XCTAssertEqual(older.removeValue(forKey: "pairingNotifications") as? Bool, true)
        let restored = try JSONDecoder().decode(PairingCapabilities.self, from: JSONSerialization.data(withJSONObject: older))
        XCTAssertNil(restored.tailscaleJoinNotifications)
        XCTAssertNil(restored.pairingNotifications)
        XCTAssertNil(restored.jsonObject["tailscaleJoinNotifications"])
        XCTAssertNil(restored.jsonObject["pairingNotifications"])
    }
}

private final class RequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    var all: [URLRequest] {
        lock.withLock { requests }
    }

    func append(_ request: URLRequest) {
        lock.withLock { requests.append(request) }
    }
}
