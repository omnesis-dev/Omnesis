// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class GoogleCloudPairingClientTests: XCTestCase {
    private struct Fixture: Decodable, Sendable {
        let clock: Double
        let clientIds: [String]
        let accountId: String
        let fingerprint: String
        let gateway: GoogleGatewayBinding
        let tokens: [String: String]
        let request: FixtureRequest
    }

    private struct FixtureRequest: Decodable, Sendable { let requestId: String
        let name: String
        let secret: String
    }

    private func loadFixture() throws -> (Fixture, Data) {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: Self.self)
        #endif
        let url = try XCTUnwrap(bundle.url(forResource: "cloud-identity-vectors", withExtension: "json", subdirectory: "Fixtures") ??
            bundle.url(forResource: "cloud-identity-vectors", withExtension: "json"))
        let data = try Data(contentsOf: url)
        let value = try JSONDecoder().decode(Fixture.self, from: data)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try (value, JSONSerialization.data(withJSONObject: XCTUnwrap(root["jwks"])))
    }

    private func challenge(_ fixture: Fixture) throws -> CloudPairingChallenge {
        try CloudPairingChallenge(name: fixture.request.name, requestId: fixture.request.requestId, secret: fixture.request.secret)
    }

    func testProductionClockConstructorStillRejectsMalformedIdentityBeforeRelayLogin() async throws {
        let (fixture, keys) = try loadFixture()
        let control = ClosureCloudTransport { url, _, _, _, _ in
            XCTAssertEqual(url.absoluteString, "https://www.googleapis.com/oauth2/v3/certs")
            return keys
        }
        let client = try GoogleCloudPairingClient(
            relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test")),
            clientId: fixture.clientIds[0],
            direct: control,
            createGateway: { _ in XCTFail("Malformed identity reached the gateway")
                return control
            }
        )
        do {
            _ = try await client.start(challenge: challenge(fixture), idToken: "malformed")
            XCTFail("Malformed identity accepted")
        } catch { XCTAssertEqual(error as? CloudIdentityError, .invalidToken) }
        await client.close()
        XCTAssertEqual(control.closeCount, 1)
    }

    private func direct(
        _ fixture: Fixture,
        keys: Data,
        account: String? = nil,
        token: String = "routing-test-token",
        keyOwner: Bool = false
    ) throws
        -> ClosureCloudTransport {
        var bindingObject = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(fixture.gateway)) as? [String: Any])
        if keyOwner { bindingObject["identityToken"] = "omnesis-owner-key-v2:opaque-signed-registration" }
        let binding = try JSONSerialization.data(withJSONObject: bindingObject)
        return ClosureCloudTransport { url, method, body, bearer, form in
            XCTAssertFalse(form)
            if url.absoluteString == "https://www.googleapis.com/oauth2/v3/certs" {
                XCTAssertEqual(method, "GET")
                XCTAssertNil(body)
                XCTAssertNil(bearer)
                return keys
            }
            if url.path == "/_relay/v1/login" {
                XCTAssertEqual(method, "POST")
                XCTAssertNil(bearer)
                let login = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? [String: String])
                XCTAssertEqual(login["idToken"], fixture.tokens["validClient"])
                XCTAssertFalse((String(bytes: body ?? Data(), encoding: .utf8) ?? "").contains(fixture.request.secret))
                return try JSONSerialization.data(withJSONObject: ["token": token, "accountId": account ?? fixture.accountId])
            }
            XCTAssertEqual(url.absoluteString, "https://relay.example.test/_relay/v2/gateway")
            XCTAssertEqual(bearer, "routing-test-token")
            XCTAssertEqual(method, "GET")
            return binding
        }
    }

    func testSignedDiscoveryAndOwnerApprovalStillRequireLocalCodeComparisonBeforeCredentialExchange() async throws {
        let (fixture, keys) = try loadFixture()
        let control = try direct(fixture, keys: keys, keyOwner: true)
        let expected = try challenge(fixture)
        let pinned = ClosureCloudTransport { url, method, body, bearer, form in
            XCTAssertEqual(url.host, URL(string: fixture.gateway.publicOrigin)?.host)
            XCTAssertEqual(method, "POST")
            XCTAssertNil(bearer)
            XCTAssertFalse(form)
            if url.path == "/devices/google/challenge" {
                // The gateway commits to its nonce before it is told anything, the secret least of all.
                XCTAssertEqual(body, Data("{}".utf8))
                return PairingCodeFixture.challengeReply
            }
            let request = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? [String: String])
            XCTAssertEqual(request["requestId"], fixture.request.requestId)
            XCTAssertEqual(request["secret"], fixture.request.secret)
            if url.path == "/devices/google/request" {
                XCTAssertEqual(request["identityToken"], fixture.tokens["validClient"])
                XCTAssertEqual(request["challenge"], PairingCodeFixture.challenge)
            } else {
                XCTAssertEqual(url.path, "/devices/google/poll")
                XCTAssertNil(request["identityToken"])
                XCTAssertNil(request["challenge"])
            }
            return try JSONEncoder().encode(PairingCodeFixture.reply(
                to: expected,
                fingerprint: fixture.fingerprint,
                status: url.path.hasSuffix("poll") ? "approved" : "pending",
                expiresAt: (fixture.clock + 600) * 1000,
                pairingCode: url.path.hasSuffix("poll") ? "SYNTHETIC-CODE" : nil
            ))
        }
        let client = try GoogleCloudPairingClient(
            relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test")),
            clientId: fixture.clientIds[0],
            direct: control,
            createGateway: { fingerprint in XCTAssertEqual(fingerprint, fixture.fingerprint)
                return pinned
            },
            now: { fixture.clock }
        )
        var flow = try await client.start(challenge: challenge(fixture), idToken: XCTUnwrap(fixture.tokens["validClient"]))
        XCTAssertFalse(flow.approved)
        XCTAssertFalse(flow.compared)
        XCTAssertEqual(
            flow.verificationCode,
            try expected.comparisonCode(fingerprint: fixture.fingerprint, codeNonce: PairingCodeFixture.nonce)
        )
        do { _ = try await client.start(challenge: challenge(fixture), idToken: XCTUnwrap(fixture.tokens["validClient"]))
            XCTFail("Reused sign-in")
        } catch {}
        try await flow.receive(client.poll(), now: fixture.clock)
        XCTAssertTrue(flow.approved)
        XCTAssertThrowsError(try flow.pairingPayload(now: fixture.clock))
        flow.confirmComparison()
        let payload = try PairingPayload.decode(from: flow.pairingPayload(now: fixture.clock), cloudRelayEnabled: true)
        guard case .v4(let value) = payload,
              case .pinnedKeyStrict(let fingerprint) = value.tls else { return XCTFail("Strict pin required") }
        XCTAssertEqual(fingerprint, flow.spkiFingerprint)
        await client.close()
        XCTAssertEqual(control.closeCount, 1)
        XCTAssertEqual(pinned.closeCount, 1)
        do { _ = try await client.poll()
            XCTFail("Closed connection resumed")
        } catch { XCTAssertEqual(error as? CloudPairingError, .cancelled) }
    }

    func testWrongAccountEmptyOversizedCredentialsAndUnverifiedIdentityCannotReachGateway() async throws {
        let (fixture, keys) = try loadFixture()
        for (account, token) in [
            ("wrong-account", "routing-test-token"),
            (fixture.accountId, ""),
            (fixture.accountId, String(repeating: "x", count: 4097)),
        ] {
            let control = try direct(fixture, keys: keys, account: account, token: token)
            let client = try GoogleCloudPairingClient(
                relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test")),
                clientId: fixture.clientIds[0],
                direct: control,
                createGateway: { _ in XCTFail("Unverified gateway reached")
                    return control
                },
                now: { fixture.clock }
            )
            do { _ = try await client.start(challenge: challenge(fixture), idToken: XCTUnwrap(fixture.tokens["validClient"]))
                XCTFail("Invalid relay session accepted")
            } catch { XCTAssertEqual(error as? CloudPairingError, .response) }
            await client.close()
        }
        let control = ClosureCloudTransport { url, _, _, _, _ in
            XCTAssertEqual(url.absoluteString, "https://www.googleapis.com/oauth2/v3/certs")
            return keys
        }
        let client = try GoogleCloudPairingClient(
            relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test")),
            clientId: fixture.clientIds[0],
            direct: control
        )
        do { _ = try await client.poll()
            XCTFail("Unstarted request polled")
        } catch { XCTAssertEqual(error as? CloudPairingError, .response) }
        do { _ = try await client.start(challenge: challenge(fixture), idToken: "forged")
            XCTFail("Invalid Google identity accepted")
        } catch { XCTAssertTrue(error is CloudIdentityError) }
        await client.close()
    }

    func testClosingDiscoveryOrPollingCannotResurrectAnApprovalAfterAnUncooperativeTransportReturns() async throws {
        let (fixture, keys) = try loadFixture()
        for phase in ["keys", "login", "directory", "gateway", "poll"] {
            let started = expectation(description: "Suspended \(phase)")
            let gate = CloudReplyGate(started: started)
            let base = try direct(fixture, keys: keys)
            let control = ClosureCloudTransport { url, method, body, bearer, form in
                let data = try await base.requestData(url: url, method: method, body: body, bearer: bearer, form: form)
                let here = url.path.hasSuffix("certs") ? "keys" : url.path.hasSuffix("login") ? "login" : "directory"
                return phase == here ? await gate.wait(for: data) : data
            }
            let expected = try challenge(fixture)
            let pinned = ClosureCloudTransport { url, _, _, _, _ in
                if url.path.hasSuffix("challenge") { return PairingCodeFixture.challengeReply }
                let polling = url.path.hasSuffix("poll")
                let data = try JSONEncoder().encode(PairingCodeFixture.reply(
                    to: expected,
                    fingerprint: fixture.fingerprint,
                    status: polling ? "approved" : "pending",
                    expiresAt: (fixture.clock + 600) * 1000,
                    pairingCode: polling ? "EXPIRED-CODE" : nil
                ))
                return phase == (polling ? "poll" : "gateway") ? await gate.wait(for: data) : data
            }
            let client = try GoogleCloudPairingClient(
                relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test")),
                clientId: fixture.clientIds[0],
                direct: control,
                createGateway: { _ in pinned },
                now: { fixture.clock }
            )
            let challenge = try challenge(fixture)
            let token = try XCTUnwrap(fixture.tokens["validClient"])
            let work = Task {
                _ = try await client.start(challenge: challenge, idToken: token)
                if phase == "poll" { _ = try await client.poll() }
            }
            // Reaching the gate is the point, not how fast: a loaded simulator has taken over 2 s.
            await fulfillment(of: [started], timeout: 30)
            await client.close()
            gate.release()
            do { try await work.value
                XCTFail("Closed \(phase) resumed")
            } catch { XCTAssertEqual(error as? CloudPairingError, .cancelled, phase) }
            do { _ = try await client.start(challenge: challenge, idToken: token)
                XCTFail("Closed client restarted")
            } catch { XCTAssertEqual(error as? CloudPairingError, .cancelled) }
        }
    }

    /// A gateway that lies about its part of the code gets no code shown and no pairing: a nonce
    /// that is not the one it committed to, a code that is not the one computed here, a nonce
    /// that changes between replies, and a reply with no nonce at all.
    func testAGatewayThatLiesAboutItsNonceOrCodeShowsNoCode() async throws {
        let (fixture, keys) = try loadFixture()
        let expected = try challenge(fixture)
        for lie in ["commitment", "code", "poll-nonce", "poll-code", "missing-nonce"] {
            let pinned = ClosureCloudTransport { url, _, _, _, _ in
                if url.path.hasSuffix("challenge") { return PairingCodeFixture.challengeReply }
                let polling = url.path.hasSuffix("poll")
                let lying = polling ? lie.hasPrefix("poll") : !lie.hasPrefix("poll")
                let forged = lying && lie.hasSuffix("nonce") || lie == "commitment"
                let nonce = forged ? PairingCodeFixture.otherNonce : PairingCodeFixture.nonce
                let reply = try PairingCodeFixture.reply(
                    to: expected,
                    fingerprint: fixture.fingerprint,
                    status: polling ? "approved" : "pending",
                    expiresAt: (fixture.clock + 600) * 1000,
                    pairingCode: polling ? "SYNTHETIC-CODE" : nil,
                    nonce: nonce,
                    code: lying && lie.hasSuffix("code") ? "000 000" : nil
                )
                var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(reply)) as? [String: Any])
                if lie == "missing-nonce" { object["codeNonce"] = nil }
                return try JSONSerialization.data(withJSONObject: object)
            }
            let client = try GoogleCloudPairingClient(
                relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test")),
                clientId: fixture.clientIds[0],
                direct: direct(fixture, keys: keys),
                createGateway: { _ in pinned },
                now: { fixture.clock }
            )
            let token = try XCTUnwrap(fixture.tokens["validClient"])
            do {
                let flow = try await client.start(challenge: expected, idToken: token)
                XCTAssertTrue(lie.hasPrefix("poll"), "\(lie) returned a confirmation")
                XCTAssertNotNil(flow.verificationCode)
                _ = try await client.poll()
                XCTFail("\(lie) was accepted")
            } catch {
                if lie == "missing-nonce" {
                    XCTAssertTrue(error is DecodingError, lie)
                } else {
                    XCTAssertEqual(error as? CloudPairingError, .codeMismatch, lie)
                }
            }
            await client.close()
        }
    }

    func testTokenExchangeUsesPKCEAndRefusesMalformedBearerResponses() async throws {
        let auth = try GoogleNativeAuthorization(clientId: "fictional-ios.apps.googleusercontent.com", nonce: "challenge", now: 1000)
        let callback = try XCTUnwrap(URL(string: "\(auth.redirectURI)?state=\(auth.state)&code=synthetic-code"))
        for (type, token) in [
            ("Bearer", "synthetic-id-token"),
            ("Other", "token"),
            ("Bearer", ""),
            ("Bearer", String(repeating: "x", count: 16385)),
        ] {
            let transport = ClosureCloudTransport { url, method, body, bearer, form in
                XCTAssertEqual(url.absoluteString, "https://oauth2.googleapis.com/token")
                XCTAssertEqual(method, "POST")
                XCTAssertNil(bearer)
                XCTAssertTrue(form)
                XCTAssertTrue((String(bytes: body ?? Data(), encoding: .utf8) ?? "").contains("code_verifier=\(auth.verifier)"))
                return try JSONSerialization.data(withJSONObject: ["token_type": type, "id_token": token])
            }
            do {
                let value = try await auth.exchange(callback: callback, transport: transport, now: 1000)
                XCTAssertEqual(type, "Bearer")
                XCTAssertEqual(value, "synthetic-id-token")
            } catch { XCTAssertEqual(error as? CloudPairingError, .response) }
        }
    }

    func testInvalidRelayOriginsAndOAuthConfigurationAreRefused() throws {
        for origin in [
            "http://relay.example.test",
            "https://user@relay.example.test",
            "https://relay.example.test/path",
            "https://relay.example.test?x",
            "https://relay.example.test#x",
        ] {
            XCTAssertThrowsError(try GoogleCloudPairingClient(
                relayOrigin: XCTUnwrap(URL(string: origin)),
                clientId: "fixture.apps.googleusercontent.com"
            ))
        }
        XCTAssertThrowsError(try GoogleCloudPairingClient(
            relayOrigin: XCTUnwrap(URL(string: "https://relay.example.test")),
            clientId: "invalid"
        ))
    }
}

private final class ClosureCloudTransport: CloudPairingTransport, @unchecked Sendable {
    typealias Handler = @Sendable (URL, String, Data?, String?, Bool) async throws -> Data
    private let handler: Handler
    private let lock = NSLock()
    private var closes = 0
    var closeCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return closes
    }

    init(_ handler: @escaping Handler) {
        self.handler = handler
    }

    func requestData(url: URL, method: String, body: Data?, bearer: String?, form: Bool) async throws -> Data {
        try await handler(url, method, body, bearer, form)
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        closes += 1
    }
}

private final class CloudReplyGate: @unchecked Sendable {
    private let lock = NSLock()
    private let started: XCTestExpectation
    private var continuation: CheckedContinuation<Data, Never>?
    private var data = Data()
    init(started: XCTestExpectation) {
        self.started = started
    }

    func wait(for data: Data) async -> Data {
        await withCheckedContinuation { continuation in
            lock.lock()
            self.data = data
            self.continuation = continuation
            lock.unlock()
            started.fulfill()
        }
    }

    func release() {
        lock.lock()
        let pending = continuation
        continuation = nil
        let reply = data
        lock.unlock()
        pending?.resume(returning: reply)
    }
}
