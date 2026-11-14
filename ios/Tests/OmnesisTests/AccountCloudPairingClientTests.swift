// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// swiftlint:disable file_length
import CryptoKit
import Foundation
@testable import Omnesis
import XCTest

final class AccountCloudPairingClientTests: XCTestCase {
    private struct Fixture: Decodable, Sendable { let clock: Double
        let fingerprint: String
        let gateway: GoogleGatewayBinding
    }

    private let origin = "https://relay.example.test"
    private let account = String(repeating: "a", count: 64)
    private let salt = String(repeating: "s", count: 43)
    /// Ten seconds before the fixture's clock: a relay's passkey time must be within a minute of it.
    private let issuedAt = "1793879990"
    private let gatewayChallenge = PairingCodeFixture.challenge
    private let clientId = "synthetic.apps.googleusercontent.com"
    private struct SessionFixture {
        let client: AccountCloudPairingClient
        let challenge: CloudPairingChallenge
        let fixture: Fixture
        let signer: TestIdentitySigner
        let control: AccountTestTransport
        let clock: AccountTestClock
        let pinned: AccountTestTransport
        let key: any DeviceEnrollmentSigning
        let googleNonce: String
    }

    private typealias Mutation = @Sendable (URL, Data) throws -> Data

    private func fixture(
        _ attack: String? = nil,
        reusing: SessionFixture? = nil,
        publicCertificate: Bool = true,
        checksPublicCertificate: Bool = true,
        issuedAt: String? = nil,
        mutateControl: Mutation? = nil,
        mutateGateway: Mutation? = nil
    ) throws
        -> SessionFixture {
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
        let value = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)),
            challenge = try reusing?.challenge ?? CloudPairingChallenge(name: "Fictional phone"), signer = try TestIdentitySigner()
        let fixtureClock = AccountTestClock(value.clock)
        let key = try DeviceEnrollmentKey.loadOrCreate(store: InMemoryStore(), enclaveAvailable: false)
        let enrollmentNonce = try DeviceEnrollmentContract.enrollmentNonce(
            requestId: challenge.requestId,
            kind: challenge.kind,
            name: challenge.name,
            secret: challenge.secret,
            devicePublicKey: key.publicKey
        )
        let baseControl = makeControl(
            value: value,
            enrollmentNonce: enrollmentNonce,
            signer: signer,
            attack: attack,
            issuedAt: issuedAt ?? self.issuedAt
        )
        let control = AccountTestTransport { url, body, bearer in
            let data = try baseControl.handler(url, body, bearer)
            return try mutateControl?(url, data) ?? data
        }
        let pinned = makePinned(value: value, challenge: challenge, publicCertificate: publicCertificate, mutateGateway: mutateGateway)
        let factory = AccountTestLeafFactory(transport: pinned, fingerprint: value.fingerprint)
        let client = try AccountCloudPairingClient(
            relayOrigin: XCTUnwrap(URL(string: origin)),
            clientId: clientId,
            direct: control,
            gatewayFactory: factory,
            deviceKey: { key },
            checksPublicCertificate: checksPublicCertificate,
            now: { fixtureClock.value }
        )
        return try SessionFixture(
            client: client,
            challenge: challenge,
            fixture: value,
            signer: signer,
            control: control,
            clock: fixtureClock,
            pinned: pinned,
            key: key,
            googleNonce: DeviceEnrollmentContract.googleProofNonce(salt: salt, nonce: enrollmentNonce)
        )
    }

    private func makeControl(
        value: Fixture,
        enrollmentNonce: String,
        signer: TestIdentitySigner,
        attack: String?,
        issuedAt: String
    )
        -> AccountTestTransport {
        let clock = value.clock, account = account, salt = salt
        return AccountTestTransport { url, body, bearer in
            switch url.path {
            case "/oauth2/v3/certs": return signer.jwks
            case "/_relay/v3/native/start":
                XCTAssertNil(bearer)
                let input = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? [String: Any])
                XCTAssertEqual(input["nonce"] as? String, enrollmentNonce)
                return try JSONSerialization.data(withJSONObject: [
                    "operationId": "00000000-0000-4000-8000-000000000001",
                    "ticket": String(repeating: "t", count: 43),
                    "googleNonce": DeviceEnrollmentContract.googleProofNonce(salt: salt, nonce: enrollmentNonce),
                    "salt": salt,
                    "expiresAt": (clock + 300) * 1000,
                ])
            case "/_relay/v3/native/passkeys/options":
                return try JSONSerialization.data(withJSONObject: [
                    "ceremonyId": String(repeating: "c", count: 43),
                    "salt": salt,
                    "issuedAt": issuedAt,
                    "options": [
                        "rpId": "relay.example.test",
                        "challenge": DeviceEnrollmentContract.passkeyProofChallenge(salt: salt, issuedAt: issuedAt, nonce: enrollmentNonce),
                        "userVerification": "required",
                    ],
                ])
            case "/_relay/v3/native/google", "/_relay/v3/native/passkeys/complete":
                XCTAssertNil(bearer)
                return try JSONSerialization.data(withJSONObject: [
                    "discoveryToken": "opaque-discovery",
                    "accountId": account,
                    "expiresAt": clock + 300,
                    "credentialPublicKey": "cHVibGljLWtleQ",
                ])
            case "/_relay/v3/gateways":
                XCTAssertEqual(bearer, "opaque-discovery")
                let gateway = [
                    "gatewayId": value.gateway.gatewayId,
                    "publicOrigin": value.gateway.publicOrigin,
                    "displayName": "Fictional home",
                ]
                return try JSONSerialization.data(withJSONObject: ["gateways": attack == "empty" ? [] : (attack == "duplicate" ? [
                    gateway,
                    gateway,
                ] : [gateway])])
            case "/_relay/v3/gateway":
                XCTAssertEqual(bearer, "opaque-discovery")
                XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, value.gateway.gatewayId)
                var binding = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value.gateway)) as? [String: Any])
                if attack == "substitute" { binding["gatewayId"] = UUID().uuidString.lowercased() }
                return try JSONSerialization.data(withJSONObject: [
                    "binding": binding,
                    "accountId": account,
                    "identityToken": "opaque-scoped-proof",
                    "expiresAt": clock + 300,
                ])
            default: XCTFail("Unexpected account request")
                throw AccountPairingError.response
            }
        }
    }

    private func token(_ signer: TestIdentitySigner, clock: Double, nonce: String) throws -> String {
        try signer.sign([
            "iss": "https://accounts.google.com",
            "sub": "fictional-account",
            "aud": clientId,
            "iat": clock - 60,
            "exp": clock + 3600,
            "nonce": nonce,
        ])
    }

    private func mutation(path: String, fields: [String: Any]) throws -> Mutation {
        let patch = try JSONSerialization.data(withJSONObject: fields)
        return { url, data in
            guard url.path == path else { return data }
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: patch) as? [String: Any])
            object.merge(fields) { _, replacement in replacement }
            return try JSONSerialization.data(withJSONObject: object)
        }
    }

    func testAHeldGoogleEnrollmentKeepsApprovalAndComparison() async throws {
        let setup = try fixture()
        let client = setup.client, challenge = setup.challenge, fixture = setup.fixture, signer = setup.signer, control = setup.control
        let nonce = try await client.begin(challenge: challenge)
        XCTAssertEqual(nonce, setup.googleNonce)
        XCTAssertNotEqual(nonce, try challenge.nonce)
        let choices = try await client.google(idToken: token(signer, clock: fixture.clock, nonce: nonce))
        XCTAssertEqual(choices.count, 1)
        XCTAssertFalse(control.paths.contains("/_relay/v3/gateway"))
        var pending = try await client.select(gatewayId: choices[0].gatewayId)
        XCTAssertFalse(pending.approved)
        XCTAssertFalse(pending.joinedAutomatically)
        XCTAssertThrowsError(try pending.pairingPayload(now: fixture.clock))
        let progress = try await client.poll()
        try pending.receive(progress, now: fixture.clock)
        XCTAssertTrue(pending.approved)
        XCTAssertThrowsError(try pending.pairingPayload(now: fixture.clock))
        pending.confirmComparison()
        XCTAssertTrue(try pending.pairingPayload(now: fixture.clock).contains("pinned-key-strict"))
        await client.close()
    }

    func testPasskeyUsesTheSameDirectoryAndEnrollmentApproval() async throws {
        let setup = try fixture()
        let client = setup.client, challenge = setup.challenge
        _ = try await client.begin(challenge: challenge)
        let options = try await client.passkeyOptions()
        let choices = try await client.passkey(options: options, assertion: Data("{\"id\":\"synthetic\"}".utf8))
        let pending = try await client.select(gatewayId: choices[0].gatewayId)
        XCTAssertFalse(pending.approved)
        await client.close()
    }

    func testWrongGoogleNonceNeverReachesAccountLogin() async throws {
        let setup = try fixture()
        let client = setup.client, challenge = setup.challenge, fixture = setup.fixture, signer = setup.signer, control = setup.control
        _ = try await client.begin(challenge: challenge)
        do { _ = try await client.google(idToken: token(signer, clock: fixture.clock, nonce: challenge.nonce))
            XCTFail("Wrong nonce accepted")
        } catch { XCTAssertNotNil(error as? CloudIdentityError) }
        XCTAssertFalse(control.paths.contains("/_relay/v3/native/google"))
        await client.close()
    }

    func testMissingDuplicateAndSubstitutedGatewayChoicesFailClosed() async throws {
        for attack in ["empty", "duplicate", "substitute"] {
            let setup = try fixture(attack)
            let client = setup.client, challenge = setup.challenge, fixture = setup.fixture, signer = setup.signer
            _ = try await client.begin(challenge: challenge)
            do {
                let choices = try await client.google(idToken: token(signer, clock: fixture.clock, nonce: setup.googleNonce))
                _ = try await client.select(gatewayId: choices[0].gatewayId)
                XCTFail("Invalid account directory accepted")
            } catch { XCTAssertEqual(error as? AccountPairingError, attack == "empty" ? .noGateways : .response) }
            await client.close()
        }
    }

    func testInvalidNativeOperationMetadataAndBoundedBodiesFailBeforeProviderSignIn() async throws {
        let clock = try fixture().fixture.clock
        let cases: [[String: Any]] = [
            ["operationId": "invalid"], ["ticket": "short"], ["googleNonce": "short"], ["salt": "short"],
            ["googleNonce": String(repeating: "n", count: 43)], ["salt": String(repeating: "z", count: 43)],
            ["expiresAt": clock * 1000], ["expiresAt": (clock + 311) * 1000],
        ]
        for fields in cases {
            let setup = try fixture(mutateControl: mutation(path: "/_relay/v3/native/start", fields: fields))
            do { _ = try await setup.client.begin(challenge: setup.challenge)
                XCTFail("Invalid operation accepted")
            } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
            await setup.client.close()
        }
        let oversized = try fixture(mutateControl: { _, _ in Data(repeating: 65, count: 65537) })
        do { _ = try await oversized.client.begin(challenge: oversized.challenge)
            XCTFail("Oversized body accepted")
        } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
        await oversized.client.close()
    }

    func testPasskeyOptionsRequireTheConfiguredRelyingPartyAndMandatoryUserVerification() async throws {
        for options: [String: Any] in [
            ["rpId": "other.example.test", "challenge": String(repeating: "a", count: 43), "userVerification": "required"],
            ["rpId": "relay.example.test", "challenge": "short", "userVerification": "required"],
            ["rpId": "relay.example.test", "challenge": String(repeating: "a", count: 43), "userVerification": "preferred"],
            ["rpId": "relay.example.test", "challenge": String(repeating: "a", count: 43), "userVerification": "required"],
        ] {
            let setup = try fixture(mutateControl: mutation(path: "/_relay/v3/native/passkeys/options", fields: ["options": options]))
            _ = try await setup.client.begin(challenge: setup.challenge)
            do { _ = try await setup.client.passkeyOptions()
                XCTFail("Invalid passkey request accepted")
            } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
            await setup.client.close()
        }
    }

    func testDiscoveryTokensAndSelectionProofsCannotExtendTheOriginalSignInLifetimeOrChangeAccounts() async throws {
        let clock = try fixture().fixture.clock
        for fields: [String: Any] in [
            ["accountId": "invalid"], ["discoveryToken": ""], ["discoveryToken": String(repeating: "a", count: 4097)],
            ["expiresAt": clock], ["expiresAt": clock + 301],
        ] {
            let setup = try fixture(mutateControl: mutation(path: "/_relay/v3/native/passkeys/complete", fields: fields))
            _ = try await setup.client.begin(challenge: setup.challenge)
            let options = try await setup.client.passkeyOptions()
            do { _ = try await setup.client.passkey(options: options, assertion: Data("{}".utf8))
                XCTFail("Invalid discovery authority accepted")
            } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
            await setup.client.close()
        }
        for fields: [String: Any] in [
            ["accountId": String(repeating: "b", count: 64)], ["identityToken": ""],
            ["identityToken": String(repeating: "a", count: 16385)], ["expiresAt": clock], ["expiresAt": clock + 301],
        ] {
            let setup = try fixture(mutateControl: mutation(path: "/_relay/v3/gateway", fields: fields))
            _ = try await setup.client.begin(challenge: setup.challenge)
            let options = try await setup.client.passkeyOptions()
            let choices = try await setup.client.passkey(options: options, assertion: Data("{}".utf8))
            do { _ = try await setup.client.select(gatewayId: choices[0].gatewayId)
                XCTFail("Substituted selection authority accepted")
            } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
            await setup.client.close()
        }
    }

    func testExpiredOperationsUnlistedGatewaysAndOversizedPinnedResponsesNeverPair() async throws {
        let expired = try fixture()
        _ = try await expired.client.begin(challenge: expired.challenge)
        expired.clock.advance(301)
        do { _ = try await expired.client.passkeyOptions()
            XCTFail("Expired operation accepted")
        } catch { XCTAssertEqual(error as? AccountPairingError, .expired) }
        await expired.client.close()
        for endpoint in ["request", "poll"] {
            let setup = try fixture(mutateGateway: { url, data in
                url.path.hasSuffix(endpoint) ? Data(repeating: 65, count: 65537) : data
            })
            _ = try await setup.client.begin(challenge: setup.challenge)
            let options = try await setup.client.passkeyOptions()
            let choices = try await setup.client.passkey(options: options, assertion: Data("{}".utf8))
            do {
                _ = try await setup.client.select(gatewayId: choices[0].gatewayId)
                _ = try await setup.client.poll()
                XCTFail("Oversized pinned gateway response accepted")
            } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
            await setup.client.close()
        }
        let unlisted = try fixture()
        do { _ = try await unlisted.client.poll()
            XCTFail("Polling without a paired candidate accepted")
        } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
        _ = try await unlisted.client.begin(challenge: unlisted.challenge)
        let options = try await unlisted.client.passkeyOptions()
        _ = try await unlisted.client.passkey(options: options, assertion: Data("{}".utf8))
        do { _ = try await unlisted.client.select(gatewayId: UUID().uuidString.lowercased())
            XCTFail("Unlisted gateway accepted")
        } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
        await unlisted.client.close()
    }

    func testPaginatedDirectoryPreservesEveryChoiceAndNullableNamesWithoutSelectingAutomatically() async throws {
        let setup = try fixture(mutateControl: { url, data in
            guard url.path == "/_relay/v3/gateways" else { return data }
            let hasCursor = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.name == "after"
            let gatewayId = hasCursor ? "00000000-0000-4000-8000-000000000002" : "00000000-0000-4000-8000-000000000001"
            var page: [String: Any] = ["gateways": [["gatewayId": gatewayId, "publicOrigin": "https://gateway.example.test"]]]
            if !hasCursor { page["nextCursor"] = gatewayId }
            return try JSONSerialization.data(withJSONObject: page)
        })
        _ = try await setup.client.begin(challenge: setup.challenge)
        let options = try await setup.client.passkeyOptions()
        let choices = try await setup.client.passkey(options: options, assertion: Data("{}".utf8))
        XCTAssertEqual(choices.map(\.id), ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"])
        XCTAssertNil(choices[0].displayName)
        XCTAssertFalse(setup.control.paths.contains("/_relay/v3/gateway"))
        await setup.client.close()
    }

    func testTheDefaultClockValidatesCurrentOperationsWithoutStartingAnyProviderOrGatewayConnection() async throws {
        let salt = salt
        let transport = AccountTestTransport { url, body, _ in
            XCTAssertEqual(url.path, "/_relay/v3/native/start")
            let input = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? [String: Any])
            return try JSONSerialization.data(withJSONObject: [
                "operationId": UUID().uuidString.lowercased(),
                "ticket": String(repeating: "t", count: 43),
                "googleNonce": DeviceEnrollmentContract.googleProofNonce(salt: salt, nonce: XCTUnwrap(input["nonce"] as? String)),
                "salt": salt,
                "expiresAt": (Date().timeIntervalSince1970 + 300) * 1000,
            ])
        }
        let key = try DeviceEnrollmentKey.loadOrCreate(store: InMemoryStore(), enclaveAvailable: false)
        let client = try AccountCloudPairingClient(
            relayOrigin: XCTUnwrap(URL(string: origin)),
            clientId: clientId,
            direct: transport,
            deviceKey: { key }
        )
        let nonce = try await client.begin(challenge: CloudPairingChallenge(name: "Fictional phone"))
        XCTAssertEqual(nonce.count, 43)
        await client.close()
    }
}

