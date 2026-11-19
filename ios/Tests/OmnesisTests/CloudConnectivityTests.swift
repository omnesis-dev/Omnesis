// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// What every build does for cloud connectivity: the strict trust modes a sign-in pairs with,
/// a pairing superseded while its code was redeemed, the control socket's device check and
/// heartbeat, and the Info.plist entries sign-in and the home-network route need.
final class CloudConnectivityTests: XCTestCase {
    private let pin = String(repeating: "ab", count: 32)

    private func strictPayload(_ mode: String) -> String {
        let key = mode == "pinned-key-strict" ? "spkiFingerprint" : "fingerprint"
        return #"{"v":4,"gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB","#
            + #""tls":{"mode":"\#(mode)","\#(key)":"\#(pin)"}}"#
    }

    private func response() -> DevicePairResponse {
        .init(
            device: .init(id: "test-phone", name: "Test phone", kind: "ios"),
            tokenId: "generation",
            token: "omn_new",
            scopes: ["read"]
        )
    }

    // MARK: - QR parser

    func testStrictTrustModesDecodeAndAnUnknownModeIsRefused() throws {
        for mode in ["pinned-key-strict", "pinned-leaf-strict"] {
            XCTAssertNoThrow(try PairingPayload.decode(from: strictPayload(mode)))
        }
        XCTAssertThrowsError(try PairingPayload.decode(from: strictPayload("made-up-mode"))) { error in
            guard case PairingPayloadError.invalidShape = error else { return XCTFail("\(error)") }
        }
    }

