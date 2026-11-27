// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation
import Omnesis
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopConnectionsTests: XCTestCase {
    func testReadyAuthorizedRelayIsTheOnlyCopiedAddress() async throws {
        let script = ScriptedDesktopHTTP { request in
            switch request.url?.path {
            case "/admin/cloud-relay": return #"{"enabled":true,"publicMcp":{"ready":true,"url":"https://library.example.com/mcp"}}"#
            case "/admin/access": return Self.overviewJSON
            default: throw URLError(.unsupportedURL)
            }
        }
        let fixture = try makeAPI(script: script)
        defer { fixture.cleanup() }
        let model = DesktopConnections()
        await model.load(context: DesktopAPIContext(api: fixture.api, id: 1))
        XCTAssertEqual(model.mcpURL?.absoluteString, "https://library.example.com/mcp")
        XCTAssertEqual(model.gatewayOrigin?.absoluteString, "https://library.example.com")
        XCTAssertNil(model.failure)
    }

    func testRelayAddressOutsideAuthorizedResourcesIsNotOffered() async throws {
        let script = ScriptedDesktopHTTP { request in
            request.url?.path == "/admin/cloud-relay"
                ? #"{"enabled":true,"publicMcp":{"ready":true,"url":"https://other.example.com/mcp"}}"#
                : Self.overviewJSON
        }
        let fixture = try makeAPI(script: script)
        defer { fixture.cleanup() }
        let model = DesktopConnections()
        await model.load(context: DesktopAPIContext(api: fixture.api, id: 1))
        XCTAssertNil(model.mcpURL)
        XCTAssertNil(model.gatewayOrigin)
        XCTAssertNotNil(model.failure)
    }

    func testUnrelatedPhoneDoesNotConsumeCodeAndExplicitCloseWithdrawsCanonicalGrant() async throws {
        let expiry = Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)
        let roster = PhoneRosterSequence()
        let script = ScriptedDesktopHTTP { request in
            let body = try Self.body(request)
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/admin/devices"):
                return roster.next()
            case ("POST", "/admin/devices/pair"):
                XCTAssertEqual(body["kind"] as? String, "ios")
                XCTAssertNil(body["scopes"])
                return #"{"pairingCode":"invented-code","expiresAt":\#(expiry)}"#
            case ("POST", "/admin/devices/pair-addresses"):
                return #"{"platform":"ios","addresses":[{"gatewayUrl":"https://localhost:17601","host":"localhost","label":"Local","usable":true,"systemTrust":false},{"gatewayUrl":"https://library.example.com","host":"library.example.com","label":"Omnesis","usable":true,"systemTrust":true,"kind":"relay"}],"recommendedUrl":"https://localhost:17601"}"#
            case ("POST", "/admin/devices/pair-qr"):
                XCTAssertEqual(body["gatewayUrl"] as? String, "https://library.example.com")
                XCTAssertEqual(body["pairingCode"] as? String, "invented-code")
                return #"{"qrPayload":"invented-server-encoded-qr"}"#
            case ("DELETE", "/admin/devices/pair"):
                XCTAssertEqual(body["pairingCode"] as? String, "invented-code")
                return #"{"revoked":true}"#
            default: throw URLError(.unsupportedURL)
            }
        }
        let fixture = try makeAPI(script: script)
        defer { fixture.cleanup() }
        let model = DesktopPhonePairing()
        let context = DesktopAPIContext(api: fixture.api, id: 1)
        try await model.start(context: context, gatewayOrigin: XCTUnwrap(URL(string: "https://library.example.com")))
        XCTAssertEqual(model.payload, "invented-server-encoded-qr")
        XCTAssertTrue(model.observedPhones.isEmpty)
        await model.refreshPhones(context: context)
        XCTAssertEqual(model.observedPhones.map(\.id), ["unrelated-phone"])
        XCTAssertEqual(model.payload, "invented-server-encoded-qr")
        XCTAssertEqual(model.pending?.pairingCode, "invented-code")
        XCTAssertFalse(script.requests.contains { $0.httpMethod == "DELETE" })
        await model.cancel()
        XCTAssertNil(model.payload)
        XCTAssertNil(model.pending)
        XCTAssertTrue(script.requests.contains { $0.httpMethod == "DELETE" && $0.url?.path == "/admin/devices/pair" })
    }

    func testAssistantApprovalCarriesOnlyExplicitSourceChoices() async throws {
        let expiry = Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)
        let script = ScriptedDesktopHTTP { request in
            if request.url?.path == "/admin/access/authorizations/lookup" {
                return #"{"request":{"id":"request-1","approvalId":"approval-1","status":"pending","clientId":"client-1","clientName":"Invented assistant","redirectOrigin":"https://assistant.example.com","resource":"https://library.example.com/mcp","scope":"mcp:access","expiresAt":\#(expiry),"requiresAnswer":false}}"#
            }
            if request.url?.path == "/admin/access/authorizations/approval-1/decision" {
                let body = try Self.body(request)
                XCTAssertEqual(body["decision"] as? String, "approve")
                let selection = try XCTUnwrap(body["selection"] as? [String: Any])
                let rules = try XCTUnwrap(selection["rules"] as? [[String: Any]])
                XCTAssertEqual(rules.count, 1)
                XCTAssertEqual(rules.first?["capability"] as? String, "direct")
                let boundary = try XCTUnwrap(rules.first?["sources"] as? [String: Any])
                XCTAssertEqual(boundary["mode"] as? String, "allowlist")
                XCTAssertEqual(boundary["sourceIds"] as? [String], ["fixture-source"])
                return #"{"request":{"status":"approved"}}"#
            }
            throw URLError(.unsupportedURL)
        }
        let fixture = try makeAPI(script: script)
        defer { fixture.cleanup() }
        let overview = AccessOverview(
            principals: [],
            sources: [AccessSourceInstance(id: "fixture-source", name: "Invented source")],
            policyFamilies: []
        )
        let model = DesktopAgentAuthorization()
        let context = DesktopAPIContext(api: fixture.api, id: 1)
        model.code = "invented-code"
        try await model.requestLookup(
            context: context,
            overview: overview,
            expectedResource: XCTUnwrap(URL(string: "https://library.example.com/mcp"))
        )?.value
        XCTAssertNotNil(model.request)
        XCTAssertNil(model.decision)
        model.allowAnswers = false
        model.allowDirect = true
        model.allowedSources = ["fixture-source"]
        model.personallyStarted = true
        try await model.decide(approve: true, requestID: XCTUnwrap(model.requestID), context: context, overview: overview)
        XCTAssertEqual(model.decision, .approved)
        XCTAssertNil(model.failure)
    }

    func testDeniedAssistantRequestSendsDenyAndNeverShowsInstallInstructions() async throws {
        let expiry = Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)
        let script = ScriptedDesktopHTTP { request in
            if request.url?.path == "/admin/access/authorizations/lookup" {
                return #"{"request":{"id":"request-1","approvalId":"approval-1","status":"pending","clientId":"client-1","clientName":"Invented assistant","redirectOrigin":"https://assistant.example.com","resource":"https://library.example.com/mcp","scope":"mcp:access","expiresAt":\#(expiry),"requiresAnswer":false}}"#
            }
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/admin/access/authorizations/approval-1/decision")
            XCTAssertEqual(try Self.body(request)["decision"] as? String, "deny")
            return #"{"request":{"status":"denied"}}"#
        }
        let fixture = try makeAPI(script: script)
        defer { fixture.cleanup() }
        let model = DesktopAgentAuthorization()
        let overview = AccessOverview(principals: [], sources: [], policyFamilies: [])
        let context = DesktopAPIContext(api: fixture.api, id: 1)
        model.code = "invented-code"
        try await model.requestLookup(
            context: context,
            overview: overview,
            expectedResource: XCTUnwrap(URL(string: "https://library.example.com/mcp"))
        )?.value
        try await model.decide(approve: false, requestID: XCTUnwrap(model.requestID), context: context, overview: overview)
        XCTAssertEqual(model.decision, .denied)
        XCTAssertNil(model.request)
        try await DesktopSnapshotRenderer.render(
            DesktopAssistantDecisionView(decision: XCTUnwrap(model.decision)),
            name: "assistant-request-denied",
            size: CGSize(width: 660, height: 180)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Connection denied", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Install and use Omnesis", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Return to your assistant", in: view))
        }
    }

    func testFailedReplacementLookupClearsPriorRequestAndEveryConsentChoice() async throws {
        let script = ScriptedDesktopHTTP { request in
            guard request.url?.path == "/admin/access/authorizations/lookup" else {
                XCTFail("A retired approval must never reach decision dispatch")
                throw URLError(.unsupportedURL)
            }
            if try Self.body(request)["code"] as? String == "invented-code-a" { return Self.authorizationJSON() }
            throw URLError(.cannotConnectToHost)
        }
        let fixture = try makeAPI(script: script)
        defer { fixture.cleanup() }
        let model = DesktopAgentAuthorization(), context = DesktopAPIContext(api: fixture.api, id: 1)
        model.code = "invented-code-a"
        await model.requestLookup(context: context, overview: Self.authorizationOverview, expectedResource: Self.resource)?.value
        let oldID = try XCTUnwrap(model.requestID)
        consent(model)
        model.includeFutureSources = true
        model.reviewedAnswers = false
        model.policyFamilyId = "invented-policy"
        model.code = "invented-code-b"
        assertNoConsent(model)
        await model.requestLookup(context: context, overview: Self.authorizationOverview, expectedResource: Self.resource)?.value
        XCTAssertNotNil(model.failure)
        await model.decide(approve: true, requestID: oldID, context: context, overview: Self.authorizationOverview)
        XCTAssertNil(model.request)
        XCTAssertNil(model.decision)
        XCTAssertEqual(script.requests.count, 2)
    }

    func testSameCodeLookupClearsApprovalBeforeItsFailedResponse() async throws {
        let gate = AuthorizationResponseGate()
        let entered = expectation(description: "replacement lookup entered")
        let count = AuthorizationLookupCount()
        let script = ScriptedDesktopHTTP { request in
            XCTAssertEqual(request.url?.path, "/admin/access/authorizations/lookup")
            if count.next() > 1 {
                entered.fulfill()
                try gate.wait()
                throw URLError(.cannotConnectToHost)
            }
            return Self.authorizationJSON()
        }
        let fixture = try makeAPI(script: script)
        defer { fixture.cleanup() }
        let model = DesktopAgentAuthorization(), context = DesktopAPIContext(api: fixture.api, id: 1)
        model.code = "invented-code-a"
        await model.requestLookup(context: context, overview: Self.authorizationOverview, expectedResource: Self.resource)?.value
        let oldID = try XCTUnwrap(model.requestID)
        consent(model)
        let loading = Task { await model.requestLookup(
            context: context,
            overview: Self.authorizationOverview,
            expectedResource: Self.resource
        )?.value }
        await fulfillment(of: [entered], timeout: 2)
        assertNoConsent(model)
        XCTAssertTrue(model.busy)
        await model.decide(approve: true, requestID: oldID, context: context, overview: Self.authorizationOverview)
        gate.release()
        await loading.value
        XCTAssertNotNil(model.failure)
        XCTAssertNil(model.requestID)
        XCTAssertEqual(script.requests.count, 2)
    }

    func testEditingCodeWhileLookupIsHeldRejectsLateSuccessOrFailureIncludingCodeABA() async throws {
        for (returnToA, fails) in [(false, false), (true, false), (false, true), (true, true)] {
            let gate = AuthorizationResponseGate()
            let entered = expectation(description: "lookup entered")
            let script = ScriptedDesktopHTTP { request in
                XCTAssertEqual(request.url?.path, "/admin/access/authorizations/lookup")
                XCTAssertEqual(try Self.body(request)["code"] as? String, "invented-code-a")
                entered.fulfill()
                try gate.wait()
                if fails { throw URLError(.cannotConnectToHost) }
                return Self.authorizationJSON()
            }
            let fixture = try makeAPI(script: script)
            let model = DesktopAgentAuthorization(), context = DesktopAPIContext(api: fixture.api, id: 1)
            model.code = "invented-code-a"
            let loading = Task {
                await model.requestLookup(context: context, overview: Self.authorizationOverview, expectedResource: Self.resource)?.value
            }
            await fulfillment(of: [entered], timeout: 2)
            model.code = "invented-code-b"
            if returnToA { model.code = "invented-code-a" }
            assertNoConsent(model)
            XCTAssertTrue(model.busy, "An edit must retain ownership until the real lookup returns")
            gate.release()
            await loading.value
            XCTAssertFalse(model.busy)
            XCTAssertNil(model.request)
            XCTAssertNil(model.failure, "A retired lookup cannot publish a success or error under edited text")
            XCTAssertEqual(script.requests.count, 1)
            fixture.cleanup()
        }
    }

    func testCachedAllowAndDenyCannotDecideReplacementEvenWhenServerIdentityRepeats() async throws {
        let script = ScriptedDesktopHTTP { request in
            if request.url?.path == "/admin/access/authorizations/lookup" { return Self.authorizationJSON() }
            XCTAssertEqual(request.url?.path, "/admin/access/authorizations/approval-1/decision")
            return #"{"request":{"status":"approved"}}"#
        }
        let fixture = try makeAPI(script: script)
        defer { fixture.cleanup() }
        let model = DesktopAgentAuthorization(), context = DesktopAPIContext(api: fixture.api, id: 1)
        model.code = "invented-code-a"
        await model.requestLookup(context: context, overview: Self.authorizationOverview, expectedResource: Self.resource)?.value
        let oldID = try XCTUnwrap(model.requestID)
        model.code = "invented-code-b"
        await model.requestLookup(context: context, overview: Self.authorizationOverview, expectedResource: Self.resource)?.value
        let currentID = try XCTUnwrap(model.requestID)
        XCTAssertNotEqual(oldID, currentID)
        consent(model)
        for approve in [true, false] {
            await model.decide(approve: approve, requestID: oldID, context: context, overview: Self.authorizationOverview)
        }
        XCTAssertEqual(script.requests.count, 2)
        XCTAssertEqual(model.requestID, currentID)
        await model.decide(approve: true, requestID: currentID, context: context, overview: Self.authorizationOverview)
        XCTAssertEqual(script.requests.count, 3)
        XCTAssertEqual(model.decision, .approved)
    }

    func testQueuedAllowCannotFollowCodeEditBeforeDispatch() async throws {
        let script = ScriptedDesktopHTTP { request in
            XCTAssertEqual(request.url?.path, "/admin/access/authorizations/lookup")
            return Self.authorizationJSON()
        }
        let fixture = try makeAPI(script: script)
        defer { fixture.cleanup() }
        let model = DesktopAgentAuthorization(), context = DesktopAPIContext(api: fixture.api, id: 1)
        model.code = "invented-code-a"
        await model.requestLookup(context: context, overview: Self.authorizationOverview, expectedResource: Self.resource)?.value
        let identity = try XCTUnwrap(model.requestID)
        consent(model)
        let deciding = Task {
            await model.decide(approve: true, requestID: identity, context: context, overview: Self.authorizationOverview)
        }
        model.code = "invented-code-b"
        await deciding.value
        XCTAssertEqual(script.requests.count, 1)
        XCTAssertNil(model.decision)
    }

    func testCodeEditAfterActualDecisionDispatchDoesNotRevokeOrPublishItsCompletion() async throws {
        let gate = AuthorizationResponseGate()
        let dispatched = expectation(description: "decision actually dispatched")
        let script = ScriptedDesktopHTTP { request in
            if request.url?.path == "/admin/access/authorizations/lookup" { return Self.authorizationJSON() }
            XCTAssertEqual(request.url?.path, "/admin/access/authorizations/approval-1/decision")
            XCTAssertEqual(try Self.body(request)["decision"] as? String, "approve")
            dispatched.fulfill()
            try gate.wait()
            return #"{"request":{"status":"approved"}}"#
        }
        let fixture = try makeAPI(script: script)
        defer { fixture.cleanup() }
        let model = DesktopAgentAuthorization(), context = DesktopAPIContext(api: fixture.api, id: 1)
        model.code = "invented-code-a"
        await model.requestLookup(context: context, overview: Self.authorizationOverview, expectedResource: Self.resource)?.value
        let identity = try XCTUnwrap(model.requestID)
        consent(model)
        let deciding = Task {
            await model.decide(approve: true, requestID: identity, context: context, overview: Self.authorizationOverview)
        }
        await fulfillment(of: [dispatched], timeout: 2)
        model.code = "invented-code-b"
        assertNoConsent(model)
        XCTAssertTrue(model.busy)
        gate.release()
        await deciding.value
        XCTAssertFalse(model.busy)
        XCTAssertNil(model.decision, "A's committed decision cannot claim that displayed B was approved")
        XCTAssertNil(model.failure)
        XCTAssertEqual(script.requests.map(\.httpMethod), ["POST", "POST"], "Editing must not send revocation or another decision")
    }

    func testApprovalCannotBorrowAnotherContextForTheSameApi() async throws {
        let script = ScriptedDesktopHTTP { request in
            XCTAssertEqual(request.url?.path, "/admin/access/authorizations/lookup")
            return Self.authorizationJSON()
        }
        let fixture = try makeAPI(script: script)
        defer { fixture.cleanup() }
        let first = DesktopAPIContext(api: fixture.api, id: 1)
        let second = DesktopAPIContext(api: fixture.api, id: 2)
        let model = DesktopAgentAuthorization()
        model.code = "invented-code-a"
        await model.requestLookup(context: first, overview: Self.authorizationOverview, expectedResource: Self.resource)?.value
        let identity = try XCTUnwrap(model.requestID)
        consent(model)
        await model.decide(approve: true, requestID: identity, context: second, overview: Self.authorizationOverview)
        first.invalidate()
        await model.decide(approve: true, requestID: identity, context: first, overview: Self.authorizationOverview)
        await first.drain()
        XCTAssertEqual(script.requests.count, 1)
        XCTAssertNil(model.decision)
    }

    func testQueuedFindCannotLookupEditedCodeIncludingCodeABAAndCurrentFindStillWorks() async throws {
        for returnToA in [false, true] {
            let script = ScriptedDesktopHTTP { request in
                XCTAssertEqual(request.url?.path, "/admin/access/authorizations/lookup")
                XCTAssertEqual(try Self.body(request)["code"] as? String, returnToA ? "invented-code-a" : "invented-code-b")
                return Self.authorizationJSON()
            }
            let fixture = try makeAPI(script: script)
            defer { fixture.cleanup() }
            let model = DesktopAgentAuthorization(), context = DesktopAPIContext(api: fixture.api, id: 1)
            model.code = "invented-code-a"
            let queued = model.requestLookup(context: context, overview: Self.authorizationOverview, expectedResource: Self.resource)
            model.code = "invented-code-b"
            if returnToA { model.code = "invented-code-a" }
            await queued?.value
            XCTAssertTrue(script.requests.isEmpty, "A queued Find must not look up whichever code was entered later")
            XCTAssertNil(model.requestID)
            XCTAssertFalse(model.busy)
            await model.requestLookup(context: context, overview: Self.authorizationOverview, expectedResource: Self.resource)?.value
            XCTAssertEqual(script.requests.count, 1, "An explicit Find for the current code must still dispatch")
            XCTAssertNotNil(model.requestID)
        }
    }

    private static let resource = URL(string: "https://library.example.com/mcp")!
    private static let authorizationOverview = AccessOverview(
        principals: [], sources: [AccessSourceInstance(id: "fixture-source", name: "Invented source")], policyFamilies: []
    )

    private nonisolated static func authorizationJSON() -> String {
        let expiry = Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)
        return #"{"request":{"id":"request-1","approvalId":"approval-1","status":"pending","clientId":"client-1","clientName":"Invented assistant","redirectOrigin":"https://assistant.example.com","resource":"https://library.example.com/mcp","scope":"mcp:access","expiresAt":\#(expiry),"requiresAnswer":false}}"#
    }

    private func consent(_ model: DesktopAgentAuthorization) {
        model.allowAnswers = false
        model.allowDirect = true
        model.allowedSources = ["fixture-source"]
        model.personallyStarted = true
    }

    private func assertNoConsent(_ model: DesktopAgentAuthorization, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(model.request, file: file, line: line)
        XCTAssertNil(model.requestID, file: file, line: line)
        XCTAssertFalse(model.personallyStarted, file: file, line: line)
        XCTAssertTrue(model.allowedSources.isEmpty, file: file, line: line)
        XCTAssertFalse(model.includeFutureSources, file: file, line: line)
        XCTAssertFalse(model.allowDirect, file: file, line: line)
        XCTAssertTrue(model.allowAnswers, file: file, line: line)
        XCTAssertTrue(model.reviewedAnswers, file: file, line: line)
        XCTAssertEqual(model.policyFamilyId, "", file: file, line: line)
        XCTAssertNil(model.decision, file: file, line: line)
    }

    private nonisolated static let overviewJSON = #"{"principals":[],"sources":[],"policyFamilies":[],"oauth":{"resource":"https://localhost:17601/mcp","resources":[{"resource":"https://library.example.com/mcp","publiclyTrusted":true}]}}"#

    private nonisolated static func body(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let body = request.httpBody { data = body }
        else if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var bytes = Data()
            var chunk = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&chunk, maxLength: chunk.count)
                if count <= 0 { break }
                bytes.append(contentsOf: chunk.prefix(count))
            }
            data = bytes
        } else { return [:] }
        return try (JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private func makeAPI(script: ScriptedDesktopHTTP) throws -> APIFixture {
        let host = "fixture-\(UUID().uuidString.lowercased()).example.com"
        DesktopFixtureURLProtocol.registry.add(host: host, script: script)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DesktopFixtureURLProtocol.self]
        let session = URLSession(configuration: config)
        let connection = try JSONDecoder().decode(
            DesktopConnection.self,
            from: Data(#"{"url":"https://\#(host)","token":"invented-token"}"#.utf8)
        )
        let api = try DesktopAPI(connection: connection, sessionOverride: session)
        return APIFixture(api: api, cleanup: { session.invalidateAndCancel()
            DesktopFixtureURLProtocol.registry.remove(host: host)
        })
    }

    private struct APIFixture { let api: DesktopAPI
        let cleanup: () -> Void
    }
}