// MARK: - The pinned gateway

extension AccountCloudPairingClientTests {
    /// The gateway behind the pinned connection: its challenge, its config naming its approval page,
    /// and the request and poll replies for `challenge`.
    private func makePinned(
        value: Fixture,
        challenge: CloudPairingChallenge,
        publicCertificate: Bool,
        mutateGateway: Mutation?
    )
        -> AccountTestTransport {
        let gatewayChallenge = gatewayChallenge, clock = value.clock
        return AccountTestTransport(publicCertificate: publicCertificate) { url, body, bearer in
            XCTAssertNil(bearer)
            if url.path.hasSuffix("challenge") {
                let data = try JSONSerialization.data(withJSONObject: ["challenge": gatewayChallenge, "expiresAt": (clock + 120) * 1000])
                return try mutateGateway?(url, data) ?? data
            }
            if url.path == "/devices/account/config" {
                XCTAssertNil(body)
                let data = try JSONSerialization.data(withJSONObject: [
                    "accountSignIn": true,
                    "gatewayPasskey": ["rpId": "relay.example.test", "origin": value.gateway.publicOrigin],
                ])
                return try mutateGateway?(url, data) ?? data
            }
            let input = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? [String: Any])
            XCTAssertEqual(input["secret"] as? String, challenge.secret)
            if url.path.hasSuffix("request") {
                XCTAssertEqual(input["identityToken"] as? String, "opaque-scoped-proof")
            } else {
                XCTAssertNil(input["identityToken"])
                XCTAssertTrue(url.path.hasSuffix("/devices/account/poll"))
            }
            let polling = url.path.hasSuffix("poll")
            let data = try JSONEncoder().encode(PairingCodeFixture.reply(
                to: challenge,
                fingerprint: value.fingerprint,
                status: polling ? "approved" : "pending",
                expiresAt: (clock + 300) * 1000,
                pairingCode: polling ? "FICTIONAL-CODE" : nil
            ))
            return try mutateGateway?(url, data) ?? data
        }
    }
}

