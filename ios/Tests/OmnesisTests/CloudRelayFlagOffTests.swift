// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// With `OMNESIS_CLOUD_RELAY_ENABLED` off, pairing and the control socket behave as they
/// did before cloud connectivity existed. Each test states the flag it runs under.
final class CloudRelayFlagOffTests: XCTestCase {
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

    // MARK: - Capabilities

    func testPairingNotificationsAreAbsentFromTheWireWithTheFlagOff() throws {
        let off = PairingCapabilities.ios(version: "1.0.0", pairingNotifications: false)
        XCTAssertNil(off.pairingNotifications)
        XCTAssertNil(off.jsonObject["pairingNotifications"])
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(off)) as? [String: Any])
        XCTAssertNil(body["pairingNotifications"])
        let hello = try JSONEncoder().encode(JSONValue.object(DeviceSocket.helloCommand(id: "h", capabilities: off)))
        XCTAssertFalse(try XCTUnwrap(String(data: hello, encoding: .utf8)).contains("pairingNotifications"))

        let on = PairingCapabilities.ios(version: "1.0.0", pairingNotifications: true)
        XCTAssertEqual(on.jsonObject["pairingNotifications"], .bool(true))
        var onObject = on.jsonObject
        onObject["pairingNotifications"] = nil
        XCTAssertEqual(onObject, off.jsonObject, "The flag changes only this one field")
        XCTAssertEqual(PairingCapabilities.ios().pairingNotifications, CloudRelayFeature.enabled ? true : nil)
    }

    func testThePairExchangeAdvertisesPairingNotificationsOnlyWithTheFlagOn() async throws {
        let raw = #"{"v":2,"gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB"}"#
        for enabled in [false, true] {
            let exchange = RecordingExchange(response: response())
            let service = PairingService(store: InMemoryStore(), exchange: exchange, cloudRelayEnabled: enabled)
            _ = try await service.pairAsync(raw: raw)
            let seen = await exchange.capabilities
            XCTAssertEqual(seen.map(\.pairingNotifications), [enabled ? true : nil])
        }
    }

    // MARK: - QR parser

    func testStrictTrustModesAreUnknownModesWithTheFlagOff() throws {
        for mode in ["pinned-key-strict", "pinned-leaf-strict"] {
            let raw = strictPayload(mode)
            XCTAssertThrowsError(try PairingPayload.decode(from: raw, cloudRelayEnabled: false)) { error in
                guard case PairingPayloadError.invalidShape(let detail) = error else { return XCTFail("\(error)") }
                // What a build that never had these modes reports for any unknown mode.
                XCTAssertTrue(detail.contains("Cannot initialize Mode from invalid String value \(mode)"), detail)
                XCTAssertTrue(detail.contains("dataCorrupted"), detail)
            }
            XCTAssertNoThrow(try PairingPayload.decode(from: raw, cloudRelayEnabled: true))
        }
        let unknown = strictPayload("made-up-mode")
        for enabled in [false, true] {
            XCTAssertThrowsError(try PairingPayload.decode(from: unknown, cloudRelayEnabled: enabled)) { error in
                guard case PairingPayloadError.invalidShape = error else { return XCTFail("\(error)") }
            }
        }
    }

    /// The scan error shows the decoder's text, which names the TLS decoder's own types.
    func testAMalformedV4TrustBlockReadsAsItAlwaysHas() {
        let gateway = #""gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB""#
        func detail(_ tls: String) -> String {
            do {
                _ = try PairingPayload.decode(from: #"{"v":4,\#(gateway),"tls":\#(tls)}"#, cloudRelayEnabled: false)
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

    func testEveryOtherPayloadDecodesTheSameUnderEitherFlag() throws {
        let gateway = #""gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB""#
        let payloads = [
            #"{"v":4,\#(gateway),"tls":{"mode":"system"}}"#,
            #"{"v":4,\#(gateway),"tls":{"mode":"pinned-leaf","fingerprint":"\#(pin)"}}"#,
            #"{"v":3,\#(gateway),"fingerprint":"\#(pin)"}"#,
            #"{"v":2,\#(gateway)}"#,
            #"{"v":1,"url":"https://gateway.example.test","token":"omn_old","accountId":"device","name":"Gateway"}"#,
        ]
        for raw in payloads {
            XCTAssertEqual(
                try PairingPayload.decode(from: raw, cloudRelayEnabled: false),
                try PairingPayload.decode(from: raw, cloudRelayEnabled: true)
            )
        }
    }

    func testAStrictQrNeverReachesTheGatewayOrTheKeychainWithTheFlagOff() async throws {
        for mode in ["pinned-key-strict", "pinned-leaf-strict"] {
            let store = InMemoryStore()
            let exchange = RecordingExchange(response: response())
            let discovery = RecordingDiscovery()
            let service = PairingService(
                store: store,
                exchange: exchange,
                pinnedExchangeBuilder: { _ in exchange },
                strictPinnedExchangeBuilder: { _ in exchange },
                keyPinnedExchangeBuilder: { _, _ in exchange },
                directDiscovery: discovery,
                cloudRelayEnabled: false
            )
            do {
                _ = try await service.pairAsync(raw: strictPayload(mode))
                XCTFail("A strict QR paired with the flag off")
            } catch {
                guard case PairingPayloadError.invalidShape = error else { return XCTFail("\(error)") }
            }
            let exchanges = await exchange.capabilities
            XCTAssertTrue(exchanges.isEmpty)
            XCTAssertEqual(discovery.fetches, 0)
            XCTAssertNil(try store.get(PairingCredentialBundle.key))
            XCTAssertEqual(try service.load(), .unpaired)
        }
    }

    // MARK: - Stored pairing

    func testAStoredStrictPairingIsNotAPairingWithTheFlagOff() throws {
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
            XCTAssertNil(try PairingService(store: store, cloudRelayEnabled: false).current())
            XCTAssertEqual(try PairingService(store: store, cloudRelayEnabled: false).load(), .unpaired)
            XCTAssertEqual(try PairingService(store: store, cloudRelayEnabled: true).current()?.tlsMode, mode)
        }
    }

    // MARK: - A redeemed code is always stored

    func testASupersededPairingIsStillStoredWithTheFlagOff() async throws {
        let raw = #"{"v":2,"gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB"}"#
        for enabled in [false, true] {
            let started = expectation(description: "Exchange started")
            let exchange = HeldExchange(started: started)
            let store = InMemoryStore()
            let service = PairingService(store: store, exchange: exchange, cloudRelayEnabled: enabled)
            let operation = Task { try await service.pairAsync(raw: raw) }
            await fulfillment(of: [started], timeout: 5)
            // Another pairing change lands while the gateway is redeeming the code.
            try service.clear()
            await exchange.finish(response())
            if enabled {
                do {
                    _ = try await operation.value
                    XCTFail("A superseded pairing was stored with the flag on")
                } catch { XCTAssertTrue(error is CancellationError) }
                XCTAssertNil(try service.current())
            } else {
                let paired = try await operation.value
                XCTAssertEqual(paired.token, "omn_new")
                XCTAssertEqual(try service.current(), paired)
            }
        }
    }

    func testACancelledTaskStillStoresItsRedeemedCodeWithTheFlagOff() async throws {
        let raw = #"{"v":2,"gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB"}"#
        let started = expectation(description: "Exchange started")
        let exchange = HeldExchange(started: started)
        let service = PairingService(store: InMemoryStore(), exchange: exchange, cloudRelayEnabled: false)
        let operation = Task { try await service.pairAsync(raw: raw) }
        await fulfillment(of: [started], timeout: 5)
        operation.cancel()
        await exchange.finish(response())
        let paired = try await operation.value
        XCTAssertEqual(try service.current(), paired)
    }

    @MainActor
    func testTheCoordinatorPublishesAFinishedPairingWhateverHappenedMeanwhileWithTheFlagOff() async throws {
        let raw = #"{"v":2,"gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB"}"#
        for enabled in [false, true] {
            let started = expectation(description: "Exchange started")
            let exchange = HeldExchange(started: started)
            let service = PairingService(store: InMemoryStore(), exchange: exchange, cloudRelayEnabled: enabled)
            let coordinator = PairingCoordinator(service: service)
            var errors: [String?] = []
            coordinator.setOnError { errors.append($0) }
            let operation = Task { await coordinator.pairAsync(raw: raw) }
            await fulfillment(of: [started], timeout: 5)
            coordinator.enterRepairMode()
            await exchange.finish(response())
            let paired = await operation.value
            XCTAssertEqual(try service.current()?.token, "omn_new", "The gateway redeemed the code either way")
            if enabled {
                XCTAssertNil(paired)
                XCTAssertNil(coordinator.pairing)
                XCTAssertTrue(coordinator.isRepairing)
            } else {
                XCTAssertEqual(paired?.token, "omn_new")
                XCTAssertEqual(coordinator.pairing, paired)
                XCTAssertFalse(coordinator.isRepairing)
                XCTAssertEqual(errors.last, .some(nil))
            }
        }
    }

    @MainActor
    func testTheCoordinatorReportsAFailedPairingWhateverHappenedMeanwhileWithTheFlagOff() async {
        let raw = #"{"v":2,"gatewayUrl":"https://gateway.example.test","pairingCode":"AAAA-BBBB"}"#
        let started = expectation(description: "Exchange started")
        let exchange = HeldExchange(started: started)
        let service = PairingService(store: InMemoryStore(), exchange: exchange, cloudRelayEnabled: false)
        let coordinator = PairingCoordinator(service: service)
        var errors: [String?] = []
        coordinator.setOnError { errors.append($0) }
        let operation = Task { await coordinator.pairAsync(raw: raw) }
        await fulfillment(of: [started], timeout: 5)
        coordinator.enterRepairMode()
        let before = errors.count
        await exchange.fail(URLError(.notConnectedToInternet))
        let paired = await operation.value
        XCTAssertNil(paired)
        XCTAssertEqual(errors.count, before + 1)
        XCTAssertNotNil(errors.last.flatMap { $0 })
    }

    // MARK: - Control socket

    func testTheSocketChecksTheHelloDeviceOnlyWithTheFlagOn() throws {
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
        XCTAssertNil(try pairing(generation: "generation").expectedSocketDeviceId(cloudRelayEnabled: false))
        XCTAssertEqual(try pairing(generation: "generation").expectedSocketDeviceId(cloudRelayEnabled: true), "device")
        XCTAssertNil(try pairing(generation: nil).expectedSocketDeviceId(cloudRelayEnabled: true))
        XCTAssertNil(try pairing(generation: "generation").makeSocketRoutingSession(), "A leaf-pinned pairing never routes")
    }

    func testTheSocketHasNoHeartbeatWithTheFlagOff() async throws {
        let url = try XCTUnwrap(URL(string: "https://gateway.example.test"))
        let capabilities = PairingCapabilities.ios(version: "1.0.0", pairingNotifications: false)
        func socket(_ liveness: DeviceSocket.Liveness?) -> DeviceSocket {
            DeviceSocket(gatewayUrl: url, token: "omn_token", session: .shared, capabilities: capabilities, liveness: liveness)
        }
        let off = await socket(nil).heartbeatInterval
        XCTAssertNil(off)
        let heartbeat = await socket(DeviceSocket.Liveness()).heartbeatInterval
        XCTAssertEqual(heartbeat, .seconds(20))
        let ambient = await DeviceSocket(gatewayUrl: url, token: "omn_token", session: .shared, capabilities: capabilities)
            .heartbeatInterval
        XCTAssertEqual(ambient, CloudRelayFeature.enabled ? .seconds(20) : nil)
    }

    // MARK: - Revocation

    /// A replaced pairing's token is revoked over the stored leaf pin alone, or the shared
    /// session, as before cloud connectivity: no trust upgrade, no strict mode.
    func testTheRevocationSessionIsTheOldOneWithTheFlagOff() {
        func session(_ mode: String?, fingerprint: String?, enabled: Bool) -> URLSession {
            OmnesisURLSession.revocationSession(
                tlsMode: mode,
                fingerprint: fingerprint,
                host: "gateway.example.test",
                spkiFingerprint: pin,
                directRoute: nil,
                cloudRelayEnabled: enabled
            )
        }
        XCTAssertTrue(session("system", fingerprint: nil, enabled: false) === URLSession.shared)
        XCTAssertTrue(session("legacy", fingerprint: nil, enabled: false) === URLSession.shared)
        XCTAssertTrue(session("pinned-leaf", fingerprint: nil, enabled: false) === URLSession.shared)
        XCTAssertTrue(session("pinned-key-strict", fingerprint: nil, enabled: false) === URLSession.shared)
        XCTAssertTrue(session("pinned-leaf", fingerprint: pin, enabled: false).delegate is PinnedSession)
        // A pin the cloud build's resolver refuses is still pinned, as it was.
        XCTAssertTrue(session("pinned-leaf", fingerprint: "not-hex", enabled: false).delegate is PinnedSession)
        XCTAssertTrue(session("pinned-leaf", fingerprint: "not-hex", enabled: true).delegate is RejectingTrustSession)
        XCTAssertTrue(session("pinned-key-strict", fingerprint: nil, enabled: true).delegate is PinnedSession)
    }

    // MARK: - Info.plist

    func testTheDefaultBuildDeclaresNoLocalNetworkUseAndOnlyItsOwnUrlScheme() throws {
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
            XCTAssertNil(try plist(path)["NSLocalNetworkUsageDescription"], path)
        }
        XCTAssertEqual(try schemes(plist("Info.plist")), ["omnesis"])
        // A cloud build of the demo app gets both from the same build phase as production.
        XCTAssertEqual(try schemes(plist("Info-Demo.plist")), ["omnesis-demo"])
    }

    // MARK: - Pair a device

    /// The pair sheet of a flag-off build lists `GET /admin/network-identities` and swaps the
    /// chosen host into the gateway's origin; only the flag asks the gateway for its address plan.
    func testThePairSheetListsNetworkIdentitiesWithTheFlagOff() {
        XCTAssertEqual(PairDeviceSheetStyle(cloudRelayEnabled: false), .networkIdentities)
        XCTAssertEqual(PairDeviceSheetStyle(cloudRelayEnabled: true), .addressPlan)
        XCTAssertEqual(PairDeviceSheetStyle(), CloudRelayFeature.enabled ? .addressPlan : .networkIdentities)
    }
}

/// A connected socket built the way a flag-off build builds it: no heartbeat, any device accepted.
@available(iOS 17.0, macOS 14.0, *)
final class CloudRelayFlagOffSocketTests: DeviceSocketLifecycleTestCase {
    func testAConnectedSocketArmsNoTimerAndSendsNoPing() async throws {
        await startObservingPath(wifi)
        let connection = try await connectFirstAttempt()
        await settle()
        XCTAssertEqual(connection.pings, 0)
        XCTAssertEqual(clock.requestedSleeps, [], "No heartbeat, backoff or probe was ever armed")
        XCTAssertEqual(clock.pendingSleeps, 0)
        clock.advance(by: .seconds(120))
        await settle()
        XCTAssertEqual(connection.pings, 0)
        let connected = await isConnected()
        XCTAssertTrue(connected)
    }

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

private actor RecordingExchange: PairingExchangeHTTP {
    private(set) var capabilities: [PairingCapabilities] = []
    private let response: DevicePairResponse
    init(response: DevicePairResponse) {
        self.response = response
    }

    func exchange(gatewayUrl: URL, pairingCode: String, capabilities: PairingCapabilities) async throws -> DevicePairResponse {
        self.capabilities.append(capabilities)
        return response
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

    func fail(_ error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}

private final class RecordingDiscovery: GatewayDirectDiscovering, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var fetches: Int {
        lock.withLock { count }
    }

    func fetch(origin: URL, token: String, spkiFingerprint: String) async throws -> [GatewayDirectCandidate] {
        lock.withLock { count += 1 }
        return []
    }
}