private final class ScriptedDesktopHTTP: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [URLRequest] = []
    let reply: (URLRequest) throws -> String
    init(reply: @escaping (URLRequest) throws -> String) {
        self.reply = reply
    }

    var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }

    func respond(_ request: URLRequest) throws -> String {
        lock.lock()
        seen.append(request)
        lock.unlock()
        return try reply(request)
    }
}

private final class DesktopFixtureRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var scripts: [String: ScriptedDesktopHTTP] = [:]
    func add(host: String, script: ScriptedDesktopHTTP) {
        lock.lock()
        defer { lock.unlock() }
        scripts[host] = script
    }

    func remove(host: String) {
        lock.lock()
        defer { lock.unlock() }
        scripts.removeValue(forKey: host)
    }

    func script(host: String) -> ScriptedDesktopHTTP? {
        lock.lock()
        defer { lock.unlock() }
        return scripts[host]
    }
}

private final class DesktopFixtureURLProtocol: URLProtocol {
    static let registry = DesktopFixtureRegistry()
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        do {
            let host = try XCTUnwrap(request.url?.host)
            let script = try XCTUnwrap(Self.registry.script(host: host))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer invented-token")
            let body = try script.respond(request)
            let response = try XCTUnwrap(HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            ))
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }

    override func stopLoading() {}
}

private final class PhoneRosterSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var reads = 0
    func next() -> String {
        lock.lock()
        defer { lock.unlock() }
        reads += 1
        return reads == 1 ? #"{"items":[]}"#
            : #"{"items":[{"id":"unrelated-phone","name":"Another phone","kind":"ios","online":true}]}"#
    }
}

/// The fixture owns a bounded response hold and releases it before its caller joins.
private final class AuthorizationResponseGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var released = false
    func wait() throws {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(5)
        while !released {
            guard condition.wait(until: deadline) else { throw URLError(.timedOut) }
        }
    }

    func release() {
        condition.lock()
        released = true
        condition.broadcast()
        condition.unlock()
    }
}

private final class AuthorizationLookupCount: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func next() -> Int {
        lock.withLock {
            value += 1
            return value
        }
    }
}