    /// The scan error shows the decoder's text, which names the TLS decoder's own types.
    func testAMalformedV4TrustBlockReadsAsItAlwaysHas() {
        let gateway = #""gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB""#
        func detail(_ tls: String) -> String {
            do {
                _ = try PairingPayload.decode(from: #"{"v":4,\#(gateway),"tls":\#(tls)}"#)
            } catch PairingPayloadError.invalidShape(let detail) {
                return detail
            } catch {
                return "\(error)"
            }
            return "decoded"
        }
        let unknown = detail(#"{"mode":"made-up-mode"}"#)
        XCTAssertTrue(unknown.contains("Cannot initialize Mode from invalid String value made-up-mode"), unknown)
        let missing = detail(#"{"mode":"pinned-leaf"}"#)
        // The surrounding words depend on the OS's decoding error text; the key's type name does not.
        XCTAssertTrue(missing.contains(#"CodingKeys(stringValue: "fingerprint""#), missing)
    }

    func testAStoredStrictPairingLoads() throws {
        for mode in [PairingTlsMode.pinnedKeyStrict, .pinnedLeafStrict] {
            let store = InMemoryStore()
            let bundle = PairingCredentialBundle(
                url: "https://gateway.example.test",
                token: "omn_stored",
                pairingGeneration: "generation",
                accountId: "local",
                deviceId: "device",
                name: "Gateway",
                scopes: ["read"],
                tlsMode: mode.rawValue,
                fingerprint: mode == .pinnedLeafStrict ? pin : nil,
                spkiFingerprint: mode == .pinnedKeyStrict ? pin : nil,
                directCandidates: [GatewayDirectCandidate(address: "10.0.0.4", port: 8443)]
            )
            try store.set(bundle.encoded(), forKey: PairingCredentialBundle.key)
            XCTAssertEqual(try PairingService(store: store).current()?.tlsMode, mode)
        }
    }

    // MARK: - A superseded pairing

    func testAPairingSupersededWhileItsCodeWasRedeemedIsNotStored() async throws {
        let raw = #"{"v":2,"gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB"}"#
        let started = expectation(description: "Exchange started")
        let exchange = HeldExchange(started: started)
        let service = PairingService(store: InMemoryStore(), exchange: exchange)
        let operation = Task { try await service.pairAsync(raw: raw) }
        await fulfillment(of: [started], timeout: 5)
        // Another pairing change lands while the gateway is redeeming the code.
        try service.clear()
        await exchange.finish(response())
        do {
            _ = try await operation.value
            XCTFail("A superseded pairing was stored")
        } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertNil(try service.current())
    }

    @MainActor
    func testTheCoordinatorDoesNotPublishAPairingSupersededMeanwhile() async throws {
        let raw = #"{"v":2,"gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB"}"#
        let started = expectation(description: "Exchange started")
        let exchange = HeldExchange(started: started)
        let service = PairingService(store: InMemoryStore(), exchange: exchange)
        let coordinator = PairingCoordinator(service: service)
        let operation = Task { await coordinator.pairAsync(raw: raw) }
        await fulfillment(of: [started], timeout: 5)
        coordinator.enterRepairMode()
        await exchange.finish(response())
        let paired = await operation.value
        XCTAssertEqual(try service.current()?.token, "omn_new", "The gateway redeemed the code")
        XCTAssertNil(paired)
        XCTAssertNil(coordinator.pairing)
        XCTAssertTrue(coordinator.isRepairing)
    }

    // MARK: - Control socket

    func testTheSocketChecksTheHelloDeviceOfAPairingWithAGeneration() throws {
        func pairing(generation: String?) throws -> Pairing {
            try Pairing(
                url: XCTUnwrap(URL(string: "https://gateway.example.test")),
                token: "omn_token",
                pairingGeneration: generation,
                accountId: "local",
                deviceId: "device",
                gatewayName: "Gateway",
                fingerprint: pin
            )
        }
        XCTAssertEqual(try pairing(generation: "generation").expectedSocketDeviceId(), "device")
        XCTAssertNil(try pairing(generation: nil).expectedSocketDeviceId())
        XCTAssertNil(try pairing(generation: "generation").makeSocketRoutingSession(), "A leaf-pinned pairing never routes")
    }

    func testTheSocketHasAHeartbeat() async throws {
        let url = try XCTUnwrap(URL(string: "https://gateway.example.test"))
        let capabilities = PairingCapabilities.ios(version: "1.0.0")
        let heartbeat = await DeviceSocket(gatewayUrl: url, token: "omn_token", session: .shared, capabilities: capabilities)
            .heartbeatInterval
        XCTAssertEqual(heartbeat, .seconds(20))
    }

    // MARK: - Info.plist

    /// The app and its extensions reach the gateway directly on the home network, and the app
    /// receives the Google sign-in callback on the reversed client ID.
    func testEveryBuildDeclaresLocalNetworkUseAndTheGoogleCallbackScheme() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        func plist(_ path: String) throws -> [String: Any] {
            let data = try Data(contentsOf: root.appendingPathComponent(path))
            return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        }
        func schemes(_ info: [String: Any]) -> [String] {
            (info["CFBundleURLTypes"] as? [[String: Any]] ?? []).flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        }
        let paths = ["Info.plist", "Info-Demo.plist", "Sources/OmnesisWidgets/Info.plist", "Sources/OmnesisNotificationService/Info.plist"]
        for path in paths {
            XCTAssertNotNil(try plist(path)["NSLocalNetworkUsageDescription"], path)
            XCTAssertNil(try plist(path)["OmnesisCloudRelayEnabled"], path)
        }
        XCTAssertEqual(try schemes(plist("Info.plist")), ["omnesis", "$(OMNESIS_GOOGLE_CALLBACK_SCHEME)"])
        XCTAssertEqual(try schemes(plist("Info-Demo.plist")), ["omnesis-demo", "$(OMNESIS_GOOGLE_CALLBACK_SCHEME)"])
        for path in ["Info.plist", "Info-Demo.plist"] {
            XCTAssertEqual(try plist(path)["OmnesisGoogleClientID"] as? String, "$(OMNESIS_GOOGLE_CLIENT_ID)", path)
            XCTAssertEqual(try plist(path)["OmnesisCloudRelayURL"] as? String, "$(OMNESIS_CLOUD_RELAY_URL)", path)
        }
    }

    /// The official build's sign-in identifiers: the callback scheme is the client ID reversed.
    func testTheOfficialBuildSettingsNameARelayAndAMatchingGoogleCallback() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let text = try String(contentsOf: root.appendingPathComponent("Config.xcconfig"), encoding: .utf8)
        var settings: [String: String] = [:]
        for line in text.split(separator: "\n") where !line.hasPrefix("//") && !line.hasPrefix("#") {
            let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.count == 2 { settings[parts[0]] = parts[1] }
        }
        let client = try XCTUnwrap(settings["OMNESIS_GOOGLE_CLIENT_ID"])
        XCTAssertTrue(client.hasSuffix(".apps.googleusercontent.com"), client)
        XCTAssertEqual(settings["OMNESIS_GOOGLE_CALLBACK_SCHEME"], client.split(separator: ".").reversed().joined(separator: "."))
        XCTAssertEqual(settings["OMNESIS_CLOUD_RELAY_URL"], "https:/$()/relay.omnesis.app")
        XCTAssertEqual(settings["OMNESIS_CLOUD_RELAY_RP_ID"], "relay.omnesis.app")
        XCTAssertNil(settings["OMNESIS_CLOUD_RELAY_ENABLED"])
    }
}

/// A socket with a heartbeat arms its timer once connected and pings when it fires.
@available(iOS 17.0, macOS 14.0, *)
final class CloudConnectivitySocketTests: DeviceSocketLifecycleTestCase {
    func testAHeartbeatSocketArmsItsTimerAndPings() async throws {
        await socket.stop()
        socket = try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "https://gateway.example.com:7600")),
            token: "omn_test",
            connector: connector,
            pathObserver: pathObserver,
            clock: clock,
            limits: {
                var limits = DeviceSocketReconnectPolicy.Limits()
                limits.helloTimeout = clock.helloTimeout
                return limits
            }(),
            heartbeatInterval: .seconds(20),
            randomUnit: { 0 }
        )
        await startObservingPath(wifi)
        let connection = try await connectFirstAttempt()
        await eventually("the heartbeat to be armed") { self.clock.requestedSleeps.contains(.seconds(20)) }
        clock.advance(by: .seconds(20))
        await eventually("the heartbeat ping") { connection.pings == 1 }
    }
}

private actor HeldExchange: PairingExchangeHTTP {
    private let started: XCTestExpectation
    private var continuation: CheckedContinuation<DevicePairResponse, Error>?
    init(started: XCTestExpectation) {
        self.started = started
    }

    func exchange(gatewayUrl: URL, pairingCode: String, capabilities: PairingCapabilities) async throws -> DevicePairResponse {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            started.fulfill()
        }
    }

    func finish(_ response: DevicePairResponse) {
        continuation?.resume(returning: response)
        continuation = nil
    }
}
