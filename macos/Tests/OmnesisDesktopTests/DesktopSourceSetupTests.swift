// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopSourceSetupTests: XCTestCase {
    func testActualSerializedCredentialWizardPreservesRequiredDefaultAndPattern() throws {
        let descriptor = try decode(
            DesktopDescriptor.self,
            #"{"id":"invented","name":"Invented","description":"Fictional provider","hasAuthFlow":true,"hasDiscover":false,"devices":[{"id":"local","name":"My Mac"}],"credentials":{"fileKey":"fictional-key","required":true,"publicClient":false,"perAccount":true,"fields":[{"name":"token","label":"Access key","secret":true,"required":true,"default":"prefix-","pattern":"^prefix-.+$","patternHint":"Start with prefix-"}],"wizard":{"intro":"Connect an account","why":"The provider needs a key","estMinutes":2,"steps":[{"kind":"open-url","title":"Create a key","body":"Use your library at {gatewayOrigin}","url":"https://provider.example.com/keys"}]}}}"#
        )
        XCTAssertTrue(descriptor.credentials?.perAccount == true)
        XCTAssertEqual(descriptor.credentials?.fields.first?.default, "prefix-")
        XCTAssertEqual(descriptor.credentials?.wizard?.steps.first?.kind, "open-url")
        XCTAssertThrowsError(try SourceValidation.pattern(
            "wrong",
            pattern: descriptor.credentials?.fields.first?.pattern,
            hint: nil,
            label: "key"
        ))
    }

    func testTypedSchemaAnswersPreserveBooleanNumberAndListValues() async throws {
        let fixture = try fixture { request in
            XCTAssertEqual(request.url?.path, "/admin/auth-flows/flow-1/answer")
            let body = try Self.body(request)
            XCTAssertEqual(body["challengeId"] as? String, "question-1")
            let values = try XCTUnwrap(body["answer"] as? [String: Any])
            XCTAssertEqual(values["enabled"] as? Bool, true)
            XCTAssertEqual(values["count"] as? Double, 3)
            XCTAssertEqual(values["regions"] as? [String], ["north", "south"])
            return "{}"
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        flow.flowId = "flow-1"
        flow.auth = try decode(
            AuthSnapshot.self,
            #"{"state":"awaiting-user","pendingChallenge":{"id":"question-1","expectsAnswer":true,"challenge":{"kind":"fields","title":"Choose options","schema":{"enabled":{"kind":"boolean","label":"Enabled","default":false},"count":{"kind":"number","label":"Count","min":1,"max":5,"integer":true},"regions":{"kind":"list","label":"Regions","of":{"kind":"select","label":"Region","options":[{"value":"north","label":"North"},{"value":"south","label":"South"}]},"maxItems":2}}}}}"#
        )
        flow.answer = ["enabled": "true", "count": "3", "regions": "north,south"]
        await flow.submitAnswer()
        XCTAssertNil(flow.error)
        XCTAssertEqual(fixture.script.requests.count, 1)
    }

    func testUnsupportedOrInvalidChallengeNeverSendsPartialAnswer() async throws {
        let fixture = try fixture { _ in XCTFail("Invalid answers must not reach the gateway")
            return "{}"
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        flow.flowId = "flow-1"
        flow.auth = try decode(
            AuthSnapshot.self,
            #"{"state":"awaiting-user","pendingChallenge":{"id":"q","expectsAnswer":true,"challenge":{"kind":"fields","title":"Count","schema":{"count":{"kind":"number","label":"Count","max":3,"integer":true}}}}}"#
        )
        flow.answer = ["count": "4"]
        await flow.submitAnswer()
        XCTAssertNotNil(flow.error)
        XCTAssertTrue(fixture.script.requests.isEmpty)
    }

    func testPastedRedirectUsesCodeLatchRatherThanTypedAnswerEndpoint() async throws {
        let fixture = try fixture { request in
            XCTAssertEqual(request.url?.path, "/admin/auth-flows/flow-1/code")
            let body = try Self.body(request)
            XCTAssertEqual(body["code"] as? String, "https://callback.example.com/?code=invented")
            XCTAssertNil(body["challengeId"])
            return "{}"
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        flow.flowId = "flow-1"
        flow.auth = try decode(
            AuthSnapshot.self,
            #"{"state":"awaiting-callback","pendingChallenge":{"id":"q","expectsAnswer":true,"challenge":{"kind":"redirect","title":"Sign in","url":"https://provider.example.com/auth","via":"elsewhere"}}}"#
        )
        flow.answer = ["url": "https://callback.example.com/?code=invented"]
        await flow.submitAnswer()
        XCTAssertNil(flow.error)
        XCTAssertEqual(fixture.script.requests.count, 1)
    }

    func testDiscoveryOffersExistingAccountsBeforeAuthenticationAndSkipsOptionalEmptyParam() async throws {
        let fixture = try fixture { request in
            switch request.url?.path {
            case "/admin/sources/discover": return #"{"accounts":["fictional-account","fictional-account"]}"#
            case "/admin/sources": return #"{"items":[]}"#
            default: XCTFail("Unnecessary validation/authentication: \(request.url?.path ?? "")")
                return "{}"
            }
        }
        defer { fixture.close() }
        let descriptor = try basicDescriptor(extra: #", "params":[{"name":"optional","type":"string","label":"Optional"}]"#, discover: true)
        let flow = DesktopSourceFlow(descriptor: descriptor, api: fixture.api)
        await flow.begin()
        XCTAssertEqual(flow.accounts, ["fictional-account"])
        XCTAssertNil(flow.flowId)
        XCTAssertNil(flow.error)
    }

    func testPerAccountKeysAreCollectedEvenWhenConfiguredAndRetainedUntilSuccessfulTerminal() async throws {
        let fixture = try fixture { request in
            switch request.url?.path {
            case "/admin/credentials": return #"{"items":[{"fileKey":"invented-key","configured":true}]}"#
            case "/admin/auth-flows":
                XCTAssertEqual(try Self.body(request)["credentials"] as? [String: String], ["token": "fictional-once-visible-key"])
                return #"{"flowId":"flow-1"}"#
            case "/admin/auth-flows/flow-1": return #"{"state":"error","errorMessage":"Could not save","errorDetail":{"code":"credential-persist-failed","remedy":"Unlock your keyring and try again."}}"#
            case "/admin/auth-flows/flow-1/cancel": return "{}"
            default: XCTFail("Per-account keys must never be pre-saved: \(request.url?.path ?? "")")
                return "{}"
            }
        }
        defer { fixture.close() }
        let descriptor =
            try basicDescriptor(
                extra: #", "credentials":{"fileKey":"invented-key","required":true,"perAccount":true,"fields":[{"name":"token","label":"Access key","secret":true}]}"#
            )
        let flow = DesktopSourceFlow(descriptor: descriptor, api: fixture.api)
        await flow.begin()
        XCTAssertTrue(flow.needsCredentials)
        XCTAssertNil(flow.flowId)
        flow.credentials = ["token": "fictional-once-visible-key"]
        await flow.continueCredentials()
        for _ in 0 ..< 50 {
            if flow.auth?.state == "error" { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(flow.credentials["token"], "fictional-once-visible-key")
        XCTAssertEqual(flow.error, "Unlock your keyring and try again.")
        XCTAssertFalse(flow.complete)
        await flow.cancel()
        XCTAssertTrue(flow.credentials.isEmpty)
    }

    func testMemberJoinUsesActualSourceIdAndOnlyMemberParameters() async throws {
        let fixture = try fixture { request in
            switch request.url?.path {
            case "/admin/sources": return #"{"items":[{"id":"invented:fictional-account","type":"invented","accountId":"fictional-account","enabled":true,"deviceId":"other","members":["other"],"multiDeviceMode":"replicated"}]}"#
            default:
                XCTAssertEqual(request.url?.deletingLastPathComponent().lastPathComponent, "invented:fictional-account")
                XCTAssertEqual(request.url?.lastPathComponent, "members")
                let body = try Self.body(request)
                XCTAssertEqual(body["deviceId"] as? String, "local")
                let config = try XCTUnwrap(body["memberConfig"] as? [String: Any])
                XCTAssertEqual(config["params"] as? [String: String], ["folder": "/fictional/library"])
                return "{}"
            }
        }
        defer { fixture.close() }
        let descriptor = try basicDescriptor(extra: #", "memberScopedParamNames":["folder"]"#)
        let flow = DesktopSourceFlow(descriptor: descriptor, api: fixture.api)
        flow.accounts = ["fictional-account"]
        flow.selectedAccounts = Set(flow.accounts)
        flow.params = ["folder": "/fictional/library", "shared": "do-not-overwrite"]
        await flow.add()
        XCTAssertTrue(flow.complete)
        XCTAssertNil(flow.error)
    }

    func testWidgetNeedsTrustedCanonicalPublicOriginAndNeverUsesLoopbackProxy() async throws {
        let fixture = try fixture { request in
            if request.url?.path == "/admin/cloud-relay" { return #"{"account":{"linked":true},"publicOrigin":"https://localhost:17601"}"# }
            return #"{"gatewayFingerprint":"\#(String(repeating: "ab", count: 32))"}"#
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        do {
            _ = try await SourceWidgetConfiguration.load(flow: flow, widget: AuthSnapshot.Widget(kind: "invented", payload: [:]))
            XCTFail("Loopback transport must never become a hosted widget origin")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Connect your Omnesis account")) }
        XCTAssertFalse(try SourceWidgetBrowser.Coordinator.allowedFrame(
            XCTUnwrap(URL(string: "https://evil-example.com")),
            origins: ["https://*.example.com"]
        ))
        XCTAssertTrue(try SourceWidgetBrowser.Coordinator.allowedFrame(
            XCTUnwrap(URL(string: "https://frame.example.com")),
            origins: ["https://*.example.com"]
        ))
        XCTAssertFalse(try SourceWidgetBrowser.Coordinator.allowedFrame(
            XCTUnwrap(URL(string: "http://frame.example.com")),
            origins: ["https://*.example.com"]
        ))
    }

    func testClosingSetupDuringAuthenticationStartCancelsNewFlowAndNeverAddsSource() async throws {
        let started = expectation(description: "authentication requested")
        let release = DispatchSemaphore(value: 0)
        let fixture = try fixture { request in
            switch request.url?.path {
            case "/admin/auth-flows":
                started.fulfill()
                _ = release.wait(timeout: .now() + 3)
                return #"{"flowId":"late-flow"}"#
            case "/admin/auth-flows/late-flow/cancel": return "{}"
            default: XCTFail("A closed setup must not add or observe a source")
                return "{}"
            }
        }
        defer { release.signal()
            fixture.close()
        }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        let beginning = Task { await flow.begin() }
        await fulfillment(of: [started], timeout: 2)
        await flow.cancel()
        release.signal()
        await beginning.value
        XCTAssertNil(flow.flowId)
        XCTAssertNil(flow.auth)
        XCTAssertFalse(flow.complete)
        XCTAssertFalse(flow.busy)
        XCTAssertTrue(fixture.script.requests.contains { $0.url?.path == "/admin/auth-flows/late-flow/cancel" })
    }

    func testChallengeExpiryUsesActualISO8601WireString() throws {
        let snapshot = try decode(
            AuthSnapshot.self,
            #"{"state":"awaiting-user","pendingChallenge":{"id":"q","expectsAnswer":true,"challenge":{"kind":"redirect","title":"Sign in","url":"https://provider.example.com/auth","expiresAt":"2000-01-01T00:00:00.000Z"}}}"#
        )
        XCTAssertNotNil(snapshot.pendingChallenge?.challenge.expiration)
        XCTAssertTrue((snapshot.pendingChallenge?.challenge.expiration ?? .distantFuture) < Date())
    }

    func testNativeWidgetBridgeRejectsUnscopedOrUnboundedMessages() {
        let nonce = String(repeating: "ab", count: 32)
        XCTAssertNil(SourceWidgetMessage.parse(["nonce": "wrong", "type": "result", "token": "fixture", "metadata": [:]], nonce: nonce))
        XCTAssertNil(SourceWidgetMessage.parse(["nonce": nonce, "type": "admin", "path": "/admin/config"], nonce: nonce))
        XCTAssertNil(SourceWidgetMessage.parse(
            ["nonce": nonce, "type": "result", "token": String(repeating: "s", count: 16385), "metadata": [:]],
            nonce: nonce
        ))
        XCTAssertNil(SourceWidgetMessage.parse(
            ["nonce": nonce, "type": "result", "token": "fixture", "metadata": ["oversized": String(repeating: "s", count: 65536)]],
            nonce: nonce
        ))
        let accepted = SourceWidgetMessage.parse(
            ["nonce": nonce, "type": "result", "token": "fixture", "metadata": ["account": "fictional"]],
            nonce: nonce
        )
        XCTAssertEqual(accepted?.token, "fixture")
        let failed = SourceWidgetMessage.parse(["nonce": nonce, "type": "error", "message": "do-not-echo-provider-data"], nonce: nonce)
        XCTAssertNil(failed?.metadata)
        XCTAssertNil(failed?.token)
    }

    func testRenderSourceInstructionsFieldsLoadingAndRefusal() throws {
        let fixture = try fixture { _ in XCTFail("Source previews must not start authentication")
            return "{}"
        }
        defer { fixture.close() }
        let descriptor =
            try basicDescriptor(
                extra: #", "credentials":{"fileKey":"invented-key","required":true,"perAccount":true,"fields":[{"name":"token","label":"Access key","secret":true,"patternHint":"Use a key with read-only access."}],"wizard":{"intro":"Connect your account securely","why":"Your provider uses a personal access key.","estMinutes":2,"steps":[{"kind":"open-url","title":"Create an access key","body":"Create a read-only key, then return to Omnesis.","url":"https://provider.example.com/keys"}]}}"#
            )
        let instructions = DesktopSourceFlow(descriptor: descriptor, api: fixture.api)
        instructions.needsCredentials = true
        try renderSource(instructions, name: "source-credentials-instructions")
        instructions.credentialsStep = 1
        try renderSource(instructions, name: "source-credentials-fields")
        let loading = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        loading.busy = true
        try renderSource(loading, name: "source-connecting")
        let refused = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        refused.error = "This account is already connected on another device. Keep that device connected or choose a different account."
        try renderSource(refused, name: "source-refused")
        let question = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        question.auth = try decode(
            AuthSnapshot.self,
            #"{"state":"awaiting-user","pendingChallenge":{"id":"question-1","expectsAnswer":true,"challenge":{"kind":"fields","title":"Choose the information to connect","instructions":"Choose a region and confirm your preferences.","schema":{"region":{"kind":"select","label":"Region","options":[{"value":"north","label":"North"},{"value":"south","label":"South"}]},"count":{"kind":"number","label":"History in months","min":1,"max":12},"includeArchived":{"kind":"boolean","label":"Include archived items"}}}}}"#
        )
        question.answer = ["region": "north", "count": "3", "includeArchived": "false"]
        try renderSource(question, name: "source-auth-question")
        XCTAssertTrue(fixture.script.requests.isEmpty)
    }

    private func renderSource(_ flow: DesktopSourceFlow, name: String) throws {
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let view = SourceSetupView(flow: flow).environment(DesktopStore.preview())
            let hosting = NSHostingView(rootView: view)
            hosting.frame = NSRect(x: 0, y: 0, width: 680, height: 680)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: appearance)
            window.contentView = hosting
            hosting.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            XCTAssertGreaterThan(png.count, 1000)
            try png.write(to: output.appendingPathComponent("\(name)-\(appearance.rawValue).png"))
            window.close()
        }
    }

    private func basicDescriptor(extra: String = "", discover: Bool = false) throws -> DesktopDescriptor {
        try decode(
            DesktopDescriptor.self,
            #"{"id":"invented","name":"Invented","description":"Fictional source","hasAuthFlow":true,"hasDiscover":\#(discover),"devices":[{"id":"local","name":"My Mac"}]\#(extra)}"#
        )
    }

    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(text.utf8))
    }

    private nonisolated static func body(_ request: URLRequest) throws -> [String: Any] {
        if let data = request.httpBody { return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:] }
        guard let stream = request.httpBodyStream else { return [:] }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var bytes = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&bytes, maxLength: bytes.count)
            if count <= 0 { break }
            data.append(contentsOf: bytes.prefix(count))
        }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    private func fixture(_ reply: @escaping (URLRequest) throws -> String) throws -> Fixture {
        let host = "source-fixture-\(UUID().uuidString.lowercased()).example.com"
        let script = SourceSetupScript(reply: reply)
        SourceSetupRegistry.shared.add(host, script)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SourceSetupURLProtocol.self]
        let session = URLSession(configuration: config)
        let connection = try decode(
            DesktopConnection.self,
            #"{"url":"https://\#(host)","token":"invented-token","collectorDeviceId":"local"}"#
        )
        return try Fixture(api: DesktopAPI(connection: connection, sessionOverride: session), script: script, close: {
            session.invalidateAndCancel()
            SourceSetupRegistry.shared.remove(host)
        })
    }

    private struct Fixture { let api: DesktopAPI
        let script: SourceSetupScript
        let close: () -> Void
    }
}

private final class SourceSetupScript: @unchecked Sendable {
    let reply: (URLRequest) throws -> String
    private let lock = NSLock()
    private var seen: [URLRequest] = []
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

private final class SourceSetupRegistry: @unchecked Sendable {
    static let shared = SourceSetupRegistry()
    private let lock = NSLock()
    private var entries: [String: SourceSetupScript] = [:]
    func add(_ host: String, _ script: SourceSetupScript) {
        lock.lock()
        defer { lock.unlock() }
        entries[host] = script
    }

    func remove(_ host: String) {
        lock.lock()
        defer { lock.unlock() }
        entries.removeValue(forKey: host)
    }

    func get(_ host: String) -> SourceSetupScript? {
        lock.lock()
        defer { lock.unlock() }
        return entries[host]
    }
}

private final class SourceSetupURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        do {
            let script = try XCTUnwrap(try SourceSetupRegistry.shared.get(XCTUnwrap(request.url?.host)))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer invented-token")
            let data = try Data(script.respond(request).utf8)
            let response = try XCTUnwrap(try HTTPURLResponse(
                url: XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            ))
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }

    override func stopLoading() {}
}
