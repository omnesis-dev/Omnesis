// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

#if canImport(AuthenticationServices)

@MainActor final class AccountCloudPairingModelTests: XCTestCase {
    private struct Fixture: Decodable { let clock: Double
        let gateway: GoogleGatewayBinding
    }

    private func fixture() throws -> Fixture {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: Self.self)
        #endif
        let url = try XCTUnwrap(bundle.url(forResource: "cloud-identity-vectors", withExtension: "json", subdirectory: "Fixtures") ?? bundle
            .url(
                forResource: "cloud-identity-vectors",
                withExtension: "json"
            ))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func configuration() throws -> AccountCloudPairingConfiguration {
        try AccountCloudPairingConfiguration(
            relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test")),
            google: nil,
            passkeysEnabled: true
        )
    }

    func testSeveralGatewaysOfferAChoiceAndAHeldRequestWaitsForApprovalAndOneComparisonAction() async throws {
        let fixture = try fixture(), gate = AccountApprovalGate(), browser = AccountModelGoogle(), provider = AccountModelPasskey()
        let session = AccountModelSession(binding: fixture.gateway, clock: fixture.clock, gate: gate)
        let model = AccountCloudPairingCoordinator(
            googleBrowser: browser,
            passkeyProvider: provider,
            makeClient: { _ in session },
            sleep: {},
            now: { fixture.clock }
        )
        _ = try await model.start(configuration: configuration(), method: .passkey)?.value
        XCTAssertEqual(model.phase, .choosing)
        XCTAssertEqual(model.gateways.count, 2)
        XCTAssertFalse(model.gatewayApproved)
        var applied: [String] = []
        await model.complete { applied.append($0)
            return true
        }
        XCTAssertTrue(applied.isEmpty)
        XCTAssertNil(model.choose(UUID().uuidString))
        let choosing = model.choose(fixture.gateway.gatewayId)
        for _ in 0 ..< 1000 {
            if model.phase == .comparing { break }
            await Task.yield()
        }
        XCTAssertEqual(model.phase, .comparing)
        await model.complete { applied.append($0)
            return true
        }
        XCTAssertTrue(applied.isEmpty)
        await gate.release()
        await choosing?.value
        XCTAssertTrue(model.gatewayApproved)
        await model.complete { applied.append($0)
            return true
        }
        XCTAssertEqual(applied.count, 1)
        XCTAssertTrue(applied[0].contains("pinned-key-strict"))
        XCTAssertEqual(model.phase, .idle)
        XCTAssertEqual(provider.assertions, 1)
        XCTAssertEqual(browser.signIns, 0)
    }

    func testCancelledProviderCannotPublishChoicesOrPair() async throws {
        let fixture = try fixture(), gate = AccountApprovalGate(), provider = AccountModelPasskey()
        provider.wait = true
        let session = AccountModelSession(binding: fixture.gateway, clock: fixture.clock, gate: gate)
        let model = AccountCloudPairingCoordinator(
            googleBrowser: AccountModelGoogle(),
            passkeyProvider: provider,
            makeClient: { _ in session },
            sleep: {},
            now: { fixture.clock }
        )
        let start = try model.start(configuration: configuration(), method: .passkey)
        for _ in 0 ..< 1000 {
            if provider.pending != nil { break }
            await Task.yield()
        }
        XCTAssertNotNil(provider.pending)
        model.cancel()
        provider.resume()
        await start?.value
        XCTAssertEqual(model.phase, .idle)
        XCTAssertTrue(model.gateways.isEmpty)
        await model.complete { _ in XCTFail("Cancelled pairing applied")
            return true
        }
    }

    func testMissingGatewaysAreReportedWithoutPairing() async throws {
        let fixture = try fixture(), gate = AccountApprovalGate()
        let session = AccountModelSession(binding: fixture.gateway, clock: fixture.clock, gate: gate, empty: true)
        let model = AccountCloudPairingCoordinator(
            googleBrowser: AccountModelGoogle(),
            passkeyProvider: AccountModelPasskey(),
            makeClient: { _ in session },
            sleep: {},
            now: { fixture.clock }
        )
        try await model.start(configuration: configuration(), method: .passkey)?.value
        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(model.error as? AccountPairingError, .noGateways)
        model.cancel()
    }

