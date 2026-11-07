// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

@MainActor
final class GoogleCloudPairingModelTests: XCTestCase {
    private struct Vectors: Decodable, Sendable {
        let clock: Double
        let gateway: GoogleGatewayBinding
        let clientIds: [String]
        let accountId: String
        let tokens: [String: String]
        let request: Request
    }

    private struct Request: Decodable, Sendable { let requestId: String
        let name: String
        let secret: String
    }

    private func vectors() throws -> (Vectors, Data) {
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
        let data = try Data(contentsOf: url)
        let fixture = try JSONDecoder().decode(Vectors.self, from: data)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try (fixture, JSONSerialization.data(withJSONObject: XCTUnwrap(root["jwks"])))
    }

    private func challenge(_ fixture: Vectors) throws -> CloudPairingChallenge {
        try .init(name: fixture.request.name, requestId: fixture.request.requestId, secret: fixture.request.secret)
    }

    private func confirmation(_ fixture: Vectors, approved: Bool = false) throws -> CloudPairingConfirmation {
        var value = try CloudPairingConfirmation(challenge: challenge(fixture), candidate: fixture.gateway, now: fixture.clock)
        if approved { try value.receive(progress(value, fixture: fixture), now: fixture.clock) }
        return value
    }

    private func progress(_ value: CloudPairingConfirmation, fixture: Vectors) -> CloudPairingProgress {
        .init(
            status: "approved",
            verificationCode: value.verificationCode,
            expiresAt: (fixture.clock + 500) * 1000,
            pairingCode: "SYNTHETIC-CODE"
        )
    }

