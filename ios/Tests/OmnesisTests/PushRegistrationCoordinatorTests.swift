// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PushRegistrationCoordinatorTests: XCTestCase {
    private let pairing = Pairing(
        url: URL(string: "https://gateway.example.test")!,
        token: "broad-token",
        accountId: "local",
        deviceId: "device-example",
        gatewayName: "Example gateway",
        fingerprint: String(repeating: "a", count: 64)
    )

    func testDirectPlanUsesOnlyPublishedIdentityAndStoresUnifiedRegistration() async throws {
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [.json(200, "{\"transport\":\"direct-apns\"}"), .json(200, "{\"ok\":true}")]
        let coordinator = makeCoordinator(http)

        try await coordinator.register(
            pairing: pairing,
            tokenHex: String(repeating: "a", count: 64),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )

        let requests = http.gatewayRequests
        XCTAssertEqual(requests.count, 2)
        let query = try XCTUnwrap(try URLComponents(url: XCTUnwrap(requests[0].url), resolvingAgainstBaseURL: false))
        let queryValues = Dictionary(
            uniqueKeysWithValues: (query.queryItems ?? []).map { ($0.name, $0.value ?? "") }
        )
        XCTAssertEqual(
            queryValues,
            ["appId": "dev.omnesis.ios", "platform": "ios"]
        )
        XCTAssertEqual(requests[1].url?.path, "/admin/devices/device-example/push-registration")
        XCTAssertEqual(try json(requests[1]), [
            "transport": "direct-apns",
            "deviceToken": String(repeating: "a", count: 64),
            "environment": "production",
            "bundleId": "dev.omnesis.ios",
        ])
    }

    func testMissingPushPlanFallsBackToLegacyApnsRegistration() async throws {
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(404, "{\"error\":\"not_found\"}"),
            .json(200, "{\"ok\":true}"),
        ]
        let coordinator = makeCoordinator(http)

        try await coordinator.register(
            pairing: pairing,
            tokenHex: String(repeating: "e", count: 64),
            bundleId: "dev.omnesis.ios",
            environment: "sandbox"
        )

        XCTAssertEqual(http.gatewayRequests.last?.url?.path, "/admin/devices/device-example/apns-token")
        XCTAssertEqual(try json(XCTUnwrap(http.gatewayRequests.last)), [
            "deviceToken": String(repeating: "e", count: 64),
            "environment": "sandbox",
            "bundleId": "dev.omnesis.ios",
        ])
    }

    func testFailedClaimProvisionCanProbeLegacyWithoutRegisteringModernPrivateWake() async throws {
        let legacyHTTP = PushRegistrationHTTP()
        legacyHTTP.gatewayResponses = [
            .json(404, "{\"error\":\"not_found\"}"),
            .json(200, "{\"ok\":true}"),
        ]
        let legacy = makeCoordinator(legacyHTTP)

        let usedLegacy = try await legacy.registerLegacyIfPushPlanUnavailable(
            pairing: pairing,
            tokenData: Data(repeating: 0xAB, count: 32),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )
        XCTAssertTrue(usedLegacy)
        XCTAssertEqual(
            legacyHTTP.gatewayRequests.map { $0.url?.path },
            [
                "/admin/devices/device-example/push-plan",
                "/admin/devices/device-example/apns-token",
            ]
        )

        let modernHTTP = PushRegistrationHTTP()
        modernHTTP.gatewayResponses = [.json(200, "{\"transport\":\"direct-apns\"}")]
        let modern = makeCoordinator(modernHTTP)
        let usedModernFallback = try await modern.registerLegacyIfPushPlanUnavailable(
            pairing: pairing,
            tokenData: Data(repeating: 0xCD, count: 32),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )
        XCTAssertFalse(usedModernFallback)
        XCTAssertEqual(modernHTTP.gatewayRequests.count, 1)
    }

    func testRelayChallengeVerifiesThenStoresGatewayRegistration() async throws {
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"ok\":true}"),
        ]
        http.relayResponses = [.json(202, "{\"challengeId\":\"challenge-1\"}"), .json(200, "{\"credential\":\"credential-1\"}")]
        let coordinator = makeCoordinator(http)

        try await coordinator.register(
            pairing: pairing,
            tokenHex: String(repeating: "b", count: 64),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )
        try await coordinator.receiveRelayChallenge(nonce: "nonce-1", pairing: pairing)

        XCTAssertEqual(http.relayRequests.map { $0.url!.path }, ["/v1/enrol", "/v1/enrol/verify"])
        XCTAssertEqual(try json(http.relayRequests[1]), [
            "challengeId": "challenge-1",
            "nonce": "nonce-1",
        ])
        XCTAssertEqual(try json(XCTUnwrap(http.gatewayRequests.last)), [
            "transport": "relay",
            "relayUrl": "https://push.example.test",
            "credential": "credential-1",
        ])
    }

    func testChallengePersistedBeforeEnrolResponseIsConsumedAfterPendingStateCommits() async throws {
        let store = InMemoryStore()
        try store.set("nonce-fast", forKey: "push.registration.challenge-nonce.v1")
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"ok\":true}"),
        ]
        http.relayResponses = [
            .json(202, "{\"challengeId\":\"challenge-fast\"}"),
            .json(200, "{\"credential\":\"credential-fast\"}"),
        ]
        let coordinator = PushRegistrationCoordinator(
            store: store,
            gatewayRequest: http.gateway,
            relayRequest: http.relay
        )

        try await coordinator.register(
            pairing: pairing,
            tokenHex: String(repeating: "d", count: 64),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )

        XCTAssertNil(try store.get("push.registration.challenge-nonce.v1"))
        XCTAssertEqual(http.relayRequests.map { $0.url?.path }, ["/v1/enrol", "/v1/enrol/verify"])
        XCTAssertEqual(try json(XCTUnwrap(http.gatewayRequests.last)), [
            "transport": "relay",
            "relayUrl": "https://push.example.test",
            "credential": "credential-fast",
        ])
    }

    func testLostRelayChallengeIsReEnrolledAtChallengeTTL() async throws {
        let clock = MutableClock(Date(timeIntervalSince1970: 1000))
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
        ]
        http.relayResponses = [
            .json(202, "{\"challengeId\":\"challenge-lost\"}"),
            .json(202, "{\"challengeId\":\"challenge-retry\"}"),
        ]
        let coordinator = PushRegistrationCoordinator(
            store: InMemoryStore(),
            gatewayRequest: http.gateway,
            relayRequest: http.relay,
            now: clock.now
        )
        let register: () async throws -> Void = {
            try await coordinator.register(
                pairing: self.pairing,
                tokenHex: String(repeating: "f", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }

        try await register()
        clock.value.addTimeInterval(PushRegistrationCoordinator.relayChallengeTTL - 1)
        try await register()
        XCTAssertEqual(http.relayRequests.count, 1)
        clock.value.addTimeInterval(1)
        try await register()

        XCTAssertEqual(http.relayRequests.map { $0.url?.path }, ["/v1/enrol", "/v1/enrol"])
        XCTAssertEqual(http.gatewayRequests.filter { $0.url?.path.hasSuffix("/push-plan") == true }.count, 3)
    }

    func testRepairAndCarrierTokenRotationReplaceStalePendingIdentity() async throws {
        let repaired = try Pairing(
            url: XCTUnwrap(URL(string: "https://gateway-two.example.test")),
            token: "broad-token-two",
            accountId: "local",
            deviceId: "device-two",
            gatewayName: "Second gateway",
            fingerprint: String(repeating: "b", count: 64)
        )
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
        ]
        http.relayResponses = [
            .json(202, "{\"challengeId\":\"challenge-old\"}"),
            .json(202, "{\"challengeId\":\"challenge-new\"}"),
        ]
        let coordinator = makeCoordinator(http)
        try await coordinator.register(
            pairing: pairing,
            tokenHex: String(repeating: "1", count: 64),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )

        let acceptedStaleChallenge = try await coordinator.receiveRelayChallenge(
            nonce: "stale",
            pairing: repaired
        )
        XCTAssertFalse(acceptedStaleChallenge)
        try await coordinator.register(
            pairing: repaired,
            tokenHex: String(repeating: "2", count: 64),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )

        XCTAssertEqual(http.relayRequests.filter { $0.url?.path == "/v1/enrol/verify" }.count, 0)
        let enrolBodies = try http.relayRequests.map(json)
        XCTAssertEqual(enrolBodies.map { $0["token"] as? String }, [
            String(repeating: "1", count: 64),
            String(repeating: "2", count: 64),
        ])
        XCTAssertEqual(http.gatewayRequests.map { $0.value(forHTTPHeaderField: "Authorization") }, [
            "Bearer broad-token",
            "Bearer broad-token-two",
        ])
    }

    func testNinetyDayRotationPreservesOldRegistrationAndRetriesVerifiedCredential() async throws {
        let clock = MutableClock(Date(timeIntervalSince1970: 1000))
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"ok\":true}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(503, "{\"error\":\"busy\"}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"ok\":true}"),
        ]
        http.relayResponses = [
            .json(202, "{\"challengeId\":\"challenge-old\"}"),
            .json(200, "{\"credential\":\"credential-old\"}"),
            .json(202, "{\"challengeId\":\"challenge-new\"}"),
            .json(200, "{\"credential\":\"credential-new\"}"),
        ]
        let coordinator = PushRegistrationCoordinator(
            store: InMemoryStore(),
            gatewayRequest: http.gateway,
            relayRequest: http.relay,
            now: clock.now
        )
        let register: () async throws -> Void = {
            try await coordinator.register(
                pairing: self.pairing,
                tokenHex: String(repeating: "c", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }

        try await register()
        try await coordinator.receiveRelayChallenge(nonce: "old", pairing: pairing)
        clock.value.addTimeInterval(PushRegistrationCoordinator.relayRotationInterval + 1)
        try await register()
        await XCTAssertThrowsErrorAsync {
            try await coordinator.receiveRelayChallenge(nonce: "new", pairing: self.pairing)
        }
        // The verified credential was committed before the failed gateway call;
        // retry does not consume the one-shot challenge again.
        try await register()

        XCTAssertEqual(http.relayRequests.filter { $0.url?.path == "/v1/enrol/verify" }.count, 2)
        let registrations = try http.gatewayRequests
            .filter { $0.url?.path.hasSuffix("/push-registration") == true }
            .map(json)
        XCTAssertEqual(registrations.map { $0["credential"] as? String }, [
            "credential-old", "credential-new", "credential-new",
        ])
    }

    func testCompletedDirectRegistrationReplansAndMovesToRelay() async throws {
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(200, "{\"transport\":\"direct-apns\"}"),
            .json(200, "{\"ok\":true}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
        ]
        http.relayResponses = [.json(202, "{\"challengeId\":\"challenge-transition\"}")]
        let coordinator = makeCoordinator(http)
        let register: () async throws -> Void = {
            try await coordinator.register(
                pairing: self.pairing,
                tokenHex: String(repeating: "a", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }

        try await register()
        try await register()

        XCTAssertEqual(
            http.gatewayRequests.filter { $0.url?.path.hasSuffix("/push-plan") == true }.count,
            2
        )
        XCTAssertEqual(http.relayRequests.map { $0.url?.path }, ["/v1/enrol"])
    }

    func testRelayEndpointChangeInvalidatesCompletedRegistration() async throws {
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://one.example.test\"}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://one.example.test\"}"),
            .json(200, "{\"ok\":true}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://two.example.test\"}"),
        ]
        http.relayResponses = [
            .json(202, "{\"challengeId\":\"challenge-one\"}"),
            .json(200, "{\"credential\":\"credential-one\"}"),
            .json(202, "{\"challengeId\":\"challenge-two\"}"),
        ]
        let coordinator = makeCoordinator(http)

        try await coordinator.register(
            pairing: pairing,
            tokenHex: String(repeating: "a", count: 64),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )
        try await coordinator.receiveRelayChallenge(nonce: "nonce-one", pairing: pairing)
        try await coordinator.register(
            pairing: pairing,
            tokenHex: String(repeating: "a", count: 64),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )

        XCTAssertEqual(
            http.relayRequests
                .filter { $0.url?.path == "/v1/enrol" }
                .map { $0.url?.host },
            ["one.example.test", "two.example.test"]
        )
    }

    func testChallengeCannotCompleteAfterGatewaySwitchesToDirect() async throws {
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"transport\":\"direct-apns\"}"),
        ]
        http.relayResponses = [.json(202, "{\"challengeId\":\"challenge-stale\"}")]
        let coordinator = makeCoordinator(http)

        try await coordinator.register(
            pairing: pairing,
            tokenHex: String(repeating: "a", count: 64),
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )
        let accepted = try await coordinator.receiveRelayChallenge(
            nonce: "nonce-stale",
            pairing: pairing
        )

        XCTAssertFalse(accepted)
        XCTAssertEqual(http.relayRequests.map { $0.url?.path }, ["/v1/enrol"])
        XCTAssertFalse(
            http.gatewayRequests.contains { $0.url?.path.hasSuffix("/push-registration") == true }
        )
    }

    private func makeCoordinator(_ http: PushRegistrationHTTP) -> PushRegistrationCoordinator {
        PushRegistrationCoordinator(
            store: InMemoryStore(),
            gatewayRequest: http.gateway,
            relayRequest: http.relay
        )
    }

    private func json(_ request: URLRequest) throws -> [String: AnyHashable] {
        try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: AnyHashable]
        )
    }
}