    func testPollingFailuresFailClosedAndDefaultRetryWaitCanReachApproval() async throws {
        let fixture = try fixture()
        for fails in [true, false] {
            let gate = AccountApprovalGate()
            let session = AccountModelSession(binding: fixture.gateway, clock: fixture.clock, gate: gate)
            let model: AccountCloudPairingCoordinator
            if fails {
                model = AccountCloudPairingCoordinator(
                    googleBrowser: AccountModelGoogle(),
                    passkeyProvider: AccountModelPasskey(),
                    makeClient: { _ in session },
                    sleep: { throw AccountPairingError.response },
                    now: { fixture.clock }
                )
            } else {
                model = AccountCloudPairingCoordinator(
                    googleBrowser: AccountModelGoogle(),
                    passkeyProvider: AccountModelPasskey(),
                    makeClient: { _ in session },
                    now: { fixture.clock }
                )
                await gate.release()
            }
            try await model.start(configuration: configuration(), method: .passkey)?.value
            await model.choose(fixture.gateway.gatewayId)?.value
            XCTAssertEqual(model.phase, fails ? .failed : .comparing)
            XCTAssertEqual(model.gatewayApproved, !fails)
            model.cancel()
        }
    }

    private func makeModel(
        _ session: AccountModelSession,
        fixture: Fixture,
        recorded: AccountRecorded? = nil
    )
        -> AccountCloudPairingCoordinator {
        AccountCloudPairingCoordinator(
            googleBrowser: AccountModelGoogle(),
            passkeyProvider: AccountModelPasskey(),
            makeClient: { _ in session },
            sleep: {},
            retryWait: { _ in },
            recordEnrollment: { recorded?.values.append($0.spkiFingerprint) },
            now: { fixture.clock }
        )
    }

    func testOneGatewayNeedsNoChoiceAndAJoinedDevicePairsWithoutComparing() async throws {
        let fixture = try fixture(), recorded = AccountRecorded()
        let session = AccountModelSession(
            binding: fixture.gateway,
            clock: fixture.clock,
            gate: AccountApprovalGate(),
            single: true,
            joins: true
        )
        let model = makeModel(session, fixture: fixture, recorded: recorded)
        try await model.start(configuration: configuration(), method: .passkey)?.value
        XCTAssertEqual(model.phase, .joining)
        XCTAssertNil(model.verificationCode)
        XCTAssertTrue(recorded.values.isEmpty)
        var applied: [String] = []
        await model.complete { applied.append($0)
            return true
        }
        XCTAssertEqual(applied.count, 1)
        XCTAssertTrue(applied[0].contains("pinned-key-strict"))
        XCTAssertEqual(recorded.values.count, 1)
        XCTAssertEqual(model.phase, .idle)
    }

    func testOneGatewayThatHoldsTheRequestShowsTheComparison() async throws {
        let fixture = try fixture(), gate = AccountApprovalGate()
        await gate.release()
        let session = AccountModelSession(binding: fixture.gateway, clock: fixture.clock, gate: gate, single: true)
        let model = makeModel(session, fixture: fixture)
        try await model.start(configuration: configuration(), method: .passkey)?.value
        XCTAssertEqual(model.phase, .comparing)
        XCTAssertNotNil(model.verificationCode)
        XCTAssertTrue(model.gatewayApproved)
        model.cancel()
    }

    func testAnOfflineGatewayIsWaitedForWithBackoff() async throws {
        let fixture = try fixture(), gate = AccountApprovalGate()
        await gate.release()
        let session = AccountModelSession(
            binding: fixture.gateway,
            clock: fixture.clock,
            gate: gate,
            single: true,
            joins: true,
            offlineAttempts: 3
        )
        var waits: [Int] = []
        var phases: [AccountCloudPairingCoordinator.Phase] = []
        var coordinator: AccountCloudPairingCoordinator?
        let model = AccountCloudPairingCoordinator(
            googleBrowser: AccountModelGoogle(),
            passkeyProvider: AccountModelPasskey(),
            makeClient: { _ in session },
            retryWait: { attempt in
                waits.append(attempt)
                if let phase = coordinator?.phase { phases.append(phase) }
            },
            now: { fixture.clock }
        )
        coordinator = model
        try await model.start(configuration: configuration(), method: .passkey)?.value
        XCTAssertEqual(waits, [0, 1, 2])
        XCTAssertEqual(phases, [.waitingForGateway, .waitingForGateway, .waitingForGateway])
        XCTAssertEqual(model.phase, .joining)
        model.cancel()
    }

