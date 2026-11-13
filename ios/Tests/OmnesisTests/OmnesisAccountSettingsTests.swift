// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Settings → Omnesis account: the relay status as the gateway's management
/// service sends it, the phase derived from it, and the requests each action makes.
final class OmnesisAccountSettingsTests: XCTestCase {
    // MARK: - Decoding and phase

    func testEachPhaseDecodesFromARealisticStatus() throws {
        let cases: [(String, CloudRelayPhase)] = [
            (RelayFixture.notConnected, .notConnected),
            (RelayFixture.waiting, .waiting),
            (RelayFixture.status(connect: #"{"state":"registering"}"#), .registering),
            (RelayFixture.established(tunnel: "online", connect: #"{"state":"linking"}"#), .linking),
            (RelayFixture.status(connect: #"{"state":"failed","error":"expired"}"#), .failed),
            (RelayFixture.established(tunnel: "online"), .connected),
            (RelayFixture.established(tunnel: "connecting"), .reconnecting),
            (RelayFixture.established(tunnel: "offline"), .disconnected),
            (RelayFixture.established(tunnel: "disabled", enabled: false), .off),
            (RelayFixture.status(serviceConfigured: false, serviceError: "relay-service-unavailable"), .unavailable),
        ]
        for (json, phase) in cases {
            XCTAssertEqual(try RelayFixture.decode(json).phase, phase, json)
        }
    }

    func testAConnectedStatusCarriesEverySectionOfTheScreen() throws {
        let status = try RelayFixture.decode(RelayFixture.established(tunnel: "online"))
        XCTAssertEqual(status.hostname, "g-fictional.relay.example.test")
        XCTAssertEqual(status.config?.relayUrl, "https://relay.example.test")
        XCTAssertEqual(status.account?.linked, true)
        XCTAssertEqual(status.publicMcp?.url, "https://g-fictional.relay.example.test/mcp")
        XCTAssertEqual(status.certificate?.expiresAt?.date, Date(timeIntervalSince1970: 1_802_077_200))
        XCTAssertEqual(status.tunnel?.lastConnectedAt?.date, Date(timeIntervalSince1970: 1_793_605_260))
        XCTAssertEqual(status.deviceEnrollment?.policy, "automatic")
        XCTAssertEqual(status.certificateMonitor?.state, "observing")
        XCTAssertEqual(status.can?.disable, true)

        let unlinked = try RelayFixture.decode(RelayFixture.established(tunnel: "online", linked: false))
        XCTAssertEqual(unlinked.account?.linked, false)
        XCTAssertEqual(unlinked.account?.canLink, true)
    }

    func testAWaitingStatusCarriesTheSignInAndTheCodeForAnotherDevice() throws {
        let connect = try XCTUnwrap(RelayFixture.decode(RelayFixture.waiting).connect)
        XCTAssertEqual(connect.authorizeUrl, "https://relay.example.test/_relay/v3/connect/sign-in?request=fictional")
        XCTAssertEqual(connect.connectUrl, "https://relay.example.test/_relay/v3/connect")
        XCTAssertEqual(connect.connectShortUrl, "https://omnesis.example/connect")
        XCTAssertEqual(CloudRelayPresentation.connectCode(connect.code), "QK7M-2XPD")
        // The code's expiry is Unix seconds; certificate dates are ISO strings.
        XCTAssertEqual(connect.expiresAt?.date, Date(timeIntervalSince1970: 1_793_610_000))
    }

    /// The portal's `relayPhase`, row by row. Order matters: an active connect
    /// outranks everything, then a failure, then the connection.
    func testPhaseDerivationMatchesThePortal() throws {
        struct Row {
            var connect: String?
            var enabled = false
            var enrollment = "unconfigured"
            var serviceConfigured: Bool? = true
            var tunnel = "disabled"
            let phase: CloudRelayPhase
        }
        let rows = [
            Row(connect: "waiting", enabled: true, enrollment: "enrolled", tunnel: "online", phase: .waiting),
            Row(connect: "registering", serviceConfigured: false, phase: .registering),
            Row(connect: "linking", enabled: true, enrollment: "enrolled", tunnel: "offline", phase: .linking),
            Row(connect: "failed", enabled: true, enrollment: "enrolled", tunnel: "online", phase: .failed),
            Row(connect: "done", enabled: true, enrollment: "enrolled", tunnel: "online", phase: .connected),
            Row(connect: "idle", phase: .notConnected),
            Row(connect: "a-state-from-the-future", phase: .notConnected),
            Row(serviceConfigured: false, phase: .unavailable),
            Row(serviceConfigured: nil, phase: .unavailable),
            Row(enrollment: "failed", serviceConfigured: false, phase: .unavailable),
            Row(enrollment: "failed", phase: .failed),
            Row(enrollment: "pending", phase: .notConnected),
            Row(phase: .notConnected),
            Row(enrollment: "enrolled", tunnel: "online", phase: .off),
            Row(enabled: true, enrollment: "pending", tunnel: "online", phase: .registering),
            Row(enabled: true, enrollment: "failed", phase: .registering),
            Row(enabled: true, enrollment: "enrolled", tunnel: "online", phase: .connected),
            Row(enabled: true, enrollment: "enrolled", tunnel: "offline", phase: .disconnected),
            Row(enabled: true, enrollment: "enrolled", tunnel: "connecting", phase: .reconnecting),
            Row(enabled: true, enrollment: "enrolled", tunnel: "a-state-from-the-future", phase: .reconnecting),
        ]
        for row in rows {
            var fields = [
                #""enabled":\#(row.enabled)"#,
                #""enrollment":{"state":"\#(row.enrollment)"}"#,
                #""tunnel":{"state":"\#(row.tunnel)"}"#,
            ]
            if let connect = row.connect { fields.append(#""connect":{"state":"\#(connect)"}"#) }
            if let configured = row.serviceConfigured { fields.append(#""serviceConfigured":\#(configured)"#) }
            let json = "{\(fields.joined(separator: ","))}"
            XCTAssertEqual(try RelayFixture.decode(json).phase, row.phase, json)
        }
    }

    func testUnknownAndMalformedPartsNeverEmptyTheScreen() throws {
        XCTAssertEqual(try RelayFixture.decode("{}").phase, .unavailable)
        let json = #"{"enabled":true,"serviceConfigured":true,"somethingNew":{"deep":[1,2]},"#
            + #""enrollment":{"state":"enrolled","error":"an-error-from-the-future"},"tunnel":{"state":"online","extra":7},"#
            + #""certificate":"not-an-object","account":{"linked":"yes"},"can":null,"#
            + #""deviceEnrollment":{"policy":"a-policy-from-the-future","trustedSignIns":[{"type":"security-key"}]},"#
            + #""certificateMonitor":{"state":"incident","incidents":[{"hostname":"g-fictional.relay.example.test"},"junk"]}}"#
        let status = try RelayFixture.decode(json)
        XCTAssertEqual(status.phase, .connected)
        XCTAssertNil(status.certificate)
        XCTAssertNil(status.account)
        XCTAssertNil(status.can)
        XCTAssertEqual(status.deviceEnrollment?.policy, "a-policy-from-the-future")
        XCTAssertEqual(status.certificateMonitor?.incidents.count, 1)
        // What has no words yet still renders: a generic sentence.
        XCTAssertEqual(CloudRelayPresentation.error(status.enrollment?.error), "An operation failed. Check settings and retry.")
        XCTAssertEqual(CloudRelayPresentation.problems(status).first, "An operation failed. Check settings and retry.")
        XCTAssertEqual(CloudRelayPresentation.hero(status).hostname, "your gateway")
    }

    // MARK: - Words

    func testTheWordsMatchThePortal() throws {
        XCTAssertEqual(
            CloudRelayPresentation.error("relay-unreachable"),
            "Omnesis Relay could not be reached. Check this gateway's internet connection. It keeps trying by itself."
        )
        XCTAssertEqual(CloudRelayPresentation.error(nil), "")
        // Only the portal's manual setup form can supply an invitation.
        XCTAssertEqual(
            CloudRelayPresentation.error("invitation-required"),
            "This relay requires an invitation for this gateway ID. Open the portal on your gateway to finish this."
        )
        XCTAssertEqual(CloudRelayPresentation.policyChoices.map(\.id), ["automatic", "ask"])

        let first = try CloudRelayPresentation.hero(RelayFixture.decode(RelayFixture.notConnected))
        XCTAssertEqual(first.title, "Enroll this gateway in your Omnesis Account")
        XCTAssertTrue(first.lede.hasSuffix("Connecting gives this gateway a public address and a certificate."))

        let disconnected = try RelayFixture.decode(RelayFixture.established(tunnel: "offline", tunnelError: "tunnel-disconnected"))
        XCTAssertEqual(CloudRelayPresentation.hero(disconnected).title, "Disconnected")
        XCTAssertEqual(CloudRelayPresentation.hero(disconnected).lede, "Remote access was interrupted. Reconnect to try again.")

        let connected = try RelayFixture.decode(RelayFixture.established(tunnel: "online"))
        XCTAssertEqual(CloudRelayPresentation.hero(connected).title, "Connected as")
        XCTAssertEqual(CloudRelayPresentation.hero(connected).hostname, "g-fictional.relay.example.test")
        XCTAssertEqual(CloudRelayPresentation.accountLine(connected), "This gateway is linked to your Omnesis account.")
        XCTAssertEqual(CloudRelayPresentation.accountHints(connected), [])

        let unlinked = try RelayFixture.decode(RelayFixture.established(tunnel: "online", linked: false))
        XCTAssertEqual(CloudRelayPresentation.accountLine(unlinked), "This gateway is not linked to an Omnesis account.")
        XCTAssertEqual(CloudRelayPresentation.accountHints(unlinked).last, CloudRelayPresentation.portalHint)

        let failed = try RelayFixture.decode(RelayFixture.status(connect: #"{"state":"failed","error":"account-link-failed"}"#))
        XCTAssertEqual(CloudRelayPresentation.hero(failed).title, "Couldn't connect")
        XCTAssertEqual(CloudRelayPresentation.hero(failed).lede, CloudRelayPresentation.error("account-link-failed"))

        let off = try RelayFixture.decode(RelayFixture.established(tunnel: "disabled", enabled: false))
        XCTAssertEqual(CloudRelayPresentation.hero(off).title, "Remote access is off")
        XCTAssertEqual(CloudRelayPresentation.addressState(off), "Not reachable while remote access is off.")
    }

    /// The address line never reports a failure the gateway has not reported: until
    /// `publicMcp.lastError` is set, an address that is not ready is still being checked.
    func testTheAddressLineSaysCheckingUntilTheGatewayReportsAFailure() throws {
        let ready = try RelayFixture.decode(RelayFixture.established(tunnel: "online"))
        // An address that answers needs no line under it.
        XCTAssertNil(CloudRelayPresentation.addressState(ready))
        XCTAssertFalse(CloudRelayPresentation.troubled(ready))

        let unconfirmed = #"{"ready":false,"url":"https://g-fictional.relay.example.test/mcp"}"#
        let checking = try RelayFixture.decode(RelayFixture.established(tunnel: "online", publicMcp: unconfirmed))
        XCTAssertEqual(
            CloudRelayPresentation.addressState(checking),
            "Checking that this address answers. This takes up to a minute after the gateway connects."
        )
        XCTAssertEqual(CloudRelayPresentation.problems(checking), [])
        XCTAssertFalse(CloudRelayPresentation.troubled(checking))

        let unreachable = #"{"ready":false,"url":"https://g-fictional.relay.example.test/mcp","lastError":"public-endpoint-unreachable"}"#
        let failing = try RelayFixture.decode(RelayFixture.established(tunnel: "online", publicMcp: unreachable))
        XCTAssertEqual(CloudRelayPresentation.addressState(failing), "This address does not answer right now.")
        XCTAssertEqual(CloudRelayPresentation.problems(failing), [CloudRelayPresentation.error("public-endpoint-unreachable")])

        for tunnel in ["offline", "connecting"] {
            let down = try RelayFixture.decode(RelayFixture.established(tunnel: tunnel))
            XCTAssertEqual(
                CloudRelayPresentation.addressState(down),
                "Not reachable while this gateway is disconnected from the relay."
            )
        }
    }

    func testProblemsAreSaidOnceAndNeverRepeatTheHeadline() throws {
        // The headline already explains a dropped connection; the box still offers the details.
        let disconnected = try RelayFixture.decode(RelayFixture.established(tunnel: "offline", tunnelError: "tunnel-disconnected"))
        XCTAssertEqual(CloudRelayPresentation.problems(disconnected), [])
        XCTAssertTrue(CloudRelayPresentation.troubled(disconnected))

        let stale = try RelayFixture.decode(RelayFixture.established(tunnel: "online", tunnelError: "tunnel-disconnected"))
        XCTAssertEqual(CloudRelayPresentation.problems(stale), ["Remote access was interrupted. Reconnect to try again."])

        let failed = try RelayFixture.decode(RelayFixture.status(connect: #"{"state":"failed","error":"account-link-failed"}"#))
        XCTAssertEqual(CloudRelayPresentation.problems(failed), [])
        XCTAssertTrue(CloudRelayPresentation.troubled(failed))

        let many = try RelayFixture.decode(RelayFixture.troubled)
        let problems = CloudRelayPresentation.problems(many)
        XCTAssertEqual(problems.count, 4, "Two monitor codes with the same sentence are said once")
        XCTAssertEqual(problems[0], CloudRelayPresentation.error("certificate-renewal-failed"))
        XCTAssertEqual(problems[1], CloudRelayPresentation.error("ct-scan-incomplete"))
        XCTAssertTrue(problems[2].hasPrefix("The certificate for this gateway's address expires on "))
        XCTAssertTrue(problems[3].hasPrefix("A certificate for this gateway's address was issued with a key this gateway does not hold."))
        XCTAssertEqual(CloudRelayPresentation.problemsTitle(count: 4), "Some things need your attention")
        XCTAssertEqual(CloudRelayPresentation.problemsTitle(count: 1), "Something needs your attention")
        for text in problems + [CloudRelayPresentation.problemsHelp, CloudRelayPresentation.unlinkMessage] {
            XCTAssertFalse(text.contains("Connection details"), text)
            XCTAssertFalse(text.contains("—"), text)
        }
    }

    func testTheDetailsToCopyArePlainFactsWithoutSecrets() throws {
        let now = Date(timeIntervalSince1970: 1_793_610_000)
        let details = try CloudRelayPresentation.diagnostics(RelayFixture.decode(RelayFixture.troubled), now: now)
        XCTAssertEqual(
            details,
            """
            Omnesis account details
            Time: 2026-11-02T09:00:00.000Z
            Page state: connected
            Error codes: certificate-renewal-failed (certificate), ct-scan-incomplete (certificate monitor), \
            ct-provider-invalid (account), certificate-expiring (certificate), unexpected-certificate (certificate monitor)
            Remote access: on
            Address: https://g-fictional.relay.example.test/mcp (answering)
            Registration: enrolled, gateway ID 00000000-0000-4000-8000-000000000001
            Tunnel: online, last connected 2026-11-02T07:41:00.000Z
            Public certificate: expiring, expires 2026-11-20T09:00:00.000Z, last renewed 2026-08-22T09:00:00.000Z
            Certificate monitor: incident, last checked not recorded
            Unexpected certificate: name g-fictional.relay.example.test, public key sha256:fictional key, certificate unknown, \
            issuer unknown, serial unknown, valid not recorded to not recorded, seen 2026-11-10T05:58:00.000Z, log entry unknown
            Account: connected
            New devices: automatic
            Relay: https://relay.example.test

            """
        )
        // A waiting status carries a sign-in address and a code; neither is copied.
        let waiting = try CloudRelayPresentation.diagnostics(RelayFixture.decode(RelayFixture.waiting), now: now)
        XCTAssertFalse(waiting.contains("request=fictional"))
        XCTAssertFalse(waiting.contains("QK7M-2XPD"))
        XCTAssertTrue(waiting.contains("Address: none (not confirmed)"))
        XCTAssertTrue(waiting.contains("Account: not connected"))
    }

    func testOnlySafeAddressesAreOpened() {
        let relay = "https://relay.example.test"
        XCTAssertNil(CloudRelayPresentation.httpsURL("http://relay.example.test"))
        XCTAssertNil(CloudRelayPresentation.httpsURL("https://someone:secret@relay.example.test"))
        XCTAssertNil(CloudRelayPresentation.httpsURL("javascript:alert(1)"))
        XCTAssertNil(CloudRelayPresentation.httpsURL(nil))
        XCTAssertEqual(
            CloudRelayPresentation.accountPageURL(relayUrl: relay)?.absoluteString,
            "https://relay.example.test/_relay/account"
        )
        XCTAssertEqual(
            CloudRelayPresentation.httpsURL("https://omnesis.example/connect").map(CloudRelayPresentation.displayAddress),
            "omnesis.example/connect"
        )
        XCTAssertNil(CloudRelayPresentation.connectCode("lower-case"))
        XCTAssertNil(CloudRelayPresentation.connectCode("<script>"))
    }

    // MARK: - Requests

    func testEachActionSendsThePortalsRequest() async throws {
        let session = RelaySession()
        let client = try session.client()
        struct Expected {
            let operation: CloudRelayOperation
            let method: String
            let path: String
            let body: String

            init(_ operation: CloudRelayOperation, _ method: String, _ path: String, _ body: String) {
                self.operation = operation
                self.method = method
                self.path = path
                self.body = body
            }
        }
        let operations = [
            Expected(.connect(.create), "POST", "/admin/cloud-relay/connect", #"{"intent":"create","termsAccepted":true}"#),
            Expected(.connect(.existing), "POST", "/admin/cloud-relay/connect", #"{"intent":"existing","termsAccepted":true}"#),
            Expected(.cancelConnect, "POST", "/admin/cloud-relay/connect/cancel", "{}"),
            Expected(.enable, "POST", "/admin/cloud-relay/enable", "{}"),
            Expected(.disable, "POST", "/admin/cloud-relay/disable", "{}"),
            Expected(.reconnect, "POST", "/admin/cloud-relay/reconnect", "{}"),
            Expected(.accountUnlink, "POST", "/admin/cloud-relay/account/unlink", "{}"),
            Expected(.googleUnlink, "POST", "/admin/cloud-relay/google/unlink", "{}"),
            Expected(.setEnrollmentPolicy("ask"), "PUT", "/admin/cloud-relay/enrollment", #"{"policy":"ask"}"#),
            Expected(.setEnrollmentPolicy("automatic"), "PUT", "/admin/cloud-relay/enrollment", #"{"policy":"automatic"}"#),
        ]
        for expected in operations {
            session.requests = []
            let status = try await client.cloudRelay(expected.operation)
            XCTAssertEqual(status.phase, .connected)
            let request = try XCTUnwrap(session.requests.first)
            XCTAssertEqual(request.httpMethod, expected.method)
            XCTAssertEqual(request.url?.absoluteString, "https://gateway.example.test\(expected.path)")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-token")
            XCTAssertEqual(try request.httpBody.map(RelaySession.canonical), expected.body, expected.path)
        }

        session.requests = []
        _ = try await client.cloudRelayStatus()
        XCTAssertEqual(session.requests.map(\.httpMethod), ["GET"])
        XCTAssertEqual(session.requests.first?.url?.path, "/admin/cloud-relay")
        XCTAssertNil(session.requests.first?.httpBody)
    }

    // MARK: - Model

    @MainActor
    func testTheEntryStaysHiddenWithTheBuildFlagOffAndOnAGatewayWithoutTheEndpoint() async throws {
        let session = RelaySession()
        let client = try session.client()

        let off = OmnesisAccountModel(enabled: false)
        await off.load(client: client)
        XCTAssertFalse(off.offered)
        XCTAssertTrue(session.requests.isEmpty, "A build without cloud connectivity never asks the gateway")

        let model = OmnesisAccountModel(enabled: true)
        XCTAssertFalse(model.offered)
        session.status = 404
        await model.load(client: client)
        XCTAssertFalse(model.offered)

        session.status = 200
        await model.load(client: client)
        XCTAssertTrue(model.offered)
        XCTAssertNil(model.loadError)

        // A dropped connection keeps what is on screen; the endpoint going away removes it.
        session.status = 503
        await model.load(client: client)
        XCTAssertTrue(model.offered)
        session.status = 404
        await model.load(client: client)
        XCTAssertFalse(model.offered)
        XCTAssertEqual(model.loadError as? GatewayClient.Error, .notFound)

        // A token without the admin scope cannot read the status either.
        session.status = 403
        session.response = #"{"error":"Forbidden: admin scope required","code":"FORBIDDEN"}"#
        let limited = OmnesisAccountModel(enabled: true)
        await limited.load(client: client)
        XCTAssertFalse(limited.offered)
    }

    @MainActor
    func testARefusedChangeShowsThePortalsWords() async throws {
        let session = RelaySession()
        let client = try session.client()
        let model = OmnesisAccountModel(enabled: true)
        await model.load(client: client)

        session.status = 409
        session.response = #"{"error":"Relay operation was refused.","code":"operation-in-progress"}"#
        await model.perform(.setEnrollmentPolicy("ask"), client: client)
        XCTAssertEqual(model.failure, "Another change is in progress. Wait for it to finish and try again.")
        XCTAssertNil(model.busy)
        XCTAssertEqual(model.status?.deviceEnrollment?.policy, "automatic", "What was on screen stays")

        session.status = 503
        session.response = #"{"error":"Relay management is unavailable. Try again.","code":"relay-management-unavailable"}"#
        await model.perform(.reconnect, client: client)
        XCTAssertEqual(model.failure, "Couldn't load or update your Omnesis account settings. Check the connection and try again.")
        XCTAssertEqual(model.status?.phase, .connected)

        // The next change that goes through clears the message.
        session.status = 200
        session.response = nil
        await model.perform(.reconnect, client: client)
        XCTAssertNil(model.failure)
    }

    @MainActor
    func testConnectingOpensTheSignInAndClosesItOnceTheGatewayMovesOn() async throws {
        let session = RelaySession()
        let client = try session.client()
        let browser = RecordingBrowser()
        let model = OmnesisAccountModel(enabled: true, browser: browser)
        session.response = RelayFixture.notConnected
        await model.load(client: client)
        XCTAssertEqual(model.pollInterval, .seconds(5))

        session.response = RelayFixture.waiting
        await model.connect(.create, client: client)
        XCTAssertEqual(model.status?.phase, .waiting)
        XCTAssertEqual(browser.opened.map(\.absoluteString), ["https://relay.example.test/_relay/v3/connect/sign-in?request=fictional"])
        XCTAssertEqual(model.pollInterval, .seconds(2), "The portal follows a connect under way every two seconds")

        // The person closed the page and opens it again.
        model.openSignIn()
        XCTAssertEqual(browser.opened.count, 2)
        await model.load(client: client)
        XCTAssertEqual(browser.closed, 0)

        session.response = RelayFixture.status(connect: #"{"state":"registering"}"#)
        await model.load(client: client)
        XCTAssertEqual(model.status?.phase, .registering)
        XCTAssertEqual(browser.closed, 1, "Nothing is left to press after the sign-in")
        XCTAssertEqual(model.pollInterval, .seconds(2))

        session.response = RelayFixture.established(tunnel: "online")
        await model.load(client: client)
        XCTAssertEqual(browser.closed, 1)
        XCTAssertEqual(model.pollInterval, .seconds(5))
        model.openSignIn()
        XCTAssertEqual(browser.opened.count, 2, "There is no sign-in to open once connected")
    }

    @MainActor
    func testARefusedConnectOpensNothingAndAnUnsafeSignInAddressIsNotOpened() async throws {
        let session = RelaySession()
        let client = try session.client()
        let browser = RecordingBrowser()
        let model = OmnesisAccountModel(enabled: true, browser: browser)

        session.status = 503
        session.response = #"{"error":"Relay operation was refused.","code":"relay-unreachable"}"#
        await model.connect(.existing, client: client)
        XCTAssertEqual(model.failure, CloudRelayPresentation.error("relay-unreachable"))
        XCTAssertTrue(browser.opened.isEmpty)

        session.status = 200
        session.response = RelayFixture.status(connect: #"{"state":"waiting","authorizeUrl":"http://relay.example.test/sign-in"}"#)
        await model.connect(.existing, client: client)
        XCTAssertEqual(model.status?.phase, .waiting)
        XCTAssertTrue(browser.opened.isEmpty)
    }

    @MainActor
    func testManagingTheAccountOpensTheRelaysAccountPageAndLeavesItOpen() async throws {
        let session = RelaySession()
        let client = try session.client()
        let browser = RecordingBrowser()
        let model = OmnesisAccountModel(enabled: true, browser: browser)
        await model.load(client: client)

        model.openAccountPage()
        XCTAssertEqual(browser.opened.map(\.absoluteString), ["https://relay.example.test/_relay/account"])
        await model.load(client: client)
        XCTAssertEqual(browser.closed, 0, "Only the connect sign-in is closed for the person")
    }

    @MainActor
    func testAStatusReadThatStartedBeforeAChangeIsDiscarded() async throws {
        let slow = try SlowStatusClient(
            stale: RelayFixture.decode(RelayFixture.established(tunnel: "online")),
            fresh: RelayFixture.decode(RelayFixture.established(tunnel: "disabled", enabled: false))
        )
        let model = OmnesisAccountModel(enabled: true)
        let read = Task { await model.load(client: slow) }
        await slow.readStarted()
        await model.perform(.disable, client: slow)
        XCTAssertEqual(model.status?.phase, .off)
        await slow.finishRead()
        await read.value
        XCTAssertEqual(model.status?.phase, .off, "The older read must not put the previous state back")
    }
}

/// Statuses as `CloudRelayManagementService.status()` builds them.
private enum RelayFixture {
    static let config = #""config":{"relayUrl":"https://relay.example.test","acmeDirectoryUrl":"https://acme.example.test/directory","#
        + #""acmeTermsUrl":"https://acme.example.test/terms","termsAccepted":false,"invitationRequired":true}"#

    static let notConnected = status()

    static let waiting = status(
        connect: #"{"state":"waiting","authorizeUrl":"https://relay.example.test/_relay/v3/connect/sign-in?request=fictional","#
            + #""connectUrl":"https://relay.example.test/_relay/v3/connect","connectShortUrl":"https://omnesis.example/connect","#
            + #""code":"QK7M-2XPD","expiresAt":1793610000}"#
    )

    /// A connected gateway with a failed renewal, a certificate close to its end, a monitor that
    /// could not finish and saw an unexpected certificate, and an account error with the monitor's sentence.
    static let troubled = established(
        tunnel: "online",
        certificate: #"{"state":"expiring","expiresAt":"2026-11-20T09:00:00.000Z","lastRenewedAt":"2026-08-22T09:00:00.000Z","#
            + #""lastError":"certificate-renewal-failed"}"#,
        monitor: #"{"enabled":true,"state":"incident","lastError":"ct-scan-incomplete","incidents":["#
            + #"{"hostname":"g-fictional.relay.example.test","spkiFingerprint":"sha256:fictional\nkey","#
            + #""observedAt":"2026-11-10T05:58:00.000Z"}]}"#,
        accountError: "ct-provider-invalid"
    )

    /// A gateway that never registered with the relay.
    static func status(connect: String? = nil, serviceConfigured: Bool = true, serviceError: String? = nil) -> String {
        #"{"certificateMonitor":{"enabled":false,"state":"disabled","incidents":[]},"revision":1,"enabled":false,"configured":false,"#
            + #""serviceConfigured":\#(serviceConfigured),\#(serviceError.map { #""serviceError":"\#($0)","# } ?? "")"#
            + #""identities":[{"id":"direct","names":["gateway.example.test"],"kind":"self-signed","state":"valid","#
            + #""expiresAt":"2027-08-01T00:00:00.000Z","pinPolicy":"existing-device-policy"},"#
            + #"{"id":"cloud","names":[],"kind":"unconfigured","state":"unconfigured","pinPolicy":"strict-key-pin-or-public-pki"}],"#
            + #""directCertificate":{"state":"valid","expiresAt":"2027-08-01T00:00:00.000Z"},\#(config),"#
            + #""enrollment":{"state":"unconfigured"},"tunnel":{"state":"disabled"},"certificate":{"state":"unconfigured"},"#
            + #""publicMcp":{"ready":false},"google":{"configured":false,"canLink":false,"canUnlink":false},"#
            + #""account":{"activated":false,"configured":true,"linked":false,"canLink":false,"canUnlink":false,"pendingUnlink":false},"#
            + #"\#(connect.map { #""connect":\#($0),"# } ?? "")"deviceEnrollment":{"policy":"automatic","trustedSignIns":[]},"#
            + #""can":{"configure":true,"enable":false,"disable":false,"reconnect":false,"renew":false}}"#
    }

    /// A registered gateway, linked to an account unless `linked` is false.
    static func established(
        tunnel: String,
        enabled: Bool = true,
        linked: Bool = true,
        tunnelError: String? = nil,
        connect: String? = nil,
        publicMcp: String? = nil,
        certificate: String = #"{"state":"valid","expiresAt":"2027-02-08T09:00:00.000Z","lastRenewedAt":"2026-11-10T09:00:00.000Z"}"#,
        monitor: String = #"{"enabled":true,"state":"observing","lastCompletedAt":"2026-11-10T06:00:00.000Z","incidents":[]}"#,
        accountError: String? = nil
    )
        -> String {
        let host = "g-fictional.relay.example.test"
        let lastError = tunnelError.map { #","lastError":"\#($0)""# } ?? ""
        let signIns = #"{"type":"google","id":"fictional-google-sign-in","addedAt":1791849600000,"source":"link-page"},"#
            + #"{"type":"passkey","id":"fictional-passkey","addedAt":1793318400000,"source":"endorsed"}"#
        let address = publicMcp ?? #"{"ready":\#(tunnel == "online"),"url":"https://\#(host)/mcp"}"#
        let accountLastError = accountError.map { #","lastError":"\#($0)""# } ?? ""
        return #"{"certificateMonitor":\#(monitor),"recovery":{"receipt":"present","#
            + #""expiresAt":"2027-05-01T00:00:00.000Z"},"revision":7,"enabled":\#(enabled),"configured":true,"serviceConfigured":true,"#
            + #""gatewayId":"00000000-0000-4000-8000-000000000001","hostname":"\#(host)","publicOrigin":"https://\#(host)","#
            + #""identities":[{"id":"direct","names":["gateway.example.test"],"kind":"self-signed","state":"valid","#
            + #""expiresAt":"2027-08-01T00:00:00.000Z","pinPolicy":"existing-device-policy"},"#
            + #"{"id":"cloud","names":["\#(host)"],"kind":"public-ca","state":"valid","expiresAt":"2027-02-08T09:00:00.000Z","#
            + #""pinPolicy":"strict-key-pin-or-public-pki"}],"directCertificate":{"state":"valid","expiresAt":"2027-08-01T00:00:00.000Z"},"#
            + #"\#(config),"enrollment":{"state":"enrolled"},"#
            + #""tunnel":{"state":"\#(tunnel)","lastConnectedAt":"2026-11-02T07:41:00.000Z"\#(lastError)},"#
            + #""certificate":\#(certificate),"publicMcp":\#(address),"#
            + #""google":{"configured":false,"canLink":false,"canUnlink":false},"#
            + #""account":{"activated":true,"configured":true,"linked":\#(linked),"canLink":\#(!linked),"canUnlink":\#(linked),"#
            + #""pendingUnlink":false\#(accountLastError)},\#(connect.map { #""connect":\#($0),"# } ?? "")"#
            + #""deviceEnrollment":{"policy":"automatic","trustedSignIns":[\#(linked ? signIns : "")]},"#
            + #""can":{"configure":false,"enable":\#(!enabled),"disable":\#(enabled),"reconnect":\#(enabled),"renew":\#(enabled)}}"#
    }

    static func decode(_ json: String) throws -> CloudRelayStatus {
        try JSONDecoder().decode(CloudRelayStatus.self, from: Data(json.utf8))
    }
}

private final class RelaySession: URLSessionLike, @unchecked Sendable {
    var requests: [URLRequest] = []
    /// Nil answers a connected status.
    var response: String?
    var status = 200

    func client() throws -> AdminClient {
        try AdminClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.test")), token: "synthetic-token", session: self)
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let body = response ?? RelayFixture.established(tunnel: "online")
        let url = try XCTUnwrap(request.url)
        let answer = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil))
        return (Data(body.utf8), answer)
    }

    /// A JSON body with its keys in a fixed order, so the comparison does not depend on the encoder's.
    static func canonical(_ body: Data) throws -> String {
        let object = try JSONSerialization.jsonObject(with: body)
        let sorted = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return try XCTUnwrap(String(bytes: sorted, encoding: .utf8))
    }
}

@MainActor
private final class RecordingBrowser: OmnesisAccountBrowsing {
    var opened: [URL] = []
    var closed = 0

    func open(_ url: URL) {
        opened.append(url)
    }

    func close() {
        closed += 1
    }
}

/// Holds a status read open until told to finish, so a change can overtake it.
private actor SlowStatusClient: CloudRelayManaging {
    let stale: CloudRelayStatus
    let fresh: CloudRelayStatus
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var release: CheckedContinuation<Void, Never>?

    init(stale: CloudRelayStatus, fresh: CloudRelayStatus) {
        self.stale = stale
        self.fresh = fresh
    }

    func cloudRelayStatus() async throws -> CloudRelayStatus {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters = []
        await withCheckedContinuation { release = $0 }
        return stale
    }

    func cloudRelay(_: CloudRelayOperation) async throws -> CloudRelayStatus {
        fresh
    }

    func readStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func finishRead() {
        release?.resume()
        release = nil
    }
}
