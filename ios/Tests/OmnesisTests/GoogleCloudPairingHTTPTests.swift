// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import Security
import XCTest

final class GoogleCloudPairingHTTPTests: XCTestCase {
    private let origin = URL(string: "https://gateway.example.test/devices/google/request")!
    private func client(fingerprint: String? = nil) -> CloudPairingHTTP {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CloudPairingProtocol.self]
        return CloudPairingHTTP(fingerprint: fingerprint, configuration: configuration, verificationDate: TrustFixtures.verifyDate)
    }

    override func tearDown() {
        CloudPairingProtocol.configure { _ in throw URLError(.badServerResponse) }
        super.tearDown()
    }

    func testProductionPinnedFactoryCreatesAnOwnedTransportThatCannotRestartAfterClose() async throws {
        let transport = CloudPairingHTTPFactory().pinnedLeaf(String(repeating: "a", count: 64))
        transport.close()
        do { _ = try await transport.requestData(url: origin, method: "GET", body: nil, bearer: nil, form: false)
            XCTFail("Closed production transport restarted")
        } catch { XCTAssertEqual(error as? CloudPairingError, .cancelled) }
    }

    func testBoundedJSONPostSetsExplicitCredentialsAndNeverPersistsCookies() async throws {
        struct Result: Decodable { let ok: Bool }
        CloudPairingProtocol.configure { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer routing-test-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
            XCTAssertFalse(request.httpShouldHandleCookies)
            return .init(url: request.url!, headers: ["Content-Length": "11"], chunks: [Data(#"{"ok":true}"#.utf8)])
        }
        let transport = client()
        defer { transport.close() }
        let result: Result = try await transport.request(
            url: origin,
            method: "POST",
            body: Data("{}".utf8),
            bearer: "routing-test-token"
        )
        XCTAssertTrue(result.ok)
    }

    func testFormExchangeUsesDirectTokenBodyAndNoGatewayAuthorization() async throws {
        CloudPairingProtocol.configure { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/x-www-form-urlencoded")
            return .init(url: request.url!, chunks: [Data("{}".utf8)])
        }
        let transport = client()
        defer { transport.close() }
        _ = try await transport.requestData(
            url: XCTUnwrap(URL(string: "https://oauth2.googleapis.com/token")),
            method: "POST",
            body: Data("code=synthetic".utf8),
            form: true
        )
    }

    func testOversizedDeclaredOrStreamingBodiesWrongOriginStatusAndDecodingAreRefused() async throws {
        let cases: [CloudPairingProtocol.Reply] = try [
            .init(url: origin, status: 401), .init(url: origin, status: 302),
            .init(url: XCTUnwrap(URL(string: "https://other.example.test/"))),
            .init(url: origin, headers: ["Content-Length": "65537"]),
            .init(url: origin, chunks: [Data(repeating: 32, count: 32768), Data(repeating: 32, count: 32769)]),
        ]
        let transport = client()
        defer { transport.close() }
        for reply in cases {
            CloudPairingProtocol.configure { _ in reply }
            do { _ = try await transport.requestData(url: origin)
                XCTFail("Untrusted response accepted")
            } catch { XCTAssertTrue(error is CloudPairingError) }
        }
        CloudPairingProtocol.configure { request in .init(url: request.url!, chunks: [Data("invalid JSON".utf8)]) }
        struct Value: Decodable { let value: String }
        do { let _: Value = try await transport.request(url: origin)
            XCTFail("Invalid JSON accepted")
        } catch { XCTAssertTrue(error is DecodingError) }
        for url in ["http://gateway.example.test/", "https://user:password@gateway.example.test/"] {
            do { _ = try await transport.requestData(url: XCTUnwrap(URL(string: url)))
                XCTFail("Unsafe origin accepted")
            } catch { XCTAssertEqual(error as? CloudPairingError, .configuration) }
        }
    }

    func testOnlyARequestThatAsksReadsAShortRefusalBody() async throws {
        let transport = client(), named = Data(#"{"error":"no-account"}"#.utf8)
        defer { transport.close() }
        func refusal(_ reply: CloudPairingProtocol.Reply, asking: Bool = true) async -> Error? {
            CloudPairingProtocol.configure { _ in reply }
            do {
                _ = asking ? try await transport.postReportingRefusal(url: origin, body: Data("{}".utf8))
                    : try await transport.requestData(url: origin, method: "POST", body: Data("{}".utf8))
                return nil
            } catch { return error }
        }
        let named403 = CloudPairingProtocol.Reply(url: origin, status: 403, chunks: [named])
        let told = await refusal(named403)
        XCTAssertEqual(told as? CloudPairingRefusal, CloudPairingRefusal(body: named))
        XCTAssertEqual((told as? CloudPairingRefusal)?.reason, "no-account")
        let empty = await refusal(.init(url: origin, status: 403, chunks: []))
        XCTAssertEqual(empty as? CloudPairingRefusal, CloudPairingRefusal(body: Data()))
        XCTAssertNil((empty as? CloudPairingRefusal)?.reason)
        // Every other caller, status and size keeps the bare status.
        let unasked = await refusal(named403, asking: false)
        XCTAssertEqual(unasked as? CloudPairingError, .httpStatus(403))
        for status in [401, 404, 500] {
            let other = await refusal(.init(url: origin, status: status, chunks: [named]))
            XCTAssertEqual(other as? CloudPairingError, .httpStatus(status))
        }
        let long = Data(repeating: 32, count: CloudPairingRefusal.bodyLimit + 1)
        let declared = await refusal(.init(url: origin, status: 403, headers: ["Content-Length": "\(long.count)"], chunks: [long]))
        XCTAssertEqual(declared as? CloudPairingError, .httpStatus(403))
        let streamed = await refusal(.init(url: origin, status: 403, chunks: [named, long]))
        XCTAssertEqual(streamed as? CloudPairingError, .httpStatus(403))
        let moved = try await refusal(.init(url: XCTUnwrap(URL(string: "https://other.example.test/")), status: 403, chunks: [named]))
        XCTAssertEqual(moved as? CloudPairingError, .httpStatus(403))
        let ok = await refusal(.init(url: origin, chunks: [Data("{}".utf8)]))
        XCTAssertNil(ok)
        XCTAssertNil(CloudPairingRefusal(body: Data(#"{"error":"no-account","pad":""#.utf8) + long + Data(#""}"#.utf8)).reason)
        for body in ["no-account", #""no-account""#, #"["no-account"]"#, "{}", #"{"error":null}"#, #"{"error":403}"#] {
            XCTAssertNil(CloudPairingRefusal(body: Data(body.utf8)).reason, body)
        }
    }

    func testCancellationInterruptsAWaitingRequest() async throws {
        let started = expectation(description: "Request started")
        CloudPairingProtocol.configure { request in started.fulfill()
            return .init(url: request.url!, stall: true)
        }
        let transport = client()
        defer { transport.close() }
        let task = Task { try await transport.requestData(url: origin) }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        do { _ = try await task.value
            XCTFail("Cancelled request completed")
        } catch {
            XCTAssertTrue(error is CancellationError || (error as? URLError)?
                .code == .cancelled || (error as? CloudPairingError) == .cancelled)
        }
    }

    func testRedirectDelegateNeverForwardsOAuthCodesOrPairingSecrets() throws {
        let transport = client()
        defer { transport.close() }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let request = URLRequest(url: origin)
        let response = try XCTUnwrap(HTTPURLResponse(url: origin, statusCode: 307, httpVersion: nil, headerFields: nil))
        let target = try URLRequest(url: XCTUnwrap(URL(string: "https://other.example.test/")))
        var forwarded = true
        transport
            .urlSession(session, task: session.dataTask(with: request), willPerformHTTPRedirection: response, newRequest: target) {
                forwarded = $0 != nil
            }
        XCTAssertFalse(forwarded)
    }

    func testConcurrentFirstRequestsShareTheSessionAndCloseCancelsEveryStream() async throws {
        let ready = expectation(description: "All streams open")
        let stopped = expectation(description: "All streams closed")
        ready.expectedFulfillmentCount = 16
        stopped.expectedFulfillmentCount = 16
        CloudPairingProtocol.configure { request in
            .init(
                url: request.url!,
                chunks: [Data([123])],
                leaveOpen: true,
                onStop: { stopped.fulfill() },
                onReady: { ready.fulfill() }
            )
        }
        let transport = client()
        let requests = (0 ..< 16).map { _ in
            Task {
                do {
                    _ = try await transport.requestData(url: origin)
                    XCTFail("Closed stream completed")
                } catch {
                    XCTAssertTrue(error is CancellationError || (error as? URLError)?
                        .code == .cancelled || (error as? CloudPairingError) == .cancelled)
                }
            }
        }
        await fulfillment(of: [ready], timeout: 3)
        transport.close()
        await fulfillment(of: [stopped], timeout: 3)
        for request in requests {
            await request.value
        }
        transport.close()
        do { _ = try await transport.requestData(url: origin)
            XCTFail("Closed transport restarted")
        } catch { XCTAssertEqual(error as? CloudPairingError, .cancelled) }
    }

    func testGatewayChallengesRequireTheExactPinAndGoogleChallengesUsePlatformTrust() throws {
        let trust = try TrustFixtures.servedTrust(TrustFixtures.leafOne)
        let challenge = URLAuthenticationChallenge(
            protectionSpace: CloudServerTrust(trust: trust),
            proposedCredential: nil,
            previousFailureCount: 0,
            failureResponse: nil,
            error: nil,
            sender: CloudChallengeSender()
        )
        let pin = try TrustFixtures.fingerprint(TrustFixtures.leafOne)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        for (fingerprint, expected) in [
            (pin as String?, URLSession.AuthChallengeDisposition.useCredential),
            (String(repeating: "0", count: 64), .cancelAuthenticationChallenge),
            (
                nil,
                .performDefaultHandling
            ),
        ] {
            let transport = client(fingerprint: fingerprint)
            defer { transport.close() }
            var actual: URLSession.AuthChallengeDisposition?
            transport.urlSession(session, didReceive: challenge) { actual = $0
                _ = $1
            }
            XCTAssertEqual(actual, expected)
        }
    }

    func testCancellationBeforeTaskInstallationCancelsTheSuspendedSDKTaskWithoutStartingIO() {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let cancellation = CloudPairingHTTP.Cancellation()
        cancellation.cancel()
        let task = session.dataTask(with: origin)
        XCTAssertEqual(task.state, .suspended)
        cancellation.install(task)
        XCTAssertTrue(task.state == .canceling || task.state == .completed)
        cancellation.cancel()
    }

    func testClosedTransportRejectsAuthenticationEvenWithAnOtherwiseValidPin() throws {
        let trust = try TrustFixtures.servedTrust(TrustFixtures.leafOne)
        let challenge = URLAuthenticationChallenge(
            protectionSpace: CloudServerTrust(trust: trust),
            proposedCredential: nil,
            previousFailureCount: 0,
            failureResponse: nil,
            error: nil,
            sender: CloudChallengeSender()
        )
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let transport = try client(fingerprint: TrustFixtures.fingerprint(TrustFixtures.leafOne))
        transport.close()
        transport.urlSession(session, didReceive: challenge) { disposition, credential in
            XCTAssertEqual(disposition, .cancelAuthenticationChallenge)
            XCTAssertNil(credential)
        }
    }

    func testMissingOrNonHTTPResponsesFailClosedAndLateDelegateEventsCannotResumeTwice() async throws {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        for nonHTTPResponse in [false, true] {
            let transport = client()
            defer { transport.close() }
            do {
                let _: Data = try await withCheckedThrowingContinuation { continuation in
                    do {
                        // Register a suspended SDK task: exercise delegate input invariants without starting network IO.
                        let task = try transport.begin(URLRequest(url: origin), continuation: continuation)
                        defer { task.cancel() }
                        if nonHTTPResponse {
                            let response = URLResponse(url: origin, mimeType: nil, expectedContentLength: 0, textEncodingName: nil)
                            transport.urlSession(session, dataTask: task, didReceive: response) { XCTAssertEqual($0, .cancel) }
                        } else {
                            transport.urlSession(session, task: task, didCompleteWithError: nil)
                        }
                        let late = HTTPURLResponse(url: origin, statusCode: 200, httpVersion: nil, headerFields: nil)!
                        transport.urlSession(session, dataTask: task, didReceive: late) { XCTAssertEqual($0, .cancel) }
                        transport.urlSession(session, dataTask: task, didReceive: Data("late pairing material".utf8))
                        transport.urlSession(session, task: task, didCompleteWithError: URLError(.cancelled))
                    } catch { continuation.resume(throwing: error) }
                }
                XCTFail("A response without an accepted HTTP envelope succeeded")
            } catch { XCTAssertEqual(error as? CloudPairingError, .response) }
        }
    }
}

private final class CloudPairingProtocol: URLProtocol, @unchecked Sendable {
    struct Reply: Sendable {
        let url: URL
        var status: Int = 200
        var headers: [String: String] = [:]
        var chunks: [Data] = [Data("{}".utf8)]
        var stall: Bool = false
        var leaveOpen: Bool = false
        var onStop: @Sendable () -> Void = {}
        var onReady: @Sendable () -> Void = {}
    }

    private static let lock = NSLock()
    private nonisolated(unsafe) static var handler: @Sendable (URLRequest) throws -> Reply = { _ in throw URLError(.badServerResponse) }
    private var onStop: @Sendable () -> Void = {}
    static func configure(_ value: @escaping @Sendable (URLRequest) throws -> Reply) {
        lock.lock()
        defer { lock.unlock() }
        handler = value
    }

    // URLProtocol requires a class override; a static method cannot override it.
    // swiftlint:disable:next static_over_final_class
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    // URLProtocol requires a class override; a static method cannot override it.
    // swiftlint:disable:next static_over_final_class
    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        do {
            Self.lock.lock()
            let handler = Self.handler
            Self.lock.unlock()
            let reply = try handler(request)
            onStop = reply.onStop
            if reply.stall { return }
            let response = HTTPURLResponse(url: reply.url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            for data in reply.chunks {
                client?.urlProtocol(self, didLoad: data)
            }
            reply.onReady()
            if !reply.leaveOpen { client?.urlProtocolDidFinishLoading(self) }
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }

    override func stopLoading() {
        onStop()
    }
}

private final class CloudServerTrust: URLProtectionSpace {
    private let value: SecTrust
    init(trust: SecTrust) {
        value = trust
        super.init(
            host: TrustFixtures.host,
            port: 443,
            protocol: NSURLProtectionSpaceHTTPS,
            realm: nil,
            authenticationMethod: NSURLAuthenticationMethodServerTrust
        )
    }

    @available(*, unavailable) required init?(coder: NSCoder) {
        fatalError("not coded")
    }

    override var serverTrust: SecTrust? {
        value
    }
}

private final class CloudChallengeSender: NSObject, URLAuthenticationChallengeSender {
    func use(_: URLCredential, for _: URLAuthenticationChallenge) {}
    func continueWithoutCredential(for _: URLAuthenticationChallenge) {}
    func cancel(_: URLAuthenticationChallenge) {}
}