    func testAnExpiredSignInAsksToSignInAgainAndARefusalSavesNothing() async throws {
        let fixture = try fixture()
        for (failure, offline) in [(AccountPairingError.expired, 1), (.notYourGateway, 0), (.gatewayNeedsUpdate, 0)] {
            let recorded = AccountRecorded()
            let session = AccountModelSession(
                binding: fixture.gateway,
                clock: fixture.clock,
                gate: AccountApprovalGate(),
                single: true,
                offlineAttempts: offline,
                failure: failure
            )
            let model = makeModel(session, fixture: fixture, recorded: recorded)
            try await model.start(configuration: configuration(), method: .passkey)?.value
            XCTAssertEqual(model.phase, .failed)
            XCTAssertEqual(model.error as? AccountPairingError, failure)
            var applied = 0
            await model.complete { _ in applied += 1
                return true
            }
            XCTAssertEqual(applied, 0)
            XCTAssertTrue(recorded.values.isEmpty)
            model.cancel()
        }
    }

    func testAnOfflineWaitStopsWhenCancelled() async throws {
        let fixture = try fixture()
        let session = AccountModelSession(
            binding: fixture.gateway,
            clock: fixture.clock,
            gate: AccountApprovalGate(),
            single: true,
            offlineAttempts: 1000
        )
        var coordinator: AccountCloudPairingCoordinator?
        let model = AccountCloudPairingCoordinator(
            googleBrowser: AccountModelGoogle(),
            passkeyProvider: AccountModelPasskey(),
            makeClient: { _ in session },
            retryWait: { attempt in if attempt == 2 { coordinator?.cancel() } },
            now: { fixture.clock }
        )
        coordinator = model
        try await model.start(configuration: configuration(), method: .passkey)?.value
        XCTAssertEqual(model.phase, .idle)
        XCTAssertNil(model.error)
    }

    private func configurationBundle(_ info: [String: Any]) throws -> Bundle {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("bundle")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try data.write(to: folder.appendingPathComponent("Info.plist"))
        return try XCTUnwrap(Bundle(url: folder))
    }

    func testAccountConfigurationIsIndependentOfExperimentalModeAndValidatesItsOriginAndAvailableMethods() throws {
        XCTAssertNil(AccountCloudPairingConfiguration.configured())
        let valid: [String: Any] = [
            "OmnesisCloudRelayEnabled": "1",
            "OmnesisCloudRelayURL": "https://relay.example.test",
            "OmnesisCloudRelayPasskeysEnabled": "1",
        ]
        let configured = try XCTUnwrap(AccountCloudPairingConfiguration.configured(bundle: configurationBundle(valid)))
        XCTAssertTrue(configured.passkeysEnabled)
        XCTAssertNil(configured.google)
        for flag: Any in [false, true, "0", "true", "$(OMNESIS_CLOUD_RELAY_ENABLED)"] {
            var input = valid
            input["OmnesisCloudRelayEnabled"] = flag
            XCTAssertNil(try AccountCloudPairingConfiguration.configured(bundle: configurationBundle(input)))
        }
        for origin in [
            "not an origin",
            "http://relay.example.test",
            "https:/missing-host",
            "https://user@relay.example.test",
            "https://user:password@relay.example.test",
            "https://relay.example.test/path",
            "https://relay.example.test?query",
            "https://relay.example.test#fragment",
            "https://relay.example.test:8443",
        ] {
            var input = valid
            input["OmnesisCloudRelayURL"] = origin
            XCTAssertNil(try AccountCloudPairingConfiguration.configured(bundle: configurationBundle(input)))
        }
        var googleOnly = valid
        googleOnly["OmnesisCloudRelayPasskeysEnabled"] = "0"
        XCTAssertNil(try AccountCloudPairingConfiguration.configured(bundle: configurationBundle(googleOnly)))
        googleOnly["OmnesisGoogleClientID"] = "fixture-ios.apps.googleusercontent.com"
        googleOnly["CFBundleURLTypes"] = [["CFBundleURLSchemes": ["com.googleusercontent.apps.fixture-ios"]]]
        let accepted = try XCTUnwrap(AccountCloudPairingConfiguration.configured(bundle: configurationBundle(googleOnly)))
        XCTAssertFalse(accepted.passkeysEnabled)
        XCTAssertNotNil(accepted.google)
    }