    private func model(
        _ fixture: Vectors,
        browser: ModelBrowser? = nil,
        session: ModelSession,
        direct: ModelTransport? = nil,
        sleep: @escaping () async throws -> Void = {},
        now: (() -> TimeInterval)? = nil
    ) throws
        -> GoogleCloudPairingCoordinator {
        let fixedChallenge = try challenge(fixture)
        let transport = direct ?? ModelTransport { _, _ in Data(#"{"id_token":"synthetic-provider-token","token_type":"Bearer"}"#.utf8) }
        return GoogleCloudPairingCoordinator(
            browser: browser ?? ModelBrowser(),
            makeChallenge: { fixedChallenge },
            makeTransport: { transport },
            makeClient: { _, _ in session },
            sleep: sleep,
            now: now ?? { fixture.clock }
        )
    }

    private func configuration(_ fixture: Vectors) -> GoogleCloudPairingConfiguration {
        .init(clientId: fixture.clientIds[0], relayOrigin: URL(string: "https://relay.example.test")!)
    }

    func testOptionalConfigurationValidatesEachExternalFieldAndRegisteredCallbackScheme() throws {
        XCTAssertNil(GoogleCloudPairingConfiguration.configured())
        let id = "fixture-ios.apps.googleusercontent.com"
        let scheme = "com.googleusercontent.apps.fixture-ios"
        let valid: [String: Any] = [
            "OmnesisGoogleClientID": id,
            "OmnesisCloudRelayURL": "https://relay.example.test",
            "CFBundleURLTypes": [["CFBundleURLSchemes": ["unrelated"]], ["CFBundleURLSchemes": [scheme]]],
        ]
        var cases: [[String: Any]] = []
        for field in ["OmnesisGoogleClientID", "OmnesisCloudRelayURL", "CFBundleURLTypes"] {
            var invalid = valid
            invalid.removeValue(forKey: field)
            cases.append(invalid)
        }
        for value: Any in [false, "invalid", "$(MISSING).apps.googleusercontent.com"] {
            var invalid = valid
            invalid["OmnesisGoogleClientID"] = value
            cases.append(invalid)
        }
        for origin in [
            "not a URL",
            "http://relay.example.test",
            "https:/missing-host",
            "https://user@relay.example.test",
            "https://user:password@relay.example.test",
            "https://relay.example.test?query",
            "https://relay.example.test#fragment",
            "https://relay.example.test/path",
        ] {
            var invalid = valid
            invalid["OmnesisCloudRelayURL"] = origin
            cases.append(invalid)
        }
        for callbacks: Any in [[], [["CFBundleURLSchemes": "wrong-type"]], [["CFBundleURLSchemes": ["unrelated"]]]] {
            var invalid = valid
            invalid["CFBundleURLTypes"] = callbacks
            cases.append(invalid)
        }
        for info in cases {
            XCTAssertNil(try GoogleCloudPairingConfiguration.configured(bundle: configurationBundle(info)))
        }
        let accepted = try XCTUnwrap(GoogleCloudPairingConfiguration.configured(bundle: configurationBundle(valid)))
        XCTAssertEqual(accepted.clientId, id)
        XCTAssertEqual(accepted.relayOrigin.absoluteString, "https://relay.example.test")
    }

    private func configurationBundle(_ info: [String: Any]) throws -> Bundle {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("bundle")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try data.write(to: folder.appendingPathComponent("Info.plist"))
        return try XCTUnwrap(Bundle(url: folder))
    }

    func testCancelledTaskResetsCurrentGenerationAndSuspendedCloseCannotResurrectState() async throws {
        let (fixture, _) = try vectors()
        for cancellation in [0, 1, 2] {
            let entered = expectation(description: "Cancellation boundary reached")
            let barrier = ModelBarrier(entered: entered)
            let browser = ModelBrowser(barrier: cancellation == 0 ? barrier : nil)
            let session = try ModelSession(
                pending: confirmation(fixture),
                startError: cancellation == 0 ? nil : .response,
                closeBarrier: cancellation == 0 ? nil : barrier
            )
            let value = try model(fixture, browser: browser, session: session)
            let job = try XCTUnwrap(value.start(configuration: configuration(fixture)))
            await fulfillment(of: [entered], timeout: 2)
            if cancellation == 1 { value.cancel() } else { job.cancel() }
            await barrier.release()
            await job.value
            XCTAssertEqual(value.phase, .idle)
            XCTAssertNil(value.error)
            XCTAssertNil(value.verificationCode)
        }
    }

    func testRemoteApprovalStillWaitsForLocalComparisonAndPairApplicationSucceedsOnlyOnce() async throws {
        let (fixture, _) = try vectors()
        let session = try ModelSession(pending: confirmation(fixture, approved: true))
        let browser = ModelBrowser()
        let value = try model(fixture, browser: browser, session: session)
        value.confirmComparison()
        XCTAssertFalse(value.compared)
        XCTAssertFalse(value.acceptsCompletedPairing(nil, previousGeneration: nil))
        var applications = 0
        await value.complete { _ in applications += 1
            return true
        }
        let job = try XCTUnwrap(value.start(configuration: configuration(fixture)))
        XCTAssertNil(value.start(configuration: configuration(fixture)))
        await job.value
        XCTAssertEqual(browser.calls, 1)
        XCTAssertEqual(value.phase, .comparing)
        XCTAssertNotNil(value.verificationCode)
        XCTAssertEqual(value.gatewayHost, URL(string: fixture.gateway.publicOrigin)?.host)
        await value.complete { _ in applications += 1
            return true
        }
        XCTAssertEqual(applications, 0)
        value.confirmComparison()
        XCTAssertEqual(value.phase, .ready)
        await value.complete { payload in
            applications += 1
            let decoded = try? PairingPayload.decode(from: payload)
            if let decoded, case .v4(let pairing) = decoded {
                XCTAssertEqual(pairing.gatewayUrl, fixture.gateway.publicOrigin)
            } else {
                XCTFail("Strict pairing payload missing")
            }
            return true
        }
        XCTAssertEqual(applications, 1)
        XCTAssertEqual(value.phase, .idle)
        XCTAssertNil(value.verificationCode)
        XCTAssertFalse(value.compared)
    }

    func testBrowserExchangeThroughRealSignedDiscoveryKeepsCredentialBehindBothTrustGates() async throws {
        let (fixture, keys) = try vectors()
        let signedToken = try XCTUnwrap(fixture.tokens["validClient"])
        let binding = try JSONEncoder().encode(fixture.gateway)
        let direct = ModelTransport { url, body in
            switch url.absoluteString {
            case "https://oauth2.googleapis.com/token":
                XCTAssertTrue(String(bytes: body ?? Data(), encoding: .utf8)?.contains("code_verifier=") == true)
                return try JSONSerialization.data(withJSONObject: ["id_token": signedToken, "token_type": "Bearer"])
            case "https://www.googleapis.com/oauth2/v3/certs": return keys
            case "https://relay.example.test/_relay/v1/login":
                return try JSONSerialization.data(withJSONObject: ["token": "routing-test-token", "accountId": fixture.accountId])
            case "https://relay.example.test/_relay/v2/gateway": return binding
            default: throw CloudPairingError.response
            }
        }
        let fixedChallenge = try challenge(fixture)
        let pending = try confirmation(fixture)
        let status = try JSONEncoder().encode(progress(pending, fixture: fixture))
        let gateway = ModelTransport { _, body in
            let request = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? [String: String])
            XCTAssertEqual(request["identityToken"], signedToken)
            XCTAssertEqual(request["secret"], fixedChallenge.secret)
            return status
        }
        let value = GoogleCloudPairingCoordinator(
            browser: ModelBrowser(),
            makeChallenge: { fixedChallenge },
            makeTransport: { direct },
            makeClient: { config, transport in
                try GoogleCloudPairingClient(
                    relayOrigin: config.relayOrigin,
                    clientId: config.clientId,
                    direct: transport,
                    createGateway: { fingerprint in XCTAssertEqual(fingerprint, pending.fingerprint)
                        return gateway
                    },
                    now: { fixture.clock }
                )
            },
            sleep: {},
            now: { fixture.clock }
        )
        await value.start(configuration: configuration(fixture))?.value
        XCTAssertEqual(value.phase, .comparing)
        var applications = 0
        await value.complete { _ in applications += 1
            return true
        }
        XCTAssertEqual(applications, 0)
        value.confirmComparison()
        XCTAssertEqual(value.phase, .ready)
        await value.complete { _ in applications += 1
            return true
        }
        XCTAssertEqual(applications, 1)
        XCTAssertEqual(value.phase, .idle)
    }

    func testComparisonBeforeApprovalTransitionsThroughWaitingAndPollApproval() async throws {
        let (fixture, _) = try vectors()
        let pending = try confirmation(fixture)
        let session = ModelSession(pending: pending, progress: progress(pending, fixture: fixture), pendingPolls: 1)
        let waiting = expectation(description: "Polling paused")
        let gate = ModelBarrier(entered: waiting)
        var sleeps = 0
        let value = try model(fixture, session: session, sleep: { sleeps += 1
            if sleeps == 1 { await gate.wait() }
        })
        let job = try XCTUnwrap(value.start(configuration: configuration(fixture)))
        await fulfillment(of: [waiting], timeout: 2)
        XCTAssertEqual(value.phase, .comparing)
        value.confirmComparison()
        XCTAssertEqual(value.phase, .waiting)
        value.confirmComparison()
        XCTAssertEqual(value.phase, .waiting)
        await gate.release()
        await job.value
        XCTAssertEqual(value.phase, .ready)
        let polls = await session.polls
        XCTAssertEqual(polls, 2)
        value.cancel()
    }

    func testPollApprovalBeforeHumanComparisonStillRequiresExplicitConfirmation() async throws {
        let (fixture, _) = try vectors()
        let pending = try confirmation(fixture)
        let session = ModelSession(pending: pending, progress: progress(pending, fixture: fixture))
        let value = try model(fixture, session: session)
        await value.start(configuration: configuration(fixture))?.value
        XCTAssertEqual(value.phase, .comparing)
        XCTAssertFalse(value.compared)
        var applications = 0
        await value.complete { _ in applications += 1
            return true
        }
        XCTAssertEqual(applications, 0)
        value.confirmComparison()
        XCTAssertEqual(value.phase, .ready)
        value.cancel()
    }

    func testProviderCancellationErrorsMalformedCallbackAndBadTokenNeverReachSessionFactory() async throws {
        let (fixture, _) = try vectors()
        for mode in [ModelBrowser.Mode.cancelled, .providerError, .malformed, .normal] {
            let browser = ModelBrowser(mode: mode)
            let direct = ModelTransport { _, _ in Data(#"{"id_token":"","token_type":"Bearer"}"#.utf8) }
            let fixedChallenge = try challenge(fixture)
            let value = GoogleCloudPairingCoordinator(
                browser: browser,
                makeChallenge: { fixedChallenge },
                makeTransport: { direct },
                makeClient: { _, _ in XCTFail("Invalid authorization reached session")
                    throw CloudPairingError.response
                },
                sleep: {},
                now: { fixture.clock }
            )
            await value.start(configuration: configuration(fixture))?.value
            XCTAssertEqual(value.phase, .failed)
            XCTAssertNotNil(value.error)
            XCTAssertFalse(value.compared)
            XCTAssertNil(value.verificationCode)
            if mode == .cancelled { XCTAssertEqual(value.error as? CloudPairingError, .cancelled) }
            value.cancel()
            XCTAssertNil(value.error)
        }
    }

    func testDiscoveryFailureAndPollExpiryCloseSessionAndAllowRetry() async throws {
        let (fixture, _) = try vectors()
        for failStart in [true, false] {
            let session = try ModelSession(
                pending: confirmation(fixture),
                startError: failStart ? .response : nil,
                pollError: failStart ? nil : .expired
            )
            let value = try model(fixture, session: session)
            await value.start(configuration: configuration(fixture))?.value
            XCTAssertEqual(value.phase, .failed)
            let closes = await session.closes
            XCTAssertEqual(closes, 1)
            let retry = value.start(configuration: configuration(fixture))
            XCTAssertNotNil(retry)
            await retry?.value
            XCTAssertEqual(value.phase, .failed)
            value.cancel()
        }
    }

    func testFailedOrExpiredPairApplicationCannotBeReportedAsPaired() async throws {
        let (fixture, _) = try vectors()
        for expired in [false, true] {
            let clock = ModelClock(fixture.clock)
            let session = try ModelSession(pending: confirmation(fixture, approved: true))
            let value = try model(fixture, session: session, now: { clock.now })
            await value.start(configuration: configuration(fixture))?.value
            value.confirmComparison()
            if expired { clock.now += 600 }
            var applications = 0
            await value.complete { _ in applications += 1
                return false
            }
            XCTAssertEqual(applications, expired ? 0 : 1)
            XCTAssertEqual(value.phase, .failed)
            XCTAssertFalse(value.acceptsCompletedPairing(nil, previousGeneration: nil))
            value.cancel()
        }
    }
}

extension GoogleCloudPairingModelTests {
    func testLateBrowserCallbackCannotOverwriteSuccessfulRetryGeneration() async throws {
        let (fixture, _) = try vectors()
        let entered = expectation(description: "Old browser suspended")
        let barrier = ModelBarrier(entered: entered)
        let browser = ModelBrowser(barrier: barrier)
        let session = try ModelSession(pending: confirmation(fixture, approved: true))
        let value = try model(fixture, browser: browser, session: session)
        let old = try XCTUnwrap(value.start(configuration: configuration(fixture)))
        await fulfillment(of: [entered], timeout: 2)
        value.cancel()
        await value.start(configuration: configuration(fixture))?.value
        value.confirmComparison()
        XCTAssertEqual(value.phase, .ready)
        await barrier.release()
        await old.value
        XCTAssertEqual(value.phase, .ready)
        XCTAssertTrue(value.compared)
        value.cancel()
    }

    func testCancelledBrowserCallbackAndDiscoveryReplyCannotResurrectCancelledState() async throws {
        let (fixture, _) = try vectors()
        for phase in [0, 1, 2] {
            let entered = expectation(description: "Operation suspended")
            let barrier = ModelBarrier(entered: entered)
            let browser = ModelBrowser(barrier: phase == 0 ? barrier : nil)
            let session = try ModelSession(pending: confirmation(fixture, approved: true), startBarrier: phase == 2 ? barrier : nil)
            let direct = ModelTransport { _, _ in
                if phase == 1 { await barrier.wait() }
                return Data(#"{"id_token":"synthetic-provider-token","token_type":"Bearer"}"#.utf8)
            }
            let value = try model(fixture, browser: browser, session: session, direct: direct)
            let job = try XCTUnwrap(value.start(configuration: configuration(fixture)))
            await fulfillment(of: [entered], timeout: 2)
            value.cancel()
            await barrier.release()
            await job.value
            XCTAssertEqual(value.phase, .idle)
            XCTAssertNil(value.verificationCode)
            XCTAssertNil(value.error)
            XCTAssertFalse(value.compared)
        }
    }

    func testCancelledPollAndApplicationCallbacksCannotChangeNewGeneration() async throws {
        let (fixture, _) = try vectors()
        let pending = try confirmation(fixture)
        let entered = expectation(description: "Poll suspended")
        let barrier = ModelBarrier(entered: entered)
        let session = ModelSession(pending: pending, progress: progress(pending, fixture: fixture), pollBarrier: barrier)
        let value = try model(fixture, session: session)
        let job = try XCTUnwrap(value.start(configuration: configuration(fixture)))
        await fulfillment(of: [entered], timeout: 2)
        value.cancel()
        await barrier.release()
        await job.value
        XCTAssertEqual(value.phase, .idle)
        let readySession = try ModelSession(pending: confirmation(fixture, approved: true))
        let ready = try model(fixture, session: readySession)
        await ready.start(configuration: configuration(fixture))?.value
        ready.confirmComparison()
        let applying = expectation(description: "Application suspended")
        let application = ModelBarrier(entered: applying)
        let completion = Task {
            await ready.complete { _ in
                await application.wait()
                return true
            }
        }
        await fulfillment(of: [applying], timeout: 2)
        XCTAssertEqual(ready.phase, .pairing)
        var duplicates = 0
        await ready.complete { _ in duplicates += 1
            return true
        }
        XCTAssertEqual(duplicates, 0)
        ready.cancel()
        await application.release()
        await completion.value
        XCTAssertEqual(ready.phase, .idle)
    }
}

@MainActor
private final class ModelClock {
    var now: TimeInterval
    init(_ now: TimeInterval) {
        self.now = now
    }
}

@MainActor
private final class ModelBrowser: GooglePairingBrowser {
    enum Mode { case normal, cancelled, providerError, malformed }
    private let mode: Mode
    private let barrier: ModelBarrier?
    private(set) var calls = 0
    init(mode: Mode = .normal, barrier: ModelBarrier? = nil) {
        self.mode = mode
        self.barrier = barrier
    }

    func signIn(_ authorization: GoogleNativeAuthorization) async throws -> URL {
        calls += 1
        if calls == 1, let barrier { await barrier.wait() }
        switch mode {
        case .cancelled: throw CloudPairingError.cancelled
        case .providerError: throw CloudPairingError.response
        case .malformed: return URL(string: "\(authorization.redirectURI)?state=forged&code=synthetic")!
        case .normal: return URL(string: "\(authorization.redirectURI)?state=\(authorization.state)&code=synthetic")!
        }
    }

    func cancel() {}
}

private actor ModelBarrier {
    private let entered: XCTestExpectation
    private var continuation: CheckedContinuation<Void, Never>?
    init(entered: XCTestExpectation) {
        self.entered = entered
    }

    func wait() async {
        await withCheckedContinuation { continuation = $0
            entered.fulfill()
        }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

private actor ModelSession: GooglePairingSession {
    private let pending: CloudPairingConfirmation
    private let progress: CloudPairingProgress?
    private let startError: CloudPairingError?
    private let pollError: CloudPairingError?
    private let startBarrier: ModelBarrier?
    private let pollBarrier: ModelBarrier?
    private let closeBarrier: ModelBarrier?
    private let pendingPolls: Int
    private(set) var polls = 0
    private(set) var closes = 0
    init(
        pending: CloudPairingConfirmation,
        progress: CloudPairingProgress? = nil,
        startError: CloudPairingError? = nil,
        pollError: CloudPairingError? = nil,
        startBarrier: ModelBarrier? = nil,
        pollBarrier: ModelBarrier? = nil,
        closeBarrier: ModelBarrier? = nil,
        pendingPolls: Int = 0
    ) {
        self.pending = pending
        self.progress = progress
        self.startError = startError
        self.pollError = pollError
        self.startBarrier = startBarrier
        self.pollBarrier = pollBarrier
        self.closeBarrier = closeBarrier
        self.pendingPolls = pendingPolls
    }

    func start(challenge: CloudPairingChallenge, idToken: String) async throws -> CloudPairingConfirmation {
        if let startBarrier { await startBarrier.wait() }
        if let startError { throw startError }
        return pending
    }

    func poll() async throws -> CloudPairingProgress {
        polls += 1
        if let pollBarrier { await pollBarrier.wait() }
        if let pollError { throw pollError }
        let progress = try XCTUnwrap(progress)
        if polls <= pendingPolls { return .init(
            status: "pending",
            verificationCode: progress.verificationCode,
            expiresAt: progress.expiresAt,
            pairingCode: nil
        ) }
        return progress
    }

    func close() async {
        closes += 1
        if closes == 1, let closeBarrier { await closeBarrier.wait() }
    }
}

private final class ModelTransport: CloudPairingTransport, @unchecked Sendable {
    private let response: @Sendable (URL, Data?) async throws -> Data
    init(response: @escaping @Sendable (URL, Data?) async throws -> Data) {
        self.response = response
    }

    func requestData(url: URL, method: String, body: Data?, bearer: String?, form: Bool) async throws -> Data {
        try await response(url, body)
    }

    func close() {}
}