// MARK: - Enrollment at the chosen gateway

extension AccountCloudPairingClientTests {
    func testASignInWithoutAnOmnesisAccountIsNamedAndAnyOtherRefusalStaysAStatus() async throws {
        func refusing(_ path: String, _ body: String) -> Mutation {
            { url, data in
                if url.path == path { throw CloudPairingRefusal(body: Data(body.utf8)) }
                return data
            }
        }
        func signIn(_ setup: SessionFixture, passkey: Bool) async -> Error? {
            var failure: Error?
            do {
                _ = try await setup.client.begin(challenge: setup.challenge)
                if passkey {
                    let options = try await setup.client.passkeyOptions()
                    _ = try await setup.client.passkey(options: options, assertion: Data("{}".utf8))
                } else {
                    let idToken = try token(setup.signer, clock: setup.fixture.clock, nonce: setup.googleNonce)
                    _ = try await setup.client.google(idToken: idToken)
                }
            } catch { failure = error }
            await setup.client.close()
            return failure
        }
        let google = "/_relay/v3/native/google", passkey = "/_relay/v3/native/passkeys/complete"
        for (path, usesPasskey) in [(google, false), (passkey, true)] {
            for body in [#"{"error":"no-account"}"#, #"{"error":"no-account","detail":"ignored"}"#] {
                let error = try await signIn(fixture(mutateControl: refusing(path, body)), passkey: usesPasskey)
                XCTAssertEqual(error as? AccountPairingError, .noAccount, "\(path) \(body)")
            }
            let padded = #"{"error":"no-account","pad":""# + String(repeating: "x", count: 300) + #""}"#
            let unnamed = ["", "no-account", #""no-account""#, "{}", #"{"error":"forbidden"}"#, #"{"error":"NO-ACCOUNT"}"#]
            for body in unnamed + [#"{"error":403}"#, padded] {
                let error = try await signIn(fixture(mutateControl: refusing(path, body)), passkey: usesPasskey)
                XCTAssertEqual(error as? CloudPairingError, .httpStatus(403), "\(path) \(body)")
            }
            let plain = try await signIn(fixture(mutateControl: { url, data in
                if url.path == path { throw CloudPairingError.httpStatus(403) }
                return data
            }), passkey: usesPasskey)
            XCTAssertEqual(plain as? CloudPairingError, .httpStatus(403))
        }
        // Only the two sign-in requests read a refusal; the same body elsewhere names nothing.
        let directory = try fixture(mutateControl: refusing("/_relay/v3/gateways", #"{"error":"no-account"}"#))
        let elsewhere = await signIn(directory, passkey: false)
        XCTAssertNotEqual(elsewhere as? AccountPairingError, .noAccount)
        XCTAssertNotNil(elsewhere)
    }

    func testEachSignInFailureHasItsOwnWordsAndAMissingAccountSaysHowToCreateOne() {
        XCTAssertEqual(
            accountPairingErrorMessage(AccountPairingError.noAccount),
            "There is no Omnesis account for this sign-in yet. Create one from your gateway: open its portal, go to Settings, "
                + "then Account, and choose \"Create an Omnesis account\". You can also pair directly with a QR code."
        )
        XCTAssertEqual(
            accountPairingErrorMessage(AccountPairingError.noGateways),
            "This Omnesis account has no gateway yet. Connect your gateway to it first, or pair directly with a QR code."
        )
        for other in [CloudPairingError.httpStatus(403) as Error, AccountPairingError.response, URLError(.timedOut)] {
            XCTAssertEqual(
                accountPairingErrorMessage(other),
                "Couldn't connect with your Omnesis account. Check your internet connection and try again, "
                    + "or pair directly with a QR code."
            )
        }
    }

    private func passkeyChoices(_ setup: SessionFixture) async throws -> [AccountGatewayChoice] {
        _ = try await setup.client.begin(challenge: setup.challenge)
        let options = try await setup.client.passkeyOptions()
        return try await setup.client.passkey(options: options, assertion: Data(#"{"id":"synthetic"}"#.utf8))
    }

    private func approved(_ setup: SessionFixture) throws -> Mutation {
        let reply = try JSONEncoder().encode(PairingCodeFixture.reply(
            to: setup.challenge,
            fingerprint: setup.fixture.fingerprint,
            status: "approved",
            expiresAt: (setup.fixture.clock + 300) * 1000,
            pairingCode: "FICTIONAL-CODE"
        ))
        return { url, data in url.path.hasSuffix("request") ? reply : data }
    }

    /// A reply in which the gateway lies about its part of the comparison code.
    private func lying(_ setup: SessionFixture, on endpoint: String, nonce: String? = nil, code: String? = nil) throws -> Mutation {
        let reply = try JSONEncoder().encode(PairingCodeFixture.reply(
            to: setup.challenge,
            fingerprint: setup.fixture.fingerprint,
            status: endpoint == "poll" ? "approved" : "pending",
            expiresAt: (setup.fixture.clock + 300) * 1000,
            pairingCode: endpoint == "poll" ? "FICTIONAL-CODE" : nil,
            nonce: nonce ?? PairingCodeFixture.nonce,
            code: code
        ))
        return { url, data in url.path.hasSuffix(endpoint) ? reply : data }
    }

    /// The gateway committed to its nonce before it saw the secret. A reply whose nonce is not
    /// that one, or whose code is not the one computed here, yields no confirmation and no code.
    func testAReplyThatBreaksTheCommitmentOrTheCodeIsRefusedWithNoCode() async throws {
        let probe = try fixture()
        for (name, mutation) in try [
            ("commitment", lying(probe, on: "request", nonce: PairingCodeFixture.otherNonce)),
            ("code", lying(probe, on: "request", code: "000 000")),
            ("joined with another nonce", { url, data in
                guard url.path.hasSuffix("request") else { return data }
                return try JSONEncoder().encode(PairingCodeFixture.reply(
                    to: probe.challenge,
                    fingerprint: probe.fixture.fingerprint,
                    status: "approved",
                    expiresAt: (probe.fixture.clock + 300) * 1000,
                    pairingCode: "FICTIONAL-CODE",
                    nonce: PairingCodeFixture.otherNonce
                ))
            } as Mutation),
        ] {
            let setup = try fixture(reusing: probe, mutateGateway: mutation)
            let choices = try await passkeyChoices(setup)
            do { _ = try await setup.client.select(gatewayId: choices[0].gatewayId)
                XCTFail("\(name) was accepted")
            } catch { XCTAssertEqual(error as? CloudPairingError, .codeMismatch, name) }
            do { _ = try await setup.client.poll()
                XCTFail("\(name) left a request to poll")
            } catch { XCTAssertEqual(error as? AccountPairingError, .response, name) }
            await setup.client.close()
        }
    }

    /// The nonce is fixed by the first reply. A poll that names another one, or another code, is refused.
    func testAPollThatChangesTheNonceOrTheCodeIsRefused() async throws {
        let probe = try fixture()
        for (name, mutation) in try [
            ("nonce", lying(probe, on: "poll", nonce: PairingCodeFixture.otherNonce)),
            ("code", lying(probe, on: "poll", code: "000 000")),
        ] {
            let setup = try fixture(reusing: probe, mutateGateway: mutation)
            let choices = try await passkeyChoices(setup)
            let pending = try await setup.client.select(gatewayId: choices[0].gatewayId)
            XCTAssertEqual(
                pending.verificationCode,
                try setup.challenge.comparisonCode(fingerprint: setup.fixture.fingerprint, codeNonce: PairingCodeFixture.nonce)
            )
            do { _ = try await setup.client.poll()
                XCTFail("A poll with another \(name) was accepted")
            } catch { XCTAssertEqual(error as? CloudPairingError, .codeMismatch, name) }
            await setup.client.close()
        }
    }

    /// Once the request may have reached a gateway its secret is no longer private, so a retry
    /// repeats the same bytes and never answers a new challenge.
    func testARetryAfterTheRequestWasSentRepeatsItAndAsksForNoNewChallenge() async throws {
        let online = AccountTestFlag()
        let setup = try fixture(mutateGateway: { url, data in
            if url.path.hasSuffix("request"), !online.value { throw CloudPairingError.httpStatus(503) }
            return data
        })
        let choices = try await passkeyChoices(setup)
        do { _ = try await setup.client.select(gatewayId: choices[0].gatewayId)
            XCTFail("An unreachable gateway answered")
        } catch { XCTAssertEqual(error as? AccountPairingError, .gatewayUnavailable) }
        let first = try XCTUnwrap(setup.pinned.lastBody(path: "/devices/account/request"))
        online.value = true
        let pending = try await setup.client.retryEnrollment()
        XCTAssertNotNil(pending.verificationCode)
        XCTAssertEqual(setup.pinned.paths, ["/devices/account/challenge", "/devices/account/request", "/devices/account/request"])
        let second = try XCTUnwrap(setup.pinned.lastBody(path: "/devices/account/request"))
        XCTAssertEqual(NSDictionary(dictionary: first), NSDictionary(dictionary: second))
        await setup.client.close()
    }

    func testTheRequestProvesTheKeyAndCarriesThePasskeyProof() async throws {
        let setup = try fixture()
        let choices = try await passkeyChoices(setup)
        let pending = try await setup.client.select(gatewayId: choices[0].gatewayId)
        XCTAssertEqual(setup.pinned.paths, ["/devices/account/challenge", "/devices/account/request"])
        XCTAssertEqual(
            pending.verificationCode,
            try setup.challenge.comparisonCode(fingerprint: pending.fingerprint, codeNonce: PairingCodeFixture.nonce)
        )
        let body = try XCTUnwrap(setup.pinned.lastBody(path: "/devices/account/request"))
        XCTAssertNil(body["challenge"], "A request with a device key names its challenge there only")
        XCTAssertEqual(body["requireApproval"] as? Bool, false)
        let proof = try XCTUnwrap(body["proof"] as? [String: Any])
        XCTAssertEqual(proof["type"] as? String, "passkey")
        XCTAssertEqual(proof["salt"] as? String, salt)
        XCTAssertEqual(proof["issuedAt"] as? String, issuedAt)
        XCTAssertEqual(proof["credentialPublicKey"] as? String, "cHVibGljLWtleQ")
        XCTAssertEqual((proof["credential"] as? [String: Any])?["id"] as? String, "synthetic")
        let evidence = try XCTUnwrap(body["deviceKey"] as? [String: String])
        XCTAssertEqual(evidence["publicKey"], setup.key.publicKey)
        XCTAssertEqual(evidence["challenge"], gatewayChallenge)
        let transcript = try DeviceEnrollmentContract.enrollmentSignatureTranscript(
            requestId: setup.challenge.requestId,
            kind: setup.challenge.kind,
            name: setup.challenge.name,
            gatewaySpkiFingerprint: pending.spkiFingerprint,
            challenge: gatewayChallenge,
            devicePublicKey: setup.key.publicKey
        )
        let publicKey = try P256.Signing.PublicKey(derRepresentation: XCTUnwrap(cloudBase64URL(setup.key.publicKey)))
        let signature = try P256.Signing.ECDSASignature(derRepresentation: XCTUnwrap(cloudBase64URL(XCTUnwrap(evidence["signature"]))))
        XCTAssertTrue(publicKey.isValidSignature(signature, for: transcript))
        await setup.client.close()
    }

    func testAGoogleProofCarriesTheTokenAndSalt() async throws {
        let setup = try fixture()
        _ = try await setup.client.begin(challenge: setup.challenge)
        let idToken = try token(setup.signer, clock: setup.fixture.clock, nonce: setup.googleNonce)
        let choices = try await setup.client.google(idToken: idToken)
        _ = try await setup.client.select(gatewayId: choices[0].gatewayId)
        let proof = try XCTUnwrap(setup.pinned.lastBody(path: "/devices/account/request")?["proof"] as? [String: Any])
        XCTAssertEqual(proof as? [String: String], ["type": "google", "idToken": idToken, "salt": salt])
        await setup.client.close()
    }

    func testAnImmediateApprovalJoinsWithoutComparison() async throws {
        let probe = try fixture()
        let setup = try fixture(reusing: probe, mutateGateway: approved(probe))
        let choices = try await passkeyChoices(setup)
        let joined = try await setup.client.select(gatewayId: choices[0].gatewayId)
        XCTAssertTrue(joined.joinedAutomatically)
        XCTAssertTrue(try joined.pairingPayload(now: setup.fixture.clock).contains("pinned-key-strict"))
        await setup.client.close()
    }

    func testAFailedPublicCertificateCheckAsksForApprovalAndKeepsTheComparison() async throws {
        let probe = try fixture()
        let setup = try fixture(reusing: probe, publicCertificate: false, mutateGateway: approved(probe))
        let choices = try await passkeyChoices(setup)
        var pending = try await setup.client.select(gatewayId: choices[0].gatewayId)
        XCTAssertEqual(setup.pinned.lastBody(path: "/devices/account/request")?["requireApproval"] as? Bool, true)
        XCTAssertTrue(pending.approved)
        XCTAssertFalse(pending.joinedAutomatically)
        XCTAssertThrowsError(try pending.pairingPayload(now: setup.fixture.clock))
        pending.confirmComparison()
        XCTAssertNoThrow(try pending.pairingPayload(now: setup.fixture.clock))
        await setup.client.close()
    }

    func testATestGatewayBuildCanSkipThePublicCertificateCheck() async throws {
        let setup = try fixture(publicCertificate: false, checksPublicCertificate: false)
        let choices = try await passkeyChoices(setup)
        _ = try await setup.client.select(gatewayId: choices[0].gatewayId)
        XCTAssertEqual(setup.pinned.lastBody(path: "/devices/account/request")?["requireApproval"] as? Bool, false)
        await setup.client.close()
    }

    func testAGatewayWithoutTheChallengeRouteAsksForAnUpdateAndSendsNothingElse() async throws {
        let setup = try fixture(mutateGateway: { url, data in
            if url.path.hasSuffix("challenge") { throw CloudPairingError.httpStatus(404) }
            return data
        })
        let choices = try await passkeyChoices(setup)
        do { _ = try await setup.client.select(gatewayId: choices[0].gatewayId)
            XCTFail("An older gateway was enrolled")
        } catch { XCTAssertEqual(error as? AccountPairingError, .gatewayNeedsUpdate) }
        XCTAssertEqual(setup.pinned.paths, ["/devices/account/challenge"])
        await setup.client.close()
    }

    func testARefusedDeviceKeyIsNotYourGatewayAndLeavesNothingToPoll() async throws {
        let setup = try fixture(mutateGateway: { url, data in
            if url.path.hasSuffix("request") { throw CloudPairingError.httpStatus(403) }
            return data
        })
        let choices = try await passkeyChoices(setup)
        do { _ = try await setup.client.select(gatewayId: choices[0].gatewayId)
            XCTFail("A refused key was accepted")
        } catch { XCTAssertEqual(error as? AccountPairingError, .notYourGateway) }
        do { _ = try await setup.client.poll()
            XCTFail("A refused request was left pending")
        } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
        await setup.client.close()
    }

    func testAnOfflineGatewayIsRetriedWithAFreshChallengeUntilTheSignInExpires() async throws {
        let online = AccountTestFlag()
        let setup = try fixture(mutateGateway: { _, data in
            if !online.value { throw URLError(.cannotConnectToHost) }
            return data
        })
        let choices = try await passkeyChoices(setup)
        do { _ = try await setup.client.select(gatewayId: choices[0].gatewayId)
            XCTFail("An unreachable gateway answered")
        } catch { XCTAssertEqual(error as? AccountPairingError, .gatewayUnavailable) }
        do { _ = try await setup.client.retryEnrollment()
            XCTFail("An unreachable gateway answered")
        } catch { XCTAssertEqual(error as? AccountPairingError, .gatewayUnavailable) }
        online.value = true
        let pending = try await setup.client.retryEnrollment()
        XCTAssertFalse(pending.approved)
        XCTAssertEqual(setup.pinned.paths.filter { $0.hasSuffix("challenge") }.count, 3)
        await setup.client.close()

        let late = try fixture(mutateGateway: { _, _ in throw CloudPairingError.httpStatus(503) })
        let lateChoices = try await passkeyChoices(late)
        do { _ = try await late.client.select(gatewayId: lateChoices[0].gatewayId)
            XCTFail("A relay with no tunnel answered")
        } catch { XCTAssertEqual(error as? AccountPairingError, .gatewayUnavailable) }
        late.clock.advance(301)
        do { _ = try await late.client.retryEnrollment()
            XCTFail("An expired sign-in was used")
        } catch { XCTAssertEqual(error as? AccountPairingError, .expired) }
        await late.client.close()
    }

    func testRetryingIsOnlyForAnEnrollmentInProgress() async throws {
        let setup = try fixture()
        do { _ = try await setup.client.retryEnrollment()
            XCTFail("Retried with no gateway chosen")
        } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
        await setup.client.close()
    }
}

// MARK: - The relay's passkey time and the gateway's approval page

extension AccountCloudPairingClientTests {
    /// The relay picks the time a passkey signs over. One more than a minute from this device's
    /// clock, either way, is refused before the passkey is asked for anything.
    func testARelayPasskeyTimeMoreThanAMinuteFromThisDevicesClockIsRefused() async throws {
        let clock = try fixture().fixture.clock
        for (offset, accepted) in [(-61.0, false), (61, false), (-3600, false), (86400, false), (-60, true), (60, true), (0, true)] {
            let setup = try fixture(issuedAt: String(Int(clock + offset)))
            _ = try await setup.client.begin(challenge: setup.challenge)
            do {
                _ = try await setup.client.passkeyOptions()
                XCTAssertTrue(accepted, "A passkey time \(offset) s from the clock was accepted")
            } catch {
                XCTAssertFalse(accepted, "A passkey time \(offset) s from the clock was refused")
                XCTAssertEqual(error as? AccountPairingError, .response)
            }
            XCTAssertFalse(setup.control.paths.contains("/_relay/v3/native/passkeys/complete"))
            await setup.client.close()
        }
    }

    private func approvalPage(_ setup: SessionFixture) throws -> URL {
        try XCTUnwrap(URL(string: "\(setup.fixture.gateway.publicOrigin)/portal/approve#\(setup.challenge.requestId)"))
    }

    /// Held, the request is approved on the gateway's own page, which the gateway names over the
    /// pinned connection; the poll then finds it approved and the device pairs after the comparison.
    func testAHeldPasskeySignInOpensTheGatewaysOwnApprovalPageAndPollsUntilApproved() async throws {
        let setup = try fixture()
        let choices = try await passkeyChoices(setup)
        var pending = try await setup.client.select(gatewayId: choices[0].gatewayId)
        XCTAssertFalse(pending.approved)
        XCTAssertFalse(pending.joinedAutomatically)
        let page = try await setup.client.approvalPage()
        XCTAssertEqual(page, try approvalPage(setup))
        XCTAssertEqual(page?.host, "g-00000000000040008000000000000001.relay.example.test")
        XCTAssertEqual(setup.pinned.paths, ["/devices/account/challenge", "/devices/account/request", "/devices/account/config"])
        XCTAssertFalse(setup.control.paths.contains { $0.contains("config") || $0.contains("approve") })
        let progress = try await setup.client.poll()
        try pending.receive(progress, now: setup.fixture.clock)
        XCTAssertTrue(pending.approved)
        pending.confirmComparison()
        XCTAssertTrue(try pending.pairingPayload(now: setup.fixture.clock).contains("pinned-key-strict"))
        await setup.client.close()
    }

    /// TM-01/TM-02: a held iOS passkey sign-in is approved only on the gateway's own page, never on a
    /// relay page. Whatever the pinned gateway names, the app opens a page only on that gateway's own
    /// origin under the relay's passkey domain, never the relay's own host, a sibling gateway or
    /// another site; anything else leaves approval to a trusted device.
    func testTM01TM02AHeldIOSPasskeySignInIsApprovedOnlyOnTheGatewaysOwnPageNeverOnARelayPage() async throws {
        let own = try fixture().fixture.gateway.publicOrigin
        let refused: [(String, [String: Any])] = [
            ("the relay's own page", ["rpId": "relay.example.test", "origin": "https://relay.example.test"]),
            ("a sibling gateway", ["rpId": "relay.example.test", "origin": own.replacingOccurrences(of: "0001.", with: "0002.")]),
            ("another site", ["rpId": "relay.example.test", "origin": "https://approve.example.org"]),
            ("a look-alike host", ["rpId": "relay.example.test", "origin": "https://g-1.relay.example.test.example.org"]),
            ("plain HTTP", ["rpId": "relay.example.test", "origin": own.replacingOccurrences(of: "https://", with: "http://")]),
            ("another port", ["rpId": "relay.example.test", "origin": own + ":8443"]),
            ("a path", ["rpId": "relay.example.test", "origin": own + "/elsewhere"]),
            ("a fragment", ["rpId": "relay.example.test", "origin": own + "#other"]),
            ("another passkey domain", ["rpId": "example.test", "origin": own]),
            ("a domain the relay does not serve", ["rpId": "g-00000000000040008000000000000001.relay.example.test", "origin": own]),
        ]
        for (name, advertised) in refused {
            let setup = try fixture(mutateGateway: mutation(path: "/devices/account/config", fields: ["gatewayPasskey": advertised]))
            let choices = try await passkeyChoices(setup)
            _ = try await setup.client.select(gatewayId: choices[0].gatewayId)
            let page = try await setup.client.approvalPage()
            XCTAssertNil(page, "\(name) was opened as the approval page")
            await setup.client.close()
        }
        // A relay that names its own host as the gateway's origin gets no page on it either.
        let relay = try XCTUnwrap(URL(string: origin))
        XCTAssertNil(AccountCloudPairingClient.approvalPage(
            origin: origin,
            rpId: "relay.example.test",
            gateway: relay,
            relay: relay,
            requestId: UUID().uuidString.lowercased()
        ))
        XCTAssertNil(try AccountCloudPairingClient.approvalPage(
            origin: own,
            rpId: "relay.example.test",
            gateway: XCTUnwrap(URL(string: own)),
            relay: relay,
            requestId: "not-a-request"
        ))
        // The gateway's own page, named as it is, is the one opened.
        let setup = try fixture()
        let choices = try await passkeyChoices(setup)
        _ = try await setup.client.select(gatewayId: choices[0].gatewayId)
        let page = try await setup.client.approvalPage()
        XCTAssertEqual(page, try approvalPage(setup))
        XCTAssertNotEqual(page?.host, relay.host)
        await setup.client.close()
    }

    func testAGatewayWithoutAnApprovalPageOrWithAnOversizedConfigOpensNothing() async throws {
        let silent = try fixture(mutateGateway: { url, data in
            url.path == "/devices/account/config" ? Data(#"{"accountSignIn":true}"#.utf8) : data
        })
        let choices = try await passkeyChoices(silent)
        _ = try await silent.client.select(gatewayId: choices[0].gatewayId)
        let none = try await silent.client.approvalPage()
        XCTAssertNil(none)
        await silent.client.close()

        let oversized = try fixture(mutateGateway: { url, data in
            url.path == "/devices/account/config" ? Data(repeating: 65, count: 65537) : data
        })
        let oversizedChoices = try await passkeyChoices(oversized)
        _ = try await oversized.client.select(gatewayId: oversizedChoices[0].gatewayId)
        do { _ = try await oversized.client.approvalPage()
            XCTFail("An oversized config was read")
        } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
        await oversized.client.close()
    }

    /// There is a page to open only for a request this sign-in holds at the gateway: none before one
    /// was sent, none once the gateway joined it, and none after the attempt was closed.
    func testOnlyAHeldRequestHasAnApprovalPage() async throws {
        let early = try fixture()
        let before = try await early.client.approvalPage()
        XCTAssertNil(before)
        _ = try await passkeyChoices(early)
        let unsent = try await early.client.approvalPage()
        XCTAssertNil(unsent)
        XCTAssertTrue(early.pinned.paths.isEmpty)
        await early.client.close()
        do { _ = try await early.client.approvalPage()
            XCTFail("A closed attempt named a page")
        } catch { XCTAssertEqual(error as? AccountPairingError, .cancelled) }

        let probe = try fixture()
        let joined = try fixture(reusing: probe, mutateGateway: approved(probe))
        let choices = try await passkeyChoices(joined)
        _ = try await joined.client.select(gatewayId: choices[0].gatewayId)
        let none = try await joined.client.approvalPage()
        XCTAssertNil(none)
        XCTAssertFalse(joined.pinned.paths.contains("/devices/account/config"))
        await joined.client.close()
    }
}

private final class AccountTestFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var current = false
    var value: Bool {
        get { lock.withLock { current } }
        set { lock.withLock { current = newValue } }
    }
}

private struct AccountTestLeafFactory: CloudPairingLeafTransportFactory {
    let transport: AccountTestTransport
    let fingerprint: String
    func pinnedLeaf(_ fingerprint: String) -> any CloudPairingTransport {
        XCTAssertEqual(fingerprint, self.fingerprint)
        return transport
    }
}

private final class AccountTestTransport: CloudPairingTransport, CloudPairingPublicCertificateReporting, @unchecked Sendable {
    private let lock = NSLock()
    private var history: [String] = []
    private var bodies: [String: Data] = [:]
    private let publicCertificate: Bool
    var paths: [String] {
        lock.withLock { history }
    }

    let handler: @Sendable (URL, Data?, String?) throws -> Data
    init(publicCertificate: Bool = true, _ handler: @escaping @Sendable (URL, Data?, String?) throws -> Data) {
        self.publicCertificate = publicCertificate
        self.handler = handler
    }

    func publicCertificateVerified(host: String) -> Bool {
        publicCertificate
    }

    func lastBody(path: String) -> [String: Any]? {
        lock.withLock { bodies[path] }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    func requestData(url: URL, method: String, body: Data?, bearer: String?, form: Bool) async throws -> Data {
        XCTAssertFalse(form)
        lock.withLock {
            history.append(url.path)
            bodies[url.path] = body
        }
        return try handler(url, body, bearer)
    }

    func close() {}
}

private final class AccountTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var timestamp: TimeInterval
    init(_ timestamp: TimeInterval) {
        self.timestamp = timestamp
    }

    var value: TimeInterval {
        lock.withLock { timestamp }
    }

    func advance(_ seconds: TimeInterval) {
        lock.withLock { timestamp += seconds }
    }
}