    func testGoogleUsesTheServerNonceBeforeDiscoveringGatewaysAndRequiresExplicitChoice() async throws {
        let fixture = try fixture(), gate = AccountApprovalGate(), browser = AccountModelGoogle()
        browser.succeeds = true
        let session = AccountModelSession(binding: fixture.gateway, clock: fixture.clock, gate: gate)
        let google = try GoogleCloudPairingConfiguration(
            clientId: "fixture-ios.apps.googleusercontent.com",
            relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test"))
        )
        let configuration = AccountCloudPairingConfiguration(relayOrigin: google.relayOrigin, google: google, passkeysEnabled: false)
        let model = AccountCloudPairingCoordinator(
            googleBrowser: browser,
            passkeyProvider: AccountModelPasskey(),
            makeClient: { _ in session },
            makeTransport: { AccountModelTokenTransport() },
            now: { fixture.clock }
        )
        await model.start(configuration: configuration, method: .google)?.value
        XCTAssertEqual(model.phase, .choosing)
        XCTAssertEqual(browser.authorization?.nonce, String(repeating: "n", count: 43))
        XCTAssertEqual(browser.signIns, 1)
        XCTAssertNil(model.start(configuration: configuration, method: .google))
        XCTAssertFalse(model.acceptsCompletedPairing(nil, previousGeneration: nil))
        model.cancel()
        browser.succeeds = false
        await model.start(configuration: configuration, method: .google)?.value
        XCTAssertEqual(model.phase, .idle)
        XCTAssertNil(model.error)
    }

    func testDisabledMethodsAndFailedCredentialApplicationNeverReportPairedSuccess() async throws {
        let fixture = try fixture(), gate = AccountApprovalGate()
        await gate.release()
        let session = AccountModelSession(binding: fixture.gateway, clock: fixture.clock, gate: gate)
        let model = AccountCloudPairingCoordinator(
            googleBrowser: AccountModelGoogle(),
            passkeyProvider: AccountModelPasskey(),
            makeClient: { _ in session },
            now: { fixture.clock }
        )
        let disabled = try AccountCloudPairingConfiguration(
            relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test")),
            google: nil,
            passkeysEnabled: false
        )
        await model.start(configuration: disabled, method: .google)?.value
        XCTAssertEqual(model.phase, .failed)
        await model.start(configuration: disabled, method: .passkey)?.value
        XCTAssertEqual(model.phase, .failed)
        try await model.start(configuration: configuration(), method: .passkey)?.value
        await model.choose(fixture.gateway.gatewayId)?.value
        XCTAssertTrue(model.gatewayApproved)
        await model.complete { _ in false }
        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(model.error as? CloudPairingError, .response)
        XCTAssertFalse(model.acceptsCompletedPairing(nil, previousGeneration: nil))
        model.cancel()
        let installed = AccountCloudPairingCoordinator()
        let invalid = try AccountCloudPairingConfiguration(
            relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test/invalid")),
            google: nil,
            passkeysEnabled: true
        )
        await installed.start(configuration: invalid, method: .passkey)?.value
        XCTAssertEqual(installed.phase, .failed)
        installed.cancel()
    }

    func testInstalledGoogleTransportAndClockFailClosedBeforeNetworkOnAnInvalidBrowserCallback() async throws {
        let fixture = try fixture(), browser = AccountModelGoogle()
        browser.succeeds = true
        browser.malformed = true
        let session = AccountModelSession(binding: fixture.gateway, clock: fixture.clock, gate: AccountApprovalGate())
        let model = AccountCloudPairingCoordinator(
            googleBrowser: browser,
            passkeyProvider: AccountModelPasskey(),
            makeClient: { _ in session }
        )
        let google = try GoogleCloudPairingConfiguration(
            clientId: "fixture-ios.apps.googleusercontent.com",
            relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test"))
        )
        let configuration = AccountCloudPairingConfiguration(relayOrigin: google.relayOrigin, google: google, passkeysEnabled: false)
        await model.start(configuration: configuration, method: .google)?.value
        XCTAssertEqual(model.phase, .failed)
        XCTAssertNotNil(model.error)
        XCTAssertTrue(model.gateways.isEmpty)
        XCTAssertEqual(browser.signIns, 1)
        model.cancel()
    }
}

@MainActor private final class AccountRecorded {
    var values: [String] = []
}

