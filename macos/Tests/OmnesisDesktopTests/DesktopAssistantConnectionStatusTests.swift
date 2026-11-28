// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopAssistantConnectionStatusTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000

    private func snapshot(credential: [String: Any]? = nil, grant: [String: Any] = [:]) throws -> DesktopAssistantAccess {
        let base: [String: Any] = ["revokedAt": NSNull(), "expiresAt": NSNull(), "credentials": credential.map { [$0] } ?? []]
        let body: [String: Any] = ["principals": [[
            "name": "Invented assistant",
            "kind": "interactive",
            "revokedAt": NSNull(),
            "grants": [base.merging(grant, uniquingKeysWith: { _, next in next })],
        ]]]
        return try JSONDecoder().decode(DesktopAssistantAccess.self, from: JSONSerialization.data(withJSONObject: body))
    }

    private var credential: [String: Any] {
        [
            "kind": "interactive",
            "oauthClientId": "invented-oauth-client",
            "status": "active",
            "revokedAt": NSNull(),
            "expiresAt": NSNull(),
            "lastUsedAt": NSNull(),
        ]
    }

    func testPermissionSignInAndHistoricalMcpReachAreDifferentObservedStates() throws {
        XCTAssertEqual(try snapshot().progress(now: now), .permission)
        var value = credential
        value["status"] = "pending"
        XCTAssertEqual(try snapshot(credential: value).progress(now: now), .pending)
        XCTAssertEqual(try snapshot(credential: credential).progress(now: now), .signedIn)
        value = credential
        value["lastUsedAt"] = now - 5000
        XCTAssertEqual(try snapshot(credential: value).progress(now: now), .reached(now - 5000))
        value["lastUsedAt"] = now + 1
        XCTAssertEqual(try snapshot(credential: value).progress(now: now), .unknown)
    }

    func testLegacyGenericUsageMissingTimesAndMalformedTimesNeverProveMcpReach() throws {
        for key in ["kind", "oauthClientId", "expiresAt", "revokedAt", "lastUsedAt"] {
            var value = credential
            value["lastUsedAt"] = now - 1
            value.removeValue(forKey: key)
            XCTAssertEqual(try snapshot(credential: value).progress(now: now), .unknown, key)
        }
        for invalid in [true, "yesterday", -1, 0, Int64.max, Int64(8_640_000_000_000_001)] as [Any] {
            var value = credential
            value["lastUsedAt"] = invalid
            XCTAssertThrowsError(try snapshot(credential: value))
        }
    }

    func testExpiredRevokedAndFutureRevocationDoNotRetainObservedCompletion() throws {
        var used = credential
        used["lastUsedAt"] = now - 1
        for key in ["expiresAt", "revokedAt"] {
            var value = used
            value[key] = now
            XCTAssertEqual(try snapshot(credential: value).progress(now: now), .reconnect)
            XCTAssertEqual(try snapshot(credential: used, grant: [key: now]).progress(now: now), .reconnect)
        }
        used["revokedAt"] = now + 1
        XCTAssertEqual(try snapshot(credential: used).progress(now: now), .unknown)
    }

    func testOwnedHttpPersistedStatusSurvivesReentryAndRefreshIsGetOnly() async throws {
        let fixture = try await AssistantHTTP.start()
        defer { fixture.stop() }
        try await fixture.configure(body: body(used: Int64(Date().timeIntervalSince1970 * 1000) - 5000))
        let context = DesktopAPIContext(api: fixture.api, id: 1)
        for _ in 0 ..< 2 {
            let model = DesktopAssistantConnections()
            model.bind(context)
            await model.refresh(context: context)
            guard case .reached = model.progress else { return XCTFail("Persisted OAuth MCP usage was not read") }
            await model.stop()
        }
        let requests = try await fixture.requests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(requests.allSatisfy { $0["method"] as? String == "GET" && $0["path"] as? String == "/admin/access" })
    }

    func testOwnedHttpRevocationAndFailedRefreshRemovePriorObservedProgress() async throws {
        let fixture = try await AssistantHTTP.start()
        defer { fixture.stop() }
        let model = DesktopAssistantConnections()
        let context = DesktopAPIContext(api: fixture.api, id: 1)
        model.bind(context)
        try await fixture.configure(body: body(used: Int64(Date().timeIntervalSince1970 * 1000) - 5000))
        await model.refresh(context: context)
        guard case .reached = model.progress else { return XCTFail("Expected the fixture's persisted usage") }
        var revoked = credential
        revoked["revokedAt"] = Int64(Date().timeIntervalSince1970 * 1000) - 100
        let response: [String: Any] = ["principals": [[
            "name": "Invented assistant",
            "kind": "interactive",
            "revokedAt": NSNull(),
            "grants": [[
                "revokedAt": NSNull(),
                "expiresAt": NSNull(),
                "credentials": [revoked],
            ]],
        ]]]
        try await fixture.configure(body: response)
        await model.refresh(context: context)
        XCTAssertEqual(model.progress, .reconnect)
        try await fixture.configure(body: [:], status: 500)
        await model.refresh(context: context)
        XCTAssertEqual(model.progress, .unknown)
        XCTAssertTrue(model.failure)
        await model.stop()
    }

    func testConcurrentRefreshAwaitsOneAppliedReplyAndCancellationJoins() async throws {
        let fixture = try await AssistantHTTP.start()
        defer { fixture.stop() }
        try await fixture.configure(body: body(), hold: true)
        let model = DesktopAssistantConnections()
        let context = DesktopAPIContext(api: fixture.api, id: 1)
        model.bind(context)
        let first = Task { await model.refresh(context: context) }
        try await wait { try await fixture.requests().count == 1 }
        let second = Task { await model.refresh(context: context) }
        await Task.yield()
        XCTAssertTrue(model.checking)
        try await fixture.release()
        await first.value
        await second.value
        XCTAssertEqual(model.progress, .signedIn)
        let coalesced = try await fixture.requests()
        XCTAssertEqual(coalesced.count, 1)
        try await fixture.configure(body: body(), hold: true)
        let held = Task { await model.refresh(context: context) }
        try await wait { try await fixture.requests().count == 2 }
        await model.stop()
        await held.value
        XCTAssertFalse(model.checking)
        XCTAssertEqual(model.progress, .unknown)
        try await fixture.release()
    }

    func testLeavingObserverCancelsAndJoinsAnExplicitCheckThatStartedFirst() async throws {
        let fixture = try await AssistantHTTP.start()
        defer { fixture.stop() }
        try await fixture.configure(body: body(), hold: true)
        let context = DesktopAPIContext(api: fixture.api, id: 1)
        let model = DesktopAssistantConnections()
        model.bind(context)
        var explicitFinished = false
        let explicit = Task {
            await model.refresh(context: context)
            explicitFinished = true
        }
        defer { explicit.cancel() }
        try await wait { try await fixture.requests().count == 1 }
        var observerEntered = false
        var observerFinished = false
        let observer = Task {
            observerEntered = true
            await model.observe(context)
            observerFinished = true
        }
        defer { observer.cancel() }
        try await wait { observerEntered }
        XCTAssertTrue(model.checking)
        XCTAssertFalse(explicitFinished)
        observer.cancel()
        // The server response stays held until both caller tasks have physically returned.
        try await wait { observerFinished && explicitFinished }
        await observer.value
        await explicit.value
        XCTAssertFalse(model.checking)
        XCTAssertEqual(model.progress, .unknown)
        let requests = try await fixture.requests()
        XCTAssertEqual(requests.count, 1)
        try await fixture.release()
    }

    func testObsoleteCallerCannotStartOrCancelTheReplacementScopesHeldRead() async throws {
        let fixture = try await AssistantHTTP.start()
        defer { fixture.stop() }
        try await fixture.configure(body: body(), hold: true)
        let a = DesktopAPIContext(api: fixture.api, id: 1)
        let b = DesktopAPIContext(api: fixture.api, id: 2)
        let model = DesktopAssistantConnections()
        model.bind(a)
        model.bind(b)
        var currentFinished = false
        let current = Task {
            await model.refresh(context: b)
            currentFinished = true
        }
        defer { current.cancel() }
        try await wait { try await fixture.requests().count == 1 }
        let obsolete = Task { await model.refresh(context: a) }
        obsolete.cancel()
        await obsolete.value
        var staleFinished = false
        let stale = Task {
            await model.refresh(context: a)
            staleFinished = true
        }
        defer { stale.cancel() }
        try await wait { staleFinished }
        await stale.value
        XCTAssertTrue(model.checking)
        XCTAssertFalse(currentFinished)
        let requests = try await fixture.requests()
        XCTAssertEqual(requests.count, 1)
        try await fixture.release()
        await current.value
        XCTAssertEqual(model.progress, .signedIn)
        await model.stop()
    }

    func testLateOldApiCannotPublishIntoFailedReplacementOrAbaScope() async throws {
        let a = try await AssistantHTTP.start(), b = try await AssistantHTTP.start()
        defer { a.stop()
            b.stop()
        }
        try await a.configure(body: body(used: Int64(Date().timeIntervalSince1970 * 1000) - 10), hold: true)
        try await b.configure(body: [:], status: 500)
        let model = DesktopAssistantConnections()
        let contextA = DesktopAPIContext(api: a.api, id: 1)
        model.bind(contextA)
        let pending = Task { await model.refresh(context: contextA) }
        try await wait { try await a.requests().count == 1 }
        contextA.invalidate()
        let contextB = DesktopAPIContext(api: b.api, id: 2, predecessor: contextA)
        model.bind(contextB)
        XCTAssertEqual(model.progress, .unknown)
        await model.refresh(context: contextB)
        await pending.value
        XCTAssertTrue(model.failure)
        try await a.release()
        XCTAssertEqual(model.progress, .unknown)
        try await a.configure(body: ["principals": []])
        let replacementA = DesktopAPIContext(api: a.api, id: 3)
        model.bind(replacementA)
        await model.refresh(context: replacementA)
        XCTAssertEqual(model.progress, .none)
        await model.stop()
    }

    func testOwnedObservationRechecksAtCredentialExpiryInsteadOfKeepingCompletion() async throws {
        let fixture = try await AssistantHTTP.start()
        defer { fixture.stop() }
        var response = body(used: Int64(Date().timeIntervalSince1970 * 1000) - 5000)
        let expiry = Int64(Date().timeIntervalSince1970 * 1000) + 800
        var principals = try XCTUnwrap(response["principals"] as? [[String: Any]])
        var grants = try XCTUnwrap(principals[0]["grants"] as? [[String: Any]])
        var credentials = try XCTUnwrap(grants[0]["credentials"] as? [[String: Any]])
        credentials[0]["expiresAt"] = expiry
        grants[0]["credentials"] = credentials
        principals[0]["grants"] = grants
        response["principals"] = principals
        try await fixture.configure(body: response)
        let model = DesktopAssistantConnections()
        let observer = Task { await model.observe(DesktopAPIContext(api: fixture.api, id: 1)) }
        try await wait { if case .reached = model.progress { return true }
            return false
        }
        try await wait { model.progress == .reconnect }
        observer.cancel()
        await observer.value
        XCTAssertEqual(model.progress, .unknown)
    }

    func testNativeStatusRendersPermissionUsageAndUnavailableWithoutSuccessClaims() async throws {
        let fixture = try await AssistantHTTP.start()
        defer { fixture.stop() }
        let model = DesktopAssistantConnections()
        let context = DesktopAPIContext(api: fixture.api, id: 1)
        model.bind(context)
        let renders: [(String, [String: Any], String)] = [
            (
                "permission",
                ["principals": [[
                    "name": "Invented assistant",
                    "kind": "interactive",
                    "revokedAt": NSNull(),
                    "grants": [["revokedAt": NSNull(), "expiresAt": NSNull(), "credentials": []]],
                ]]],
                "Permission saved"
            ),
            ("reached", body(used: Int64(Date().timeIntervalSince1970 * 1000) - 5000), "not an answer"),
            ("legacy", ["principals": [["name": "Invented assistant", "kind": "interactive", "grants": []]]], "could not be confirmed"),
        ]
        for (name, response, expected) in renders {
            try await fixture.configure(body: response)
            await model.refresh(context: context)
            try await DesktopSnapshotRenderer.render(
                DesktopAssistantStatusView(model: model),
                name: "assistant-status-" + name,
                size: CGSize(width: 680, height: 220)
            ) { view in
                XCTAssertTrue(try DesktopAccessibilityDriver.contains(expected, in: view))
                XCTAssertFalse(try DesktopAccessibilityDriver.contains("online now", in: view))
            }
        }
        await model.stop()
    }

    private func body(used: Int64? = nil) -> [String: Any] {
        var value = credential
        if let used { value["lastUsedAt"] = used }
        return ["principals": [[
            "name": "Invented assistant",
            "kind": "interactive",
            "revokedAt": NSNull(),
            "grants": [["revokedAt": NSNull(), "expiresAt": NSNull(), "credentials": [value]]],
        ]]]
    }

    private func wait(_ predicate: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < deadline {
            if try await predicate() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Assistant observation did not reach the expected scoped state")
        throw URLError(.timedOut)
    }
}