final class PushRegistrationConfigurationTests: XCTestCase {
    private let pairing = Pairing(
        url: URL(string: "https://gateway.example.test")!,
        token: "broad-token",
        accountId: "local",
        deviceId: "device-example",
        gatewayName: "Example gateway",
        fingerprint: String(repeating: "a", count: 64)
    )

    func testConfigurationIsReadableBeforeAppleReturnsADeviceTokenAndRecoversAfterSetup() async throws {
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(200, #"{"transport":"unavailable","reasonCode":"no-direct-credential","reason":"missing"}"#),
            .json(200, #"{"transport":"direct-apns"}"#),
            .json(200, #"{"transport":"direct-apns"}"#),
            .json(200, #"{"ok":true}"#),
        ]
        let coordinator = makeCoordinator(http)
        let appId = "com.example.myomnesis"

        let missing = try await coordinator.configuration(pairing: pairing, appId: appId)
        let configured = try await coordinator.configuration(pairing: pairing, appId: appId)

        XCTAssertEqual(missing, .noDirectCredential)
        XCTAssertEqual(configured, .direct)
        try await coordinator.register(
            pairing: pairing,
            tokenHex: String(repeating: "a", count: 64),
            bundleId: appId,
            environment: "sandbox"
        )
        XCTAssertEqual(http.gatewayRequests.count, 4)
        for request in http.gatewayRequests.filter({ $0.url?.path.hasSuffix("/push-plan") == true }) {
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/admin/devices/device-example/push-plan")
            XCTAssertEqual(
                try URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?
                    .queryItems?.first(where: { $0.name == "appId" })?.value,
                appId
            )
            XCTAssertNil(request.httpBody)
        }
        XCTAssertEqual(
            http.gatewayRequests.last?.url?.path,
            "/admin/devices/device-example/push-registration"
        )
    }

    func testConfigurationSeparatesRelayConsentFromUnknownGateway() async throws {
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(200, #"{"transport":"unavailable","reasonCode":"relay-disabled","reason":"consent required"}"#),
            .json(404, #"{"error":"not_found"}"#),
        ]
        let coordinator = makeCoordinator(http)

        let consent = try await coordinator.configuration(pairing: pairing, appId: "dev.omnesis.ios")
        let unavailable = try await coordinator.configuration(pairing: pairing, appId: "dev.omnesis.ios")
        XCTAssertEqual(consent, .relayConsentRequired)
        XCTAssertEqual(unavailable, .planUnavailable)
    }

    func testConfigurationDoesNotDiagnoseMissingCredentialsWhenGatewayIsOffline() async {
        let coordinator = PushRegistrationCoordinator(
            store: InMemoryStore(),
            gatewayRequest: { _, _ in throw URLError(.cannotConnectToHost) },
            relayRequest: { _ in throw URLError(.cannotConnectToHost) }
        )
        do {
            _ = try await coordinator.configuration(pairing: pairing, appId: "com.example.myomnesis")
            XCTFail("an unavailable gateway cannot establish a push plan")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .cannotConnectToHost)
        }
    }

    private func makeCoordinator(_ http: PushRegistrationHTTP) -> PushRegistrationCoordinator {
        PushRegistrationCoordinator(
            store: InMemoryStore(),
            gatewayRequest: http.gateway,
            relayRequest: http.relay
        )
    }
}

extension PushRegistrationCoordinatorTests {
    func testRelayDisabledPlanKeepsCarrierTokenOnPhoneUntilConsentAndReplan() async throws {
        let store = InMemoryStore()
        let token = String(repeating: "7", count: 64)
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(
                200,
                #"{"transport":"unavailable","reasonCode":"relay-disabled","reason":"permission required"}"#
            ),
            .json(200, "{\"ok\":true}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
        ]
        http.relayResponses = [.json(202, "{\"challengeId\":\"challenge-consented\"}")]
        let coordinator = PushRegistrationCoordinator(
            store: store,
            gatewayRequest: http.gateway,
            relayRequest: http.relay
        )

        do {
            try await coordinator.register(
                pairing: pairing,
                tokenHex: token,
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
            XCTFail("expected relay consent to be required")
        } catch {
            XCTAssertEqual(
                error as? PushRegistrationError,
                .unavailable(reasonCode: "relay-disabled", reason: "permission required")
            )
        }

        XCTAssertEqual(http.gatewayRequests.map { $0.url?.path }, [
            "/admin/devices/device-example/push-plan",
        ])
        XCTAssertTrue(http.relayRequests.isEmpty)
        XCTAssertNil(try store.get("push.registration.state.v1"))

        try await coordinator.allowRelay(pairing: pairing, appId: "dev.omnesis.ios")
        XCTAssertEqual(http.gatewayRequests.last?.url?.path, "/admin/devices/device-example/push-relay-consent")
        XCTAssertEqual(try json(XCTUnwrap(http.gatewayRequests.last)), [
            "platform": "ios",
            "appId": "dev.omnesis.ios",
        ])
        XCTAssertFalse(
            String(data: http.gatewayRequests.last?.httpBody ?? Data(), encoding: .utf8)?
                .contains(token) == true
        )
        XCTAssertTrue(http.relayRequests.isEmpty)

        try await coordinator.register(
            pairing: pairing,
            tokenHex: token,
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )

        XCTAssertEqual(http.gatewayRequests.map { $0.url?.path }, [
            "/admin/devices/device-example/push-plan",
            "/admin/devices/device-example/push-relay-consent",
            "/admin/devices/device-example/push-plan",
        ])
        XCTAssertEqual(http.relayRequests.map { $0.url?.path }, ["/v1/enrol"])
        XCTAssertEqual(try json(XCTUnwrap(http.relayRequests.last))["token"] as? String, token)
    }

    func testFailedRelayConsentDoesNotReplanOrEnroll() async {
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [.json(503, "{\"error\":\"busy\"}")]
        let coordinator = makeCoordinator(http)

        await XCTAssertThrowsErrorAsync {
            try await coordinator.allowRelay(pairing: self.pairing, appId: "dev.omnesis.ios")
        }

        XCTAssertEqual(http.gatewayRequests.map { $0.url?.path }, [
            "/admin/devices/device-example/push-relay-consent",
        ])
        XCTAssertTrue(http.relayRequests.isEmpty)
    }

    func testWithdrawalClearsCompletedRelaySoReconsentEnrollsAgain() async throws {
        let http = PushRegistrationHTTP()
        http.gatewayResponses = [
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
            .json(200, "{\"ok\":true}"),
            .json(
                200,
                #"{"transport":"unavailable","reasonCode":"relay-disabled","reason":"permission required"}"#
            ),
            .json(200, "{\"ok\":true}"),
            .json(200, "{\"transport\":\"relay\",\"relayUrl\":\"https://push.example.test\"}"),
        ]
        http.relayResponses = [
            .json(202, "{\"challengeId\":\"challenge-first\"}"),
            .json(200, "{\"credential\":\"credential-first\"}"),
            .json(202, "{\"challengeId\":\"challenge-second\"}"),
        ]
        let coordinator = makeCoordinator(http)
        let register: () async throws -> Void = {
            try await coordinator.register(
                pairing: self.pairing,
                tokenHex: String(repeating: "8", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
        }

        try await register()
        try await coordinator.receiveRelayChallenge(nonce: "nonce-first", pairing: pairing)
        await XCTAssertThrowsErrorAsync { try await register() }
        try await coordinator.allowRelay(pairing: pairing, appId: "dev.omnesis.ios")
        try await register()

        XCTAssertEqual(
            http.relayRequests.filter { $0.url?.path == "/v1/enrol" }.count,
            2
        )
    }
}

private final class MutableClock: @unchecked Sendable {
    var value: Date
    init(_ value: Date) {
        self.value = value
    }

    lazy var now: PushRegistrationCoordinator.Clock = { [weak self] in self?.value ?? .distantPast }
}

private final class PushRegistrationHTTP: @unchecked Sendable {
    struct Stub { let status: Int
        let data: Data
        static func json(_ status: Int, _ body: String) -> Stub {
            Stub(status: status, data: Data(body.utf8))
        }
    }

    private let lock = NSLock()
    var gatewayResponses: [Stub] = []
    var relayResponses: [Stub] = []
    private(set) var gatewayRequests: [URLRequest] = []
    private(set) var relayRequests: [URLRequest] = []

    lazy var gateway: PushRegistrationCoordinator.GatewayRequest = { [weak self] _, request in
        guard let self else { throw PushRegistrationError.invalidResponse }
        return try self.respond(request, gateway: true)
    }

    lazy var relay: PushRegistrationCoordinator.RelayRequest = { [weak self] request in
        guard let self else { throw PushRegistrationError.invalidResponse }
        return try self.respond(request, gateway: false)
    }

    private func respond(_ request: URLRequest, gateway: Bool) throws -> (Data, URLResponse) {
        lock.lock()
        defer { lock.unlock() }
        if gateway { gatewayRequests.append(request) } else { relayRequests.append(request) }
        let stub = gateway ? gatewayResponses.removeFirst() : relayResponses.removeFirst()
        return (stub.data, HTTPURLResponse(url: request.url!, statusCode: stub.status, httpVersion: nil, headerFields: nil)!)
    }
}

private func XCTAssertThrowsErrorAsync(
    _ expression: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do { try await expression()
        XCTFail("expected error", file: file, line: line)
    } catch {}
}