extension AccountCloudPairingModelTests {
    func testAMissingPasskeyIsExplainedWithTheSignInChoicesOpenAndACancelStaysSilent() async throws {
        let fixture = try fixture(), provider = AccountModelPasskey()
        let session = AccountModelSession(binding: fixture.gateway, clock: fixture.clock, gate: AccountApprovalGate())
        let model = AccountCloudPairingCoordinator(
            googleBrowser: AccountModelGoogle(),
            passkeyProvider: provider,
            makeClient: { _ in session },
            sleep: {},
            now: { fixture.clock }
        )
        provider.failure = .noPasskey
        try await model.start(configuration: configuration(), method: .passkey)?.value
        XCTAssertEqual(model.phase, .failed)
        XCTAssertEqual(model.error as? AccountPairingError, .noPasskey)
        XCTAssertTrue(model.gateways.isEmpty)
        XCTAssertEqual(
            (model.error as? AccountPairingError)?.signInNotice,
            "No passkey was used. If this iPhone has no passkey for your Omnesis account, sign in with Google, "
                + "or add a passkey to your Omnesis account first."
        )
        for other in [AccountPairingError.noGateways, .noAccount, .response, .expired, .cancelled, .gatewayNeedsUpdate, .notYourGateway] {
            XCTAssertNil(other.signInNotice)
        }
        provider.failure = .cancelled
        try await model.start(configuration: configuration(), method: .passkey)?.value
        XCTAssertEqual(model.phase, .idle)
        XCTAssertNil(model.error)
        provider.failure = nil
        try await model.start(configuration: configuration(), method: .passkey)?.value
        XCTAssertEqual(model.phase, .choosing)
        XCTAssertNil(model.error)
        XCTAssertEqual(provider.assertions, 3)
        model.cancel()
    }
}

private actor AccountApprovalGate {
    private var ready = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        if ready { return }
        await withCheckedContinuation { continuation = $0 }
    }

    func release() {
        ready = true
        continuation?.resume()
        continuation = nil
    }
}

extension AccountCloudPairingModelTests {
    /// A poll whose nonce changed, or whose code is not the one computed here, ends the attempt
    /// and takes the code off the screen.
    func testAPollThatChangesTheNonceOrTheCodeLeavesNoCodeOnScreen() async throws {
        for lie in ["nonce", "code"] {
            let fixture = try fixture(), gate = AccountApprovalGate()
            await gate.release()
            let session = AccountModelSession(binding: fixture.gateway, clock: fixture.clock, gate: gate, single: true, pollLie: lie)
            let model = makeModel(session, fixture: fixture)
            try await model.start(configuration: configuration(), method: .passkey)?.value
            XCTAssertEqual(model.phase, .failed, lie)
            XCTAssertEqual(model.error as? CloudPairingError, .codeMismatch, lie)
            XCTAssertNil(model.verificationCode, lie)
            XCTAssertFalse(model.gatewayApproved, lie)
        }
    }
}

