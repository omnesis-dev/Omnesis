// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
@testable import OmnesisDesktop
import SwiftUI
import XCTest

private final class RecordingReviewProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var pending: [RecordingReviewProtocol] = []
    private static var received = 0
    private var stopped = false
    static func take() -> RecordingReviewProtocol? {
        lock.withLock { pending.isEmpty ? nil : pending.removeFirst() }
    }

    static var count: Int {
        lock.withLock { received }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard request.httpMethod == "GET", request.url?.host == "localhost",
              request.url?.path == "/admin/recordings/restore-review",
              request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token" else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        Self.lock.withLock { Self.received += 1
            Self.pending.append(self)
        }
    }

    override func stopLoading() {
        Self.lock.withLock { stopped = true
            Self.pending.removeAll { $0 === self }
        }
    }

    func reply(_ body: String, status: Int = 200) {
        guard Self.lock.withLock({ !stopped }) else { return }
        client?.urlProtocol(
            self,
            didReceive: HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!,
            cacheStoragePolicy: .notAllowed
        )
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
final class DesktopRecordingRestoreReviewTests: XCTestCase {
    private func body(required: Bool) -> String {
        "{\"reviewRequired\":\(required),\"hasPendingChunks\":true,\"keepAudioDays\":7,\"transcriberAssignment\":null,\"speakers\":\"off\",\"version\":\"" +
            String(
                repeating: "a",
                count: 64
            ) + "\"}"
    }

    private func api() throws -> DesktopAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RecordingReviewProtocol.self]
        let session = URLSession(configuration: config)
        addTeardownBlock { session.invalidateAndCancel() }
        let connection = try JSONDecoder().decode(
            DesktopConnection.self,
            from: Data(#"{"url":"http://localhost","token":"fixture-token"}"#.utf8)
        )
        return try DesktopAPI(connection: connection, sessionOverride: session)
    }

    private func request() async throws -> RecordingReviewProtocol {
        let end = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < end {
            if let request = RecordingReviewProtocol.take() { return request }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw URLError(.timedOut)
    }

    private func check(
        _ flow: DesktopRecordingReviewFlow,
        api: DesktopAPI,
        restore: Bool = false,
        status: Int = 200,
        json: String? = nil
    ) async throws {
        let task = Task { await flow.refresh(api: api, afterRestore: restore, isCurrent: { true }) }
        try await request().reply(json ?? body(required: true), status: status)
        await task.value
    }

    func testVerifiedRestoreWithoutCurrentApiIsUnverified() async {
        let flow = DesktopRecordingReviewFlow()
        await flow.refresh(api: nil, afterRestore: true, isCurrent: { true })
        XCTAssertEqual(flow.state, .unverified)
    }

    func testAuthoritativeRequiredAndFalseUseOnlyAuthenticatedGet() async throws {
        let flow = DesktopRecordingReviewFlow(), api = try api()
        try await check(flow, api: api)
        XCTAssertEqual(flow.state, .required)
        try await check(flow, api: api, json: body(required: false))
        XCTAssertEqual(flow.state, .hidden)
    }

    func testLegacyAndNonAdminHideOnlyWithoutRestoreOrPriorRequiredEvidence() async throws {
        for code in [403, 404] {
            let flow = DesktopRecordingReviewFlow(), api = try api()
            try await check(flow, api: api, status: code, json: "{}")
            XCTAssertEqual(flow.state, .hidden)
            try await check(flow, api: api, restore: true, status: code, json: "{}")
            XCTAssertEqual(flow.state, .unverified)
            try await check(flow, api: api)
            try await check(flow, api: api, status: code, json: "{}")
            XCTAssertEqual(flow.state, .requiredUnverified)
        }
    }

    func testMalformedMetadataAndFailedCheckCannotClearKnownRequired() async throws {
        let flow = DesktopRecordingReviewFlow(), api = try api()
        try await check(flow, api: api)
        let newlineVersion = body(required: false).replacingOccurrences(
            of: String(repeating: "a", count: 64), with: String(repeating: "a", count: 64) + "\\n"
        )
        for invalid in [
            body(required: false).replacingOccurrences(of: "\"keepAudioDays\":7", with: "\"keepAudioDays\":366"),
            newlineVersion,
            "{}",
        ] {
            try await check(flow, api: api, json: invalid)
            XCTAssertEqual(flow.state, .requiredUnverified)
        }
        try await check(flow, api: api, status: 503, json: "{}")
        XCTAssertEqual(flow.state, .requiredUnverified)
    }

    func testReplacedApiDiscardsOldRequiredAndLateSuccess() async throws {
        let flow = DesktopRecordingReviewFlow(), first = try api(), second = try api()
        var current: DesktopAPI? = first
        let old = Task { await flow.refresh(api: first, afterRestore: false, isCurrent: { current === first }) }
        let oldRequest = try await request()
        current = second
        let next = Task { await flow.refresh(api: second, afterRestore: false, isCurrent: { current === second }) }
        let nextRequest = try await request()
        XCTAssertEqual(flow.state, .hidden)
        oldRequest.reply(body(required: true))
        nextRequest.reply(body(required: false))
        await old.value
        await next.value
        XCTAssertEqual(flow.state, .hidden)
    }

    func testNewApiNeverDisplaysPreviousRequiredEvidenceBeforeItsTaskStarts() async throws {
        let flow = DesktopRecordingReviewFlow(), first = try api(), second = try api()
        try await check(flow, api: first)
        XCTAssertEqual(flow.state, .required)
        XCTAssertEqual(flow.displayedState(api: second, afterRestore: false), .hidden)
        XCTAssertEqual(flow.displayedState(api: second, afterRestore: true), .unverified)
    }

    func testConcurrentRefreshJoinsAppliedResultWithoutSecondRequest() async throws {
        let flow = DesktopRecordingReviewFlow(), api = try api()
        let before = RecordingReviewProtocol.count
        let first = Task { await flow.refresh(api: api, afterRestore: true, isCurrent: { true }) }
        let pending = try await request()
        let second = Task { await flow.refresh(api: api, afterRestore: true, isCurrent: { true }) }
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(RecordingReviewProtocol.count, before + 1)
        pending.reply(body(required: true))
        await first.value
        await second.value
        XCTAssertEqual(flow.state, .required)
        XCTAssertEqual(RecordingReviewProtocol.count, before + 1)
    }

    func testCancellationJoinsBeforeNextScopeAndDoesNotApplyCanceledResult() async throws {
        let flow = DesktopRecordingReviewFlow(), api = try api()
        let task = Task { await flow.refresh(api: api, afterRestore: true, isCurrent: { true }) }
        let pending = try await request()
        flow.cancel()
        await flow.drain()
        await task.value
        pending.reply(body(required: false))
        XCTAssertNotEqual(flow.state, .required)
        try await check(flow, api: api)
        XCTAssertEqual(flow.state, .required)
    }

    func testRequiredPortalActionDoesNotAcknowledgeOrResumeReview() async throws {
        let flow = DesktopRecordingReviewFlow(), api = try api()
        try await check(flow, api: api)
        var opens = 0
        try await DesktopSnapshotRenderer.render(
            DesktopRecordingReviewContent(state: flow.state, openPortal: { opens += 1 }, check: {}),
            name: "restored-recordings-required",
            size: CGSize(width: 620, height: 240)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Restored recordings are paused", in: view))
            try DesktopAccessibilityDriver.press("recording-review-portal", in: view)
            XCTAssertEqual(flow.state, .required)
        }
        XCTAssertEqual(opens, 2)
    }

    func testUnknownRestoreReviewRenderDoesNotClaimResumed() async throws {
        let flow = DesktopRecordingReviewFlow(), api = try api()
        try await check(flow, api: api, restore: true, status: 404, json: "{}")
        try await DesktopSnapshotRenderer.render(
            DesktopRecordingReviewContent(state: flow.state, openPortal: {}, check: {}),
            name: "restored-recordings-unverified",
            size: CGSize(width: 620, height: 220)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Recording review could not be checked", in: view))
            XCTAssertNotNil(try DesktopAccessibilityDriver.element("recording-review-check", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Restored recordings are paused", in: view))
        }
    }
}
