// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class NotificationClaimerTests: XCTestCase {
    private let baseURL = URL(string: "https://gateway.example.test:17600")!

    func testClaimFailureDiagnosticKeepsOnlyARecoverableCategory() throws {
        let store = InMemoryStore()
        let now = Date()
        let attempt = NotificationClaimDiagnostic.Attempt(startedAt: now)
        XCTAssertEqual(NotificationClaimDiagnostic.classify(URLError(.cannotConnectToHost)), .unreachable)
        XCTAssertEqual(NotificationClaimDiagnostic.classify(URLError(.serverCertificateUntrusted)), .certificate)
        XCTAssertEqual(
            NotificationClaimDiagnostic.classify(NotificationClaimerError.serverError(status: 401, body: "private")),
            .pairing
        )
        NotificationClaimDiagnostic.record(
            NotificationClaimerError.serverError(status: 401, body: "private"),
            attempt: attempt,
            keychain: store
        )
        XCTAssertEqual(NotificationClaimDiagnostic.current(at: now, keychain: store), .pairing)
        NotificationClaimDiagnostic.clear(keychain: store)
        XCTAssertNil(NotificationClaimDiagnostic.current(at: now, keychain: store))
    }

    func testSpecificClaimFailureSurvivesExtensionExpiry() {
        let store = InMemoryStore()
        let now = Date()
        let attempt = NotificationClaimDiagnostic.Attempt(startedAt: now)
        NotificationClaimDiagnostic.record(.certificate, attempt: attempt, keychain: store)
        NotificationClaimDiagnostic.recordTimeoutIfNeeded(
            claimCompleted: false,
            recordedFailure: true,
            attempt: attempt,
            keychain: store
        )
        XCTAssertEqual(NotificationClaimDiagnostic.current(at: now, keychain: store), .certificate)

        NotificationClaimDiagnostic.recordTimeoutIfNeeded(
            claimCompleted: false,
            recordedFailure: false,
            attempt: attempt,
            keychain: store
        )
        XCTAssertEqual(NotificationClaimDiagnostic.current(at: now, keychain: store), .unreachable)
    }

    func testPostClaimExpiryDoesNotInventANetworkFailure() {
        let store = InMemoryStore()
        let now = Date()
        NotificationClaimDiagnostic.recordTimeoutIfNeeded(
            claimCompleted: true,
            recordedFailure: false,
            attempt: .init(startedAt: now),
            keychain: store
        )
        XCTAssertNil(NotificationClaimDiagnostic.current(at: now, keychain: store))
    }

    func testOverlappingFailuresRemainVisibleAndExpire() {
        let store = InMemoryStore()
        let now = Date()
        let older = NotificationClaimDiagnostic.Attempt(startedAt: now.addingTimeInterval(-20))
        let newer = NotificationClaimDiagnostic.Attempt(startedAt: now.addingTimeInterval(-10))
        NotificationClaimDiagnostic.record(.certificate, attempt: newer, keychain: store)
        // The older extension finishes last; a successful claim by any other
        // extension never deletes this historical failure marker.
        NotificationClaimDiagnostic.record(.unreachable, attempt: older, keychain: store)
        XCTAssertNotNil(NotificationClaimDiagnostic.current(at: now, keychain: store))
        XCTAssertNil(NotificationClaimDiagnostic.current(at: now.addingTimeInterval(24 * 60 * 60), keychain: store))
    }

    func testClaimUsesDeviceBearerAndDecodesForwardCompatibleResponse() async throws {
        let http = MockHTTP(responses: [
            .json(200, """
            {
              "id":"del_1",
              "kind":"agent-answer",
              "targetId":"conv_1",
              "title":"Answer ready",
              "body":"The permit was approved.",
              "collapseId":"conversation:conv_1",
              "remaining":4,
              "futureTopLevel":true
            }
            """),
        ])
        let claimer = NotificationClaimer(
            baseURL: baseURL,
            token: "omn_device",
            request: http.perform
        )

        let result = try await claimer.claim()
        let claimed = try XCTUnwrap(result)

        XCTAssertEqual(claimed.id, "del_1")
        XCTAssertEqual(claimed.kind, "agent-answer")
        XCTAssertEqual(claimed.targetId, "conv_1")
        XCTAssertNil(claimed.affectedDeviceId)
        XCTAssertEqual(claimed.remaining, 4)
        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url?.path, "/notifications/claim")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_device")
        XCTAssertEqual(String(data: request.httpBody ?? Data(), encoding: .utf8), "{}")
    }

    func testClaimDecodesAffectedDeviceForSourcePermission() async throws {
        let http = MockHTTP(responses: [
            .json(200, """
            {
              "id":"del_permission",
              "kind":"source-permission",
              "targetId":"photos:local",
              "affectedDeviceId":"device_2",
              "sourceName":"Fictional Photos",
              "affectedDeviceName":"Fictional iPhone",
              "title":"Photos needs attention",
              "body":"Open Omnesis to review.",
              "collapseId":"source-permission:photos:local",
              "remaining":1
            }
            """),
        ])
        let claimer = NotificationClaimer(
            baseURL: baseURL,
            token: "omn_device",
            request: http.perform
        )

        let result = try await claimer.claim()
        let claimed = try XCTUnwrap(result)
        XCTAssertEqual(claimed.affectedDeviceId, "device_2")
        XCTAssertEqual(claimed.routingPayload, [
            "kind": "source-permission",
            "targetId": "photos:local",
            "affectedDeviceId": "device_2",
            "sourceName": "Fictional Photos",
            "affectedDeviceName": "Fictional iPhone",
        ])
        XCTAssertEqual(
            PushTarget.fromUserInfo(["omnesis": claimed.routingPayload]),
            .sourcePermission(
                sourceId: "photos:local",
                affectedDeviceId: "device_2",
                sourceName: "Fictional Photos",
                affectedDeviceName: "Fictional iPhone"
            )
        )
    }

    func testClaimAllowsLegacyResponseWithoutAffectedDeviceId() async throws {
        let http = MockHTTP(responses: [
            .json(200, """
            {
              "id":"del_legacy",
              "kind":"source-permission",
              "targetId":"photos:local",
              "title":"Photos needs attention",
              "body":"Open Omnesis to review.",
              "collapseId":"source-permission:photos:local",
              "remaining":1
            }
            """),
        ])
        let claimer = NotificationClaimer(
            baseURL: baseURL,
            token: "omn_device",
            request: http.perform
        )

        let result = try await claimer.claim()
        let claimed = try XCTUnwrap(result)
        XCTAssertNil(claimed.affectedDeviceId)
        XCTAssertNil(claimed.routingPayload["affectedDeviceId"])
    }

    func testClaimReturnsNilForNoContent() async throws {
        let http = MockHTTP(responses: [.empty(204)])
        let claimer = NotificationClaimer(baseURL: baseURL, token: "omn_device", request: http.perform)
        let claimed = try await claimer.claim()
        XCTAssertNil(claimed)
    }

    func testTypedRoutesPreserveAllSixLocalDestinations() throws {
        let cases: [(String, String, ClaimedNotificationRoute, [String: String])] = [
            (
                "agent-answer",
                #"{"kind":"agent-answer","conversationId":"conv-answer"}"#,
                .agentAnswer(conversationId: "conv-answer"),
                ["kind": "agent-answer", "targetId": "conv-answer"]
            ),
            (
                "conversation",
                #"{"kind":"conversation","conversationId":"conv-update"}"#,
                .conversation(conversationId: "conv-update"),
                ["kind": "conversation", "targetId": "conv-update"]
            ),
            (
                "brief",
                #"{"kind":"brief","briefId":"brief-fictional"}"#,
                .brief(briefId: "brief-fictional"),
                ["kind": "brief", "targetId": "brief-fictional"]
            ),
            (
                "watch",
                #"{"kind":"watch","watchId":"watch-fictional","firingKey":"watch-fictional:17"}"#,
                .watch(
                    watchId: "watch-fictional",
                    firingKey: "watch-fictional:17",
                    conversationId: nil
                ),
                ["kind": "watch-firing", "watchId": "watch-fictional", "firingKey": "watch-fictional:17"]
            ),
            (
                "needs-auth",
                #"{"kind":"needs-auth","sourceId":"fictional:account"}"#,
                .needsAuth(sourceId: "fictional:account", providerId: nil),
                ["kind": "needs-auth", "targetId": "fictional:account"]
            ),
            (
                "privacy-approval",
                #"{"kind":"privacy-approval","approvalId":"approval-fictional"}"#,
                .privacyApproval(approvalId: "approval-fictional"),
                ["kind": "privacy-approval", "targetId": "approval-fictional"]
            ),
            (
                "access-authorization",
                #"{"kind":"access-authorization"}"#,
                .accessAuthorization,
                ["kind": "access-authorization", "targetId": "access"]
            ),
        ]

        for (kind, routeJSON, expectedRoute, expectedUserInfo) in cases {
            let json = """
            {"id":"00000000-0000-4000-8000-000000000001","kind":"\(
                kind
            )","targetId":"fallback","title":"Fictional","body":"Invented body","collapseId":"fictional","remaining":1,"route":\(routeJSON)}
            """
            let claimed = try JSONDecoder().decode(ClaimedNotification.self, from: Data(json.utf8))
            XCTAssertEqual(claimed.route, expectedRoute)
            XCTAssertEqual(claimed.userInfo["omnesis"] as? [String: String], expectedUserInfo)
        }
    }

    func testMismatchedTypedRouteCannotOverrideTheFlatFallback() throws {
        let json = """
        {"id":"00000000-0000-4000-8000-000000000001","kind":"agent-answer","targetId":"conversation-fallback","title":"Fictional","body":"Invented body","collapseId":"fictional","remaining":1,"route":{"kind":"conversation","conversationId":"conversation-wrong"}}
        """
        let claimed = try JSONDecoder().decode(ClaimedNotification.self, from: Data(json.utf8))

        XCTAssertEqual(
            claimed.userInfo["omnesis"] as? [String: String],
            ["kind": "agent-answer", "targetId": "conversation-fallback"]
        )
    }

    func testFutureTypedRouteUsesTheFlatFallback() throws {
        let json = """
        {"id":"00000000-0000-4000-8000-000000000001","kind":"brief","targetId":"brief-fallback","title":"Fictional","body":"Invented body","collapseId":"fictional","remaining":1,"route":{"kind":"future-kind","futureId":"future"}}
        """
        let claimed = try JSONDecoder().decode(ClaimedNotification.self, from: Data(json.utf8))

        XCTAssertEqual(claimed.route, .unknown)
        XCTAssertEqual(
            claimed.userInfo["omnesis"] as? [String: String],
            ["kind": "brief", "targetId": "brief-fallback"]
        )
    }

    func testConfirmUsesStrictDeliveryIdBody() async throws {
        let http = MockHTTP(responses: [.json(200, "{\"ok\":true}")])
        let claimer = NotificationClaimer(baseURL: baseURL, token: "omn_device", request: http.perform)

        try await claimer.confirm(id: "del_42")

        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url?.path, "/notifications/confirm")
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String]
        )
        XCTAssertEqual(object, ["id": "del_42"])
    }

    func testClaimSurfacesServerFailureWithoutDecodingItAsContent() async {
        let http = MockHTTP(responses: [.json(403, "{\"error\":\"forbidden\"}")])
        let claimer = NotificationClaimer(baseURL: baseURL, token: "omn_device", request: http.perform)
        do {
            _ = try await claimer.claim()
            XCTFail("expected server error")
        } catch NotificationClaimerError.serverError(let status, let body) {
            XCTAssertEqual(status, 403)
            XCTAssertTrue(body.contains("forbidden"))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testClaimRejectsUnencryptedGatewayURL() async throws {
        let http = MockHTTP(responses: [])
        let claimer = try NotificationClaimer(
            baseURL: XCTUnwrap(URL(string: "http://gateway.example.test")),
            token: "omn_device",
            request: http.perform
        )

        do {
            _ = try await claimer.claim()
            XCTFail("expected invalid URL")
        } catch NotificationClaimerError.invalidURL {
            XCTAssertTrue(http.requests.isEmpty)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testDrainIsBoundedAndConfirmsOnlyRenderedItems() async {
        let fixture = NotificationDrainFixture(items: (1 ... 4).map(claimedNotification))

        let delivered = await drainClaimedNotifications(
            session: "pairing-a",
            maxItems: 2,
            isCurrent: { _ in await fixture.isCurrent },
            claim: { await fixture.claim() },
            render: { await fixture.render($0) },
            confirm: { await fixture.confirm($0) },
            canPresent: { true }
        )

        XCTAssertEqual(delivered, 2)
        let result = await fixture.result
        XCTAssertEqual(result.rendered, result.confirmed)
        XCTAssertEqual(result.remaining, 2)
    }

    func testDrainStopsBeforeRenderingWhenPairingChangesDuringClaim() async {
        let fixture = NotificationDrainFixture(
            items: [claimedNotification(1)],
            invalidateAfterClaim: true
        )

        let delivered = await drainClaimedNotifications(
            session: "pairing-a",
            maxItems: 20,
            isCurrent: { _ in await fixture.isCurrent },
            claim: { await fixture.claim() },
            render: { await fixture.render($0) },
            confirm: { await fixture.confirm($0) },
            canPresent: { true }
        )

        XCTAssertEqual(delivered, 0)
        let result = await fixture.result
        XCTAssertTrue(result.rendered.isEmpty)
        XCTAssertTrue(result.confirmed.isEmpty)
    }

    func testPresentationPolicyRequiresAuthorizationAndOneVisibleSurface() {
        XCTAssertTrue(NotificationPresentationPolicy.foregroundOptions.contains(.banner))
        XCTAssertTrue(NotificationPresentationPolicy.foregroundOptions.contains(.list))
        XCTAssertFalse(NotificationPresentationPolicy.canVisiblyPresent(
            authorization: .denied, alert: .enabled, notificationCenter: .enabled
        ))
        XCTAssertFalse(NotificationPresentationPolicy.canVisiblyPresent(
            authorization: .notDetermined, alert: .enabled, notificationCenter: .enabled
        ))
        XCTAssertFalse(NotificationPresentationPolicy.canVisiblyPresent(
            authorization: .authorized, alert: .disabled, notificationCenter: .disabled
        ))
        XCTAssertFalse(NotificationPresentationPolicy.canVisiblyPresent(
            authorization: .authorized, alert: .notSupported, notificationCenter: .notSupported
        ))
        XCTAssertTrue(NotificationPresentationPolicy.canVisiblyPresent(
            authorization: .authorized, alert: .enabled, notificationCenter: .disabled
        ))
        XCTAssertTrue(NotificationPresentationPolicy.canVisiblyPresent(
            authorization: .provisional, alert: .disabled, notificationCenter: .enabled
        ))
    }

    func testDrainDoesNotClaimWhenNotificationCannotBePresented() async {
        let fixture = NotificationDrainFixture(items: [claimedNotification(1)])

        let delivered = await drainClaimedNotifications(
            session: "pairing-a",
            maxItems: 20,
            isCurrent: { _ in true },
            claim: { await fixture.claim() },
            render: { await fixture.render($0) },
            confirm: { await fixture.confirm($0) },
            canPresent: { false }
        )

        XCTAssertEqual(delivered, 0)
        let result = await fixture.result
        XCTAssertEqual(result.remaining, 1)
        XCTAssertTrue(result.rendered.isEmpty)
        XCTAssertTrue(result.confirmed.isEmpty)
    }

    func testExtensionSizedDrainConfirmsAcceptedRenderWhenVisibilityChangesAfterward() async {
        let fixture = NotificationDrainFixture(items: [claimedNotification(1)])
        let visibility = NotificationVisibilitySequence([true, true, false])

        let delivered = await drainClaimedNotifications(
            session: true,
            maxItems: 1,
            isCurrent: { _ in true },
            claim: { await fixture.claim() },
            render: { await fixture.render($0) },
            confirm: { await fixture.confirm($0) },
            canPresent: { await visibility.next() }
        )

        XCTAssertEqual(delivered, 1)
        let result = await fixture.result
        XCTAssertEqual(result.rendered.count, 1)
        XCTAssertEqual(result.rendered, result.confirmed)
    }

    func testExtensionSizedDrainDoesNotRenderOrConfirmWhenVisibilityChangesBeforeRender() async {
        let fixture = NotificationDrainFixture(items: [claimedNotification(1)])
        let visibility = NotificationVisibilitySequence([true, false])

        let delivered = await drainClaimedNotifications(
            session: true,
            maxItems: 1,
            isCurrent: { _ in true },
            claim: { await fixture.claim() },
            render: { await fixture.render($0) },
            confirm: { await fixture.confirm($0) },
            canPresent: { await visibility.next() }
        )

        XCTAssertEqual(delivered, 0)
        let result = await fixture.result
        XCTAssertTrue(result.rendered.isEmpty)
        XCTAssertTrue(result.confirmed.isEmpty)
    }

    func testLeaseRetryKeepsOneStableLocalRequestIdentifier() {
        let firstLease = claimedNotification(1)
        let retryLease = ClaimedNotification(
            id: "00000000-0000-4000-8000-000000000099",
            kind: firstLease.kind,
            targetId: firstLease.targetId,
            title: firstLease.title,
            body: firstLease.body,
            collapseId: firstLease.collapseId,
            remaining: firstLease.remaining,
            route: firstLease.route
        )

        XCTAssertNotEqual(firstLease.id, retryLease.id)
        XCTAssertEqual(firstLease.localRequestIdentifier, retryLease.localRequestIdentifier)
    }

    func testProvisionerStoresOnlyNarrowCredentialAndIsIdempotent() async throws {
        let store = InMemoryStore()
        let http = MockHTTP(responses: [
            .json(200, """
            {"deviceId":"device_1","scopes":["push:claim"],"token":"omn_claim"}
            """),
        ])
        let pairing = Pairing(
            url: baseURL,
            token: "omn_broad",
            accountId: "local",
            deviceId: "device_1",
            gatewayName: "Example gateway",
            scopes: ["admin", "read", "push:claim"],
            fingerprint: String(repeating: "a", count: 64)
        )
        let provisioner = NotificationClaimCredentialProvisioner(
            pairing: pairing,
            store: store,
            request: http.perform
        )

        try await provisioner.ensure()
        try await provisioner.ensure()

        XCTAssertEqual(http.requests.count, 1)
        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url?.path, "/admin/tokens")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_broad")
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
        )
        XCTAssertEqual(body["deviceId"] as? String, "device_1")
        XCTAssertEqual(body["scopes"] as? [String], ["push:claim"])
        XCTAssertEqual(body["name"] as? String, "notifications")
        let stored = try XCTUnwrap(
            NotificationClaimCredentials.stored(keychain: store)
        )
        XCTAssertEqual(stored.token, "omn_claim")
        XCTAssertNotEqual(stored.token, pairing.token)
        XCTAssertEqual(stored.url, pairing.url.absoluteString)
        XCTAssertEqual(stored.deviceId, pairing.deviceId)
        XCTAssertEqual(stored.fingerprint, pairing.fingerprint)
    }

    func testProvisionerSupportsSystemTrustedPairing() async throws {
        let store = InMemoryStore()
        NotificationClaimDiagnostic.record(.unreachable, attempt: .init(), keychain: store)
        let http = MockHTTP(responses: [
            .json(200, #"{"deviceId":"device_1","scopes":["push:claim"],"token":"omn_claim"}"#),
        ])
        let pairing = Pairing(
            url: baseURL,
            token: "omn_broad",
            accountId: "local",
            deviceId: "device_1",
            gatewayName: "Public gateway",
            tlsMode: .system
        )

        try await NotificationClaimCredentialProvisioner(
            pairing: pairing,
            store: store,
            request: http.perform
        ).ensure()

        let stored = try XCTUnwrap(NotificationClaimCredentials.stored(keychain: store))
        XCTAssertEqual(stored.tlsMode, "system")
        XCTAssertNil(stored.fingerprint)
        XCTAssertNil(NotificationClaimDiagnostic.current(keychain: store))
    }

    func testProvisionerRejectsUnexpectedAuthorityWithoutCommittingToken() async throws {
        let store = InMemoryStore()
        let http = MockHTTP(responses: [
            .json(200, """
            {"deviceId":"device_1","scopes":["admin"],"token":"omn_admin"}
            """),
        ])
        let provisioner = NotificationClaimCredentialProvisioner(
            pairing: Pairing(
                url: baseURL,
                token: "omn_broad",
                accountId: "local",
                deviceId: "device_1",
                gatewayName: "Example gateway",
                fingerprint: String(repeating: "b", count: 64)
            ),
            store: store,
            request: http.perform
        )

        do {
            try await provisioner.ensure()
            XCTFail("expected invalid response")
        } catch NotificationClaimCredentialError.invalidResponse {
            XCTAssertNil(try NotificationClaimCredentials.stored(keychain: store))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testProvisionerRotatesWhenGatewayURLOrFingerprintChanges() async throws {
        let store = InMemoryStore()
        try NotificationClaimCredentials.commit(
            .init(
                url: "https://old-gateway.example.test",
                token: "old-claim-token",
                deviceId: "device_1",
                fingerprint: String(repeating: "b", count: 64)
            ),
            keychain: store
        )
        let http = MockHTTP(responses: [
            .json(200, """
            {"deviceId":"device_1","scopes":["push:claim"],"token":"new-claim-token"}
            """),
            .json(200, """
            {"deviceId":"device_1","scopes":["push:claim"],"token":"newest-claim-token"}
            """),
        ])
        let pairing = try Pairing(
            url: XCTUnwrap(URL(string: "https://new-gateway.example.test")),
            token: "omn_broad",
            accountId: "local",
            deviceId: "device_1",
            gatewayName: "New gateway address",
            fingerprint: String(repeating: "b", count: 64)
        )

        try await NotificationClaimCredentialProvisioner(
            pairing: pairing,
            store: store,
            request: http.perform
        ).ensure()

        XCTAssertEqual(http.requests.count, 1)
        var stored = try XCTUnwrap(
            NotificationClaimCredentials.stored(keychain: store)
        )
        XCTAssertEqual(stored.url, "https://new-gateway.example.test")
        XCTAssertEqual(stored.fingerprint, String(repeating: "b", count: 64))
        XCTAssertEqual(stored.token, "new-claim-token")

        let changedPin = Pairing(
            url: pairing.url,
            token: pairing.token,
            accountId: pairing.accountId,
            deviceId: pairing.deviceId,
            gatewayName: pairing.gatewayName,
            fingerprint: String(repeating: "c", count: 64)
        )
        try await NotificationClaimCredentialProvisioner(
            pairing: changedPin,
            store: store,
            request: http.perform
        ).ensure()

        XCTAssertEqual(http.requests.count, 2)
        stored = try XCTUnwrap(
            NotificationClaimCredentials.stored(keychain: store)
        )
        XCTAssertEqual(stored.fingerprint, String(repeating: "c", count: 64))
        XCTAssertEqual(stored.token, "newest-claim-token")
    }

    private func claimedNotification(_ suffix: Int) -> ClaimedNotification {
        ClaimedNotification(
            id: "00000000-0000-4000-8000-\(String(format: "%012d", suffix))",
            kind: "brief",
            targetId: "brief-\(suffix)",
            title: "Fictional notification \(suffix)",
            body: "Invented notification body.",
            collapseId: "brief:brief-\(suffix)",
            remaining: suffix,
            route: .brief(briefId: "brief-\(suffix)")
        )
    }
}

private actor NotificationDrainFixture {
    private var items: [ClaimedNotification]
    private var rendered: [String] = []
    private var confirmed: [String] = []
    private var current = true
    private let invalidateAfterClaim: Bool

    init(items: [ClaimedNotification], invalidateAfterClaim: Bool = false) {
        self.items = items
        self.invalidateAfterClaim = invalidateAfterClaim
    }

    var isCurrent: Bool {
        current
    }

    var result: (rendered: [String], confirmed: [String], remaining: Int) {
        (rendered, confirmed, items.count)
    }

    func claim() -> ClaimedNotification? {
        guard !items.isEmpty else { return nil }
        let item = items.removeFirst()
        if invalidateAfterClaim { current = false }
        return item
    }

    func render(_ item: ClaimedNotification) {
        rendered.append(item.id)
    }

    func confirm(_ id: String) {
        confirmed.append(id)
    }
}

private actor NotificationVisibilitySequence {
    private var values: [Bool]

    init(_ values: [Bool]) {
        self.values = values
    }

    func next() -> Bool {
        values.isEmpty ? false : values.removeFirst()
    }
}

final class RelayEnrollerTests: XCTestCase {
    private let relayURL = URL(string: "https://push.example.test")!

    func testEnrolPostsPublishedIdentityFacts() async throws {
        let http = MockHTTP(responses: [.json(200, "{\"challengeId\":\"challenge_1\"}")])
        let enroller = RelayEnroller(baseURL: relayURL, request: http.perform)

        let response = try await enroller.enrol(
            deviceToken: "carrier-token",
            bundleId: "dev.omnesis.ios",
            environment: "production"
        )

        XCTAssertEqual(response, RelayChallenge(challengeId: "challenge_1"))
        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url?.path, "/v1/enrol")
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String]
        )
        XCTAssertEqual(body, [
            "platform": "ios",
            "token": "carrier-token",
            "bundleId": "dev.omnesis.ios",
            "environment": "production",
        ])
    }

    func testVerifyEchoesChallengeAndNonce() async throws {
        let http = MockHTTP(responses: [.json(200, "{\"credential\":\"relay_credential\"}")])
        let enroller = RelayEnroller(baseURL: relayURL, request: http.perform)

        let response = try await enroller.verify(challengeId: "challenge_1", nonce: "nonce_1")

        XCTAssertEqual(response, RelayCredential(credential: "relay_credential"))
        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url?.path, "/v1/enrol/verify")
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String]
        )
        XCTAssertEqual(body, ["challengeId": "challenge_1", "nonce": "nonce_1"])
    }

    func testEnrolRejectsUnencryptedRelayURL() async throws {
        let http = MockHTTP(responses: [])
        let enroller = try RelayEnroller(
            baseURL: XCTUnwrap(URL(string: "http://push.example.test")),
            request: http.perform
        )

        do {
            _ = try await enroller.enrol(
                deviceToken: String(repeating: "a", count: 64),
                bundleId: "dev.omnesis.ios",
                environment: "production"
            )
            XCTFail("expected invalid URL")
        } catch RelayEnrollerError.invalidURL {
            XCTAssertTrue(http.requests.isEmpty)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}

private final class MockHTTP: @unchecked Sendable {
    struct Response {
        let status: Int
        let body: Data

        static func json(_ status: Int, _ body: String) -> Response {
            Response(status: status, body: Data(body.utf8))
        }

        static func empty(_ status: Int) -> Response {
            Response(status: status, body: Data())
        }
    }

    private let queue = DispatchQueue(label: "notification-claimer-test-http")
    private var responses: [Response]
    private(set) var requests: [URLRequest] = []

    init(responses: [Response]) {
        self.responses = responses
    }

    lazy var perform: NotificationClaimer.Request = { [weak self] request in
        guard let self else { throw NotificationClaimerError.invalidResponse }
        let response = self.queue.sync {
            self.requests.append(request)
            return self.responses.removeFirst()
        }
        let http = HTTPURLResponse(
            url: request.url!,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response.body, http)
    }
}