private actor AccountModelSession: AccountPairingSession {
    let binding: GoogleGatewayBinding
    let clock: Double
    let gate: AccountApprovalGate
    let empty: Bool
    let single: Bool
    let joins: Bool
    let failure: AccountPairingError?
    private var offlineAttempts: Int
    private var challenge: CloudPairingChallenge?
    /// How a poll lies about the gateway's part of the code, if it does.
    private let pollLie: String?
    init(
        binding: GoogleGatewayBinding,
        clock: Double,
        gate: AccountApprovalGate,
        empty: Bool = false,
        single: Bool = false,
        joins: Bool = false,
        offlineAttempts: Int = 0,
        failure: AccountPairingError? = nil,
        pollLie: String? = nil
    ) {
        self.pollLie = pollLie
        self.binding = binding
        self.clock = clock
        self.gate = gate
        self.empty = empty
        self.single = single
        self.joins = joins
        self.offlineAttempts = offlineAttempts
        self.failure = failure
    }

    private func withSecondChoice(_ first: AccountGatewayChoice) -> [AccountGatewayChoice] {
        single ? [first] : [
            first,
            AccountGatewayChoice(
                gatewayId: "00000000-0000-4000-8000-0000000000aa",
                publicOrigin: "https://second.example.test",
                displayName: "Fictional second"
            ),
        ]
    }

    func begin(challenge: CloudPairingChallenge) async throws -> String {
        self.challenge = challenge
        return String(repeating: "n", count: 43)
    }

    func google(idToken: String) async throws -> [AccountGatewayChoice] {
        XCTAssertEqual(idToken, "fictional-native-google-token")
        return withSecondChoice(AccountGatewayChoice(gatewayId: binding.gatewayId, publicOrigin: binding.publicOrigin, displayName: nil))
    }

    func passkeyOptions() async throws -> AccountCloudPairingClient.PasskeyOptions {
        AccountCloudPairingClient.PasskeyOptions(
            ceremonyId: String(repeating: "c", count: 43),
            options: Data("{}".utf8)
        )
    }

    func passkey(options _: AccountCloudPairingClient.PasskeyOptions, assertion _: Data) async throws -> [AccountGatewayChoice] {
        if empty { throw AccountPairingError.noGateways }
        return withSecondChoice(AccountGatewayChoice(
            gatewayId: binding.gatewayId,
            publicOrigin: binding.publicOrigin,
            displayName: "Fictional home"
        ))
    }

    func select(gatewayId: String) async throws -> CloudPairingConfirmation {
        XCTAssertEqual(gatewayId, binding.gatewayId)
        return try enroll()
    }

    func retryEnrollment() async throws -> CloudPairingConfirmation {
        try enroll()
    }

    private func enroll() throws -> CloudPairingConfirmation {
        if offlineAttempts > 0 {
            offlineAttempts -= 1
            throw AccountPairingError.gatewayUnavailable
        }
        if let failure { throw failure }
        var value = try CloudPairingConfirmation(challenge: XCTUnwrap(challenge), candidate: binding, now: clock).committed()
        if joins {
            try value.receive(value.reply("approved", expiresAt: (clock + 300) * 1000, pairingCode: "FICTIONAL-CODE"), now: clock)
            value.acceptAutomaticJoin()
        } else {
            try value.receive(value.reply(expiresAt: (clock + 300) * 1000), now: clock)
        }
        return value
    }

    func poll() async throws -> CloudPairingProgress {
        await gate.wait()
        let confirmation = try CloudPairingConfirmation(challenge: XCTUnwrap(challenge), candidate: binding, now: clock)
        return try confirmation.reply(
            "approved",
            expiresAt: (clock + 300) * 1000,
            pairingCode: "FICTIONAL-CODE",
            nonce: pollLie == "nonce" ? PairingCodeFixture.otherNonce : PairingCodeFixture.nonce,
            code: pollLie == "code" ? "000 000" : nil
        )
    }

    func close() async {}
}

@MainActor private final class AccountModelGoogle: GooglePairingBrowser {
    var signIns = 0
    var succeeds = false
    var malformed = false
    var authorization: GoogleNativeAuthorization?
    func signIn(_ value: GoogleNativeAuthorization) async throws -> URL {
        signIns += 1
        authorization = value
        if succeeds {
            let state = malformed ? "invalid-state" : value.state
            return try XCTUnwrap(URL(string: "\(value.redirectURI)?state=\(state)&code=fictional"))
        }
        throw CloudPairingError.cancelled
    }

    func cancel() {}
}

@MainActor private final class AccountModelPasskey: AccountPasskeyProvider {
    var assertions = 0
    var wait = false
    var pending: CheckedContinuation<Data, Error>?
    var failure: AccountPairingError?
    func assertion(options _: Data, rpId: String) async throws -> Data {
        assertions += 1
        XCTAssertEqual(rpId, "relay.example.test")
        if let failure { throw failure }
        if wait { return try await withCheckedThrowingContinuation { pending = $0 } }
        return Data("{}".utf8)
    }

    func resume() {
        pending?.resume(returning: Data("{}".utf8))
        pending = nil
    }

    func cancel() {}
}

private struct AccountModelTokenTransport: CloudPairingTransport {
    func requestData(url: URL, method: String, body: Data?, bearer: String?, form: Bool) async throws -> Data {
        XCTAssertEqual(url.absoluteString, "https://oauth2.googleapis.com/token")
        XCTAssertEqual(method, "POST")
        XCTAssertTrue(form)
        XCTAssertNil(bearer)
        XCTAssertTrue(String(data: body ?? Data(), encoding: .utf8)?.contains("code_verifier=") == true)
        return Data(#"{"id_token":"fictional-native-google-token","token_type":"Bearer"}"#.utf8)
    }

    func close() {}
}

#endif
