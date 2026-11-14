// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A gateway running its own Tailscale device notifies the owner's phone when a device waits
/// to join (`tailscale-join`) and when one joined (`device-joined`). Every build routes both
/// and says so, through its capabilities and on each claim; a gateway without the feature
/// never sends either, so nothing changes against it. Pairing requests stay a cloud-build kind.
final class TailscaleJoinNotificationTests: XCTestCase {
    private let flags = [false, true]

    // MARK: - Routing

    func testAWaitingDeviceOpensWaitingToJoinInEveryBuild() {
        for enabled in flags {
            for payload: [String: Any] in [
                ["kind": "tailscale-join"],
                ["kind": "tailscale-join", "targetId": "tailscale-join"],
            ] {
                XCTAssertEqual(
                    PushTarget.fromUserInfo(["omnesis": payload], cloudRelayEnabled: enabled),
                    .tailscaleJoinRequests,
                    "cloud build \(enabled): \(payload)"
                )
            }
        }
        XCTAssertEqual(PushTarget.tailscaleJoinRequests.kindName, "tailscale-join")
        XCTAssertTrue(PushTarget.tailscaleJoinRequests.opensDevices)
    }

    func testAJoinedDeviceOpensDevicesInEveryBuild() {
        for enabled in flags {
            XCTAssertEqual(
                PushTarget.fromUserInfo(["omnesis": ["kind": "device-joined", "targetId": "devices"]], cloudRelayEnabled: enabled),
                .deviceJoined
            )
            XCTAssertEqual(PushTarget.fromUserInfo(["omnesis": ["kind": "device-joined"]], cloudRelayEnabled: enabled), .deviceJoined)
        }
        XCTAssertTrue(PushTarget.deviceJoined.opensDevices)
    }

    func testPairingRequestsStayGatedOnTheCloudBuild() {
        let pairing: [AnyHashable: Any] = ["omnesis": ["kind": "device-pairing", "targetId": "pairing"]]
        XCTAssertNil(PushTarget.fromUserInfo(pairing, cloudRelayEnabled: false))
        XCTAssertEqual(PushTarget.fromUserInfo(pairing, cloudRelayEnabled: true), .pairingRequests)
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
            ("device-joined", "devices", PushTarget.deviceJoined),
        ] {
            let json = #"{"id":"00000000-0000-4000-8000-000000000101","kind":"\#(kind)","targetId":"\#(targetId)","#
                + #""title":"Device waiting to join","body":"maya-laptop wants to join through Tailscale. Tap to review.","#
                + #""collapseId":"\#(kind):1","remaining":1,"route":{"kind":"\#(kind)"}}"#
            let claimed = try JSONDecoder().decode(ClaimedNotification.self, from: Data(json.utf8))
            for enabled in flags {
                XCTAssertEqual(PushTarget.fromUserInfo(claimed.userInfo, cloudRelayEnabled: enabled), expected, kind)
            }
        }
    }

    // MARK: - Claims

    func testEveryClaimSaysItRoutesTailscaleJoins() async throws {
        let seen = RequestRecorder()
        for pairing in flags {
            let claimer = try NotificationClaimer(
                baseURL: XCTUnwrap(URL(string: "https://gateway.example.test")),
                token: "omn_device",
                claimsPairingNotifications: pairing
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
        }
        let claims = seen.all.filter { $0.url?.path == "/notifications/claim" }
        XCTAssertEqual(claims.map { $0.value(forHTTPHeaderField: "X-Omnesis-Tailscale-Join-Notifications") }, ["1", "1"])
        XCTAssertEqual(claims.map { $0.value(forHTTPHeaderField: "X-Omnesis-Pairing-Notifications") }, [nil, "1"])
        let confirms = seen.all.filter { $0.url?.path == "/notifications/confirm" }
        XCTAssertEqual(confirms.count, 2)
        XCTAssertTrue(confirms.allSatisfy { $0.value(forHTTPHeaderField: "X-Omnesis-Tailscale-Join-Notifications") == nil })
    }

    // MARK: - Capabilities

    func testCapabilitiesAdvertiseTailscaleJoinsInEveryBuild() throws {
        for pairing in flags {
            let capabilities = PairingCapabilities.ios(version: "1.0.0", pairingNotifications: pairing)
            XCTAssertEqual(capabilities.tailscaleJoinNotifications, true)
            XCTAssertEqual(capabilities.jsonObject["tailscaleJoinNotifications"], .bool(true))

            // The pairing exchange body.
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(capabilities)) as? [String: Any])
            XCTAssertEqual(body["tailscaleJoinNotifications"] as? Bool, true)

            // The WebSocket hello.
            let hello = DeviceSocket.helloCommand(id: "hello-1", capabilities: capabilities)
            guard case .object(let payload)? = hello["payload"],
                  case .object(let sent)? = payload["capabilities"]
            else { return XCTFail("expected hello capabilities") }
            XCTAssertEqual(sent["tailscaleJoinNotifications"], .bool(true))
        }
        XCTAssertEqual(PairingCapabilities.ios().tailscaleJoinNotifications, true)
    }

    func testThePairExchangeAdvertisesTailscaleJoinsWithTheCloudFlagOff() async throws {
        let exchange = StubExchange()
        exchange.response = .success(DevicePairResponse(
            device: .init(id: "test-phone", name: "Test phone", kind: "ios"),
            tokenId: "generation",
            token: "omn_new",
            scopes: ["read"]
        ))
        let service = PairingService(store: InMemoryStore(), exchange: exchange, cloudRelayEnabled: false)
        _ = try await service.pairAsync(raw: #"{"v":2,"gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB"}"#)
        XCTAssertEqual(exchange.lastCapabilities?.tailscaleJoinNotifications, true)
        XCTAssertNil(exchange.lastCapabilities?.pairingNotifications)
    }

    func testCapabilitiesFromAnOlderAppStillDecode() throws {
        let encoded = try JSONEncoder().encode(PairingCapabilities.ios(version: "1.0.0"))
        var older = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(older.removeValue(forKey: "tailscaleJoinNotifications") as? Bool, true)
        let restored = try JSONDecoder().decode(PairingCapabilities.self, from: JSONSerialization.data(withJSONObject: older))
        XCTAssertNil(restored.tailscaleJoinNotifications)
        XCTAssertNil(restored.jsonObject["tailscaleJoinNotifications"])
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