@MainActor
private final class AssistantHTTP {
    let process: ScriptedAgentFixture
    let api: DesktopAPI
    private let session = URLSession(configuration: .ephemeral)
    init(_ process: ScriptedAgentFixture) throws {
        self.process = process
        api = try DesktopAPI(connection: JSONDecoder().decode(
            DesktopConnection.self,
            from: JSONSerialization.data(withJSONObject: [
                "url": process.url.absoluteString,
                "token": "gui-fixture-token",
            ])
        ))
    }

    static func start() async throws -> AssistantHTTP {
        let process = try await ScriptedAgentFixture.start(scriptName: "api-context-fixture.mjs")
        do { return try AssistantHTTP(process) } catch { process.stop()
            throw error
        }
    }

    func stop() {
        session.invalidateAndCancel()
        process.stop()
    }

    func configure(body: [String: Any], status: Int = 200, hold: Bool = false) async throws {
        _ = try await control("fixture-config", body: ["routes": ["GET /admin/access": ["body": body, "status": status, "hold": hold]]])
    }

    func release() async throws {
        _ = try await control("fixture-release", body: [:])
    }

    func requests() async throws -> [[String: Any]] {
        let data = try await control("fixture-context-status")
        return try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: Any])?["requests"] as? [[String: Any]])
    }

    private func control(_ path: String, body: [String: Any]? = nil) async throws -> Data {
        var request = URLRequest(url: process.url.appendingPathComponent(path))
        request.setValue("Bearer gui-fixture-token", forHTTPHeaderField: "Authorization")
        if let body { request.httpMethod = "POST"
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return data
    }
}
