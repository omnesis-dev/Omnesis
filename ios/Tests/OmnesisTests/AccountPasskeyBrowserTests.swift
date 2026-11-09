// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest
#if canImport(AuthenticationServices)
import AuthenticationServices
#if canImport(AppKit)
import AppKit
#endif

@MainActor final class AccountPasskeyBrowserTests: XCTestCase {
    private func anchor() -> ASPresentationAnchor {
        #if canImport(AppKit)
        _ = NSApplication.shared
        #endif
        return ASPresentationAnchor()
    }

    private func options()
        -> Data {
        Data("{\"rpId\":\"relay.example.test\",\"challenge\":\"\(String(repeating: "a", count: 43))\",\"userVerification\":\"required\"}"
            .utf8)
    }

    private func assertion() -> AccountPasskeyAssertion {
        AccountPasskeyAssertion(
            credentialId: Data([1]),
            clientData: Data([2]),
            authenticatorData: Data([3]),
            signature: Data([4]),
            userId: Data([5])
        )
    }

    private func wait(_ count: Int, factory: PasskeyTestFactory) async throws {
        for _ in 0 ..< 1000 {
            if factory.sessions.count >= count { return }
            await Task.yield()
        }
        XCTFail("Passkey provider did not start")
        throw AccountPairingError.response
    }

