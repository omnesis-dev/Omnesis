// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import Omnesis
@testable import OmnesisDesktop
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
        await model.load(api: fixture.api)
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
        await model.load(api: fixture.api)
        XCTAssertNil(model.mcpURL)
        XCTAssertNil(model.gatewayOrigin)
        XCTAssertNotNil(model.failure)
    }

    func testPhoneCodeUsesCanonicalGrantAndRelayAddressAndIsWithdrawnOnClose() async throws {
        let expiry = Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)
        let script = ScriptedDesktopHTTP { request in
            let body = try Self.body(request)
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/admin/devices"): return #"{"items":[]}"#
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
        try await model.start(api: fixture.api, gatewayOrigin: XCTUnwrap(URL(string: "https://library.example.com")))
        XCTAssertEqual(model.payload, "invented-server-encoded-qr")
        XCTAssertNil(model.connectedPhone)
        await model.cancel(api: fixture.api)
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
        model.code = "invented-code"
        try await model.lookup(
            api: fixture.api,
            overview: overview,
            expectedResource: XCTUnwrap(URL(string: "https://library.example.com/mcp"))
        )
        XCTAssertNotNil(model.request)
        XCTAssertFalse(model.completed)
        model.allowAnswers = false
        model.allowDirect = true
        model.allowedSources = ["fixture-source"]
        model.personallyStarted = true
        await model.decide(approve: true, api: fixture.api, overview: overview)
        XCTAssertTrue(model.completed)
        XCTAssertNil(model.failure)
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