    func testSuccessfulNativeAssertionReturnsOnlyStandardWebAuthnJSON() async throws {
        let factory = PasskeyTestFactory(), anchor = anchor()
        let browser = AccountPasskeyBrowser(anchorProvider: { anchor }, factory: factory.make)
        let task = Task { try await browser.assertion(options: options(), rpId: "relay.example.test") }
        try await wait(1, factory: factory)
        XCTAssertEqual(factory.rpIds, ["relay.example.test"])
        XCTAssertEqual(factory.challenges[0].count, 32)
        XCTAssertTrue(browser
            .presentationAnchor(
                for: ASAuthorizationController(
                    authorizationRequests: [ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: "relay.example.test")
                        .createCredentialAssertionRequest(challenge: Data(
                            repeating: 1,
                            count: 32
                        ))]
                )
            ) === anchor)
        factory.sessions[0].completion(.success(assertion()))
        let data = try await task.value
        XCTAssertTrue(try XCTUnwrap(String(data: data, encoding: .utf8)).contains("public-key"))
        XCTAssertTrue(factory.sessions[0].cancelled)
    }

    func testCancellationAndReplacementCannotCompleteANewerAssertion() async throws {
        let factory = PasskeyTestFactory(), anchor = anchor()
        let browser = AccountPasskeyBrowser(anchorProvider: { anchor }, factory: factory.make)
        let first = Task { try await browser.assertion(options: options(), rpId: "relay.example.test") }
        try await wait(1, factory: factory)
        let second = Task { try await browser.assertion(options: options(), rpId: "relay.example.test") }
        try await wait(2, factory: factory)
        factory.sessions[0].completion(.success(assertion()))
        factory.sessions[1].completion(.success(assertion()))
        do { _ = try await first.value
            XCTFail("Replaced assertion accepted")
        } catch { XCTAssertEqual(error as? AccountPairingError, .cancelled) }
        _ = try await second.value
        browser.cancel()
        browser.cancel()
        let cancelled = Task { try await browser.assertion(options: options(), rpId: "relay.example.test") }
        try await wait(3, factory: factory)
        cancelled.cancel()
        do { _ = try await cancelled.value
            XCTFail("Cancelled assertion accepted")
        } catch { XCTAssertEqual(error as? AccountPairingError, .cancelled) }
    }

    func testSynchronousProviderCompletionDoesNotStartOrRetainAnObsoleteSession() async throws {
        let anchor = anchor()
        var made: PasskeyTestSession?
        let result = assertion()
        let browser = AccountPasskeyBrowser(anchorProvider: { anchor }, factory: { _, _, _, completion in
            let session = PasskeyTestSession(completion: completion)
            made = session
            completion(.success(result))
            return session
        })
        _ = try await browser.assertion(options: options(), rpId: "relay.example.test")
        XCTAssertEqual(made?.started, false)
        XCTAssertEqual(made?.cancelled, true)
        browser.cancel()
    }

    func testThePlatformSessionAsksOnlyForPasskeysOnThisDeviceAndNamesAMissingOne() throws {
        let anchor = anchor(), browser = AccountPasskeyBrowser(anchorProvider: { anchor })
        var performed: [(ASAuthorizationController, ASAuthorizationController.RequestOptions)] = []
        var results: [Result<AccountPasskeyAssertion, Error>] = []
        let session = PlatformAccountPasskeySession(
            rpId: "relay.example.test",
            challenge: Data(repeating: 1, count: 32),
            provider: browser,
            perform: { performed.append(($0, $1)) },
            completion: { results.append($0) }
        )
        XCTAssertTrue(performed.isEmpty)
        session.start()
        XCTAssertEqual(performed.count, 1)
        XCTAssertEqual(performed.first?.1, .preferImmediatelyAvailableCredentials)
        let controller = try XCTUnwrap(performed.first?.0)
        XCTAssertTrue(controller.delegate === session)
        XCTAssertEqual(controller.authorizationRequests.count, 1)
        XCTAssertTrue(controller.authorizationRequests.first is ASAuthorizationPlatformPublicKeyCredentialAssertionRequest)
        session.authorizationController(controller: controller, didCompleteWithError: ASAuthorizationError(.canceled))
        session.authorizationController(controller: controller, didCompleteWithError: ASAuthorizationError(.failed))
        let failures = results.map { result -> AccountPairingError? in
            if case .failure(let error) = result { return error as? AccountPairingError }
            return nil
        }
        XCTAssertEqual(failures, [.noPasskey, .cancelled])
    }

    func testOnlyAnEndedPasskeyRequestCountsAsAMissingPasskey() {
        let domain = ASAuthorizationError.errorDomain
        XCTAssertEqual(PlatformAccountPasskeySession.failure(for: ASAuthorizationError(.canceled)), .noPasskey)
        XCTAssertEqual(PlatformAccountPasskeySession.failure(for: ASAuthorizationError(.notInteractive)), .noPasskey)
        XCTAssertEqual(
            PlatformAccountPasskeySession.failure(for: NSError(domain: domain, code: ASAuthorizationError.Code.canceled.rawValue)),
            .noPasskey
        )
        for code in [ASAuthorizationError.Code.unknown, .invalidResponse, .notHandled, .failed] {
            XCTAssertEqual(PlatformAccountPasskeySession.failure(for: ASAuthorizationError(code)), .cancelled)
        }
        XCTAssertEqual(PlatformAccountPasskeySession.failure(for: URLError(.timedOut)), .cancelled)
        XCTAssertEqual(PlatformAccountPasskeySession.failure(for: CancellationError()), .cancelled)
    }

    func testAMissingPasskeyReachesTheCallerWhileAnAppCancelStaysACancel() async throws {
        let factory = PasskeyTestFactory(), anchor = anchor()
        let browser = AccountPasskeyBrowser(anchorProvider: { anchor }, factory: factory.make)
        let missing = Task { try await browser.assertion(options: options(), rpId: "relay.example.test") }
        try await wait(1, factory: factory)
        XCTAssertTrue(factory.sessions[0].started)
        factory.sessions[0].completion(.failure(AccountPairingError.noPasskey))
        do { _ = try await missing.value
            XCTFail("Missing passkey accepted")
        } catch { XCTAssertEqual(error as? AccountPairingError, .noPasskey) }
        let dismissed = Task { try await browser.assertion(options: options(), rpId: "relay.example.test") }
        try await wait(2, factory: factory)
        browser.cancel()
        factory.sessions[1].completion(.failure(AccountPairingError.noPasskey))
        do { _ = try await dismissed.value
            XCTFail("Cancelled assertion accepted")
        } catch { XCTAssertEqual(error as? AccountPairingError, .cancelled) }
    }

    func testMissingAnchorWrongRelyingPartyAndProviderFailuresFailClosed() async throws {
        let factory = PasskeyTestFactory()
        let missing = AccountPasskeyBrowser(anchorProvider: { nil }, factory: factory.make)
        do { _ = try await missing.assertion(options: options(), rpId: "relay.example.test")
            XCTFail("Missing presentation context")
        } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
        do { _ = try await missing.assertion(options: options(), rpId: "other.example.test")
            XCTFail("Wrong RP accepted")
        } catch { XCTAssertEqual(error as? AccountPairingError, .response) }
        XCTAssertTrue(factory.sessions.isEmpty)
        let anchor = anchor(), browser = AccountPasskeyBrowser(anchorProvider: { anchor }, factory: factory.make)
        let task = Task { try await browser.assertion(options: options(), rpId: "relay.example.test") }
        try await wait(1, factory: factory)
        factory.sessions[0].completion(.failure(AccountPairingError.cancelled))
        do { _ = try await task.value
            XCTFail("Failed provider accepted")
        } catch { XCTAssertEqual(error as? AccountPairingError, .cancelled) }
    }
}

@MainActor private final class PasskeyTestFactory {
    var sessions: [PasskeyTestSession] = []
    var rpIds: [String] = []
    var challenges: [Data] = []
    func make(
        rpId: String,
        challenge: Data,
        provider _: any ASAuthorizationControllerPresentationContextProviding,
        completion: @escaping AccountPasskeyBrowser.Completion
    )
        -> any AccountPasskeySession {
        rpIds.append(rpId)
        challenges.append(challenge)
        let session = PasskeyTestSession(completion: completion)
        sessions.append(session)
        return session
    }
}

@MainActor private final class PasskeyTestSession: AccountPasskeySession {
    let completion: AccountPasskeyBrowser.Completion
    var cancelled = false
    var started = false
    init(completion: @escaping AccountPasskeyBrowser.Completion) {
        self.completion = completion
    }

    func start() {
        started = true
    }

    func cancel() {
        cancelled = true
    }
}
#endif
