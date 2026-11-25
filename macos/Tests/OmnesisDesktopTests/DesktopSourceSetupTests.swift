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

    func testRenderSourceInstructionsFieldsLoadingAndRefusal() async throws {
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
        try await renderSource(instructions, name: "source-credentials-instructions")
        instructions.credentialsStep = 1
        try await renderSource(instructions, name: "source-credentials-fields")
        let added = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        added.complete = true
        try await renderSource(added, name: "source-added")
        let loading = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        loading.busy = true
        try await renderSource(loading, name: "source-connecting")
        let refused = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        refused.error = "This account is already connected on another device. Keep that device connected or choose a different account."
        try await renderSource(refused, name: "source-refused")
        let question = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        question.auth = try decode(
            AuthSnapshot.self,
            #"{"state":"awaiting-user","pendingChallenge":{"id":"question-1","expectsAnswer":true,"challenge":{"kind":"fields","title":"Choose the information to connect","instructions":"Choose a region and confirm your preferences.","schema":{"region":{"kind":"select","label":"Region","options":[{"value":"north","label":"North"},{"value":"south","label":"South"}]},"count":{"kind":"number","label":"History in months","min":1,"max":12},"includeArchived":{"kind":"boolean","label":"Include archived items"}}}}}"#
        )
        question.answer = ["region": "north", "count": "3", "includeArchived": "false"]
        try await renderSource(question, name: "source-auth-question")
        XCTAssertTrue(fixture.script.requests.isEmpty)
    }

    private func renderSource(_ flow: DesktopSourceFlow, name: String) async throws {
        let view = SourceSetupView(flow: flow).environment(DesktopStore.preview())
        try await DesktopSnapshotRenderer.render(view, name: name, size: CGSize(width: 680, height: 680))
    }

    func testCredentialRedirectDefaultUsesAuthenticatedLinkedOriginWhenConfigHasNoPublicAddress() async throws {
        let fixture = try fixture { request in
            switch request.url?.path {
            case "/admin/credentials": return #"{"items":[{"fileKey":"invented-key","configured":false}]}"#
            case "/admin/config": return #"{"config":{"gateway":{}}}"#
            case "/admin/cloud-relay": return #"{"account":{"linked":true},"publicOrigin":"https://library.example.com"}"#
            default: XCTFail("Credentials must be reviewed before starting authentication")
                return "{}"
            }
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: redirectDescriptor(), api: fixture.api)
        await flow.begin()
        XCTAssertTrue(flow.needsCredentials)
        XCTAssertEqual(flow.credentials["redirect"], "https://library.example.com/oauth/callback")
        XCTAssertEqual(flow.expand("Return to {gatewayOrigin}"), "Return to https://library.example.com")
        XCTAssertNil(flow.error)
        XCTAssertNil(flow.flowId)
    }

    func testCredentialRedirectRefusesUnlinkedProvisionalAndLocalFallbacks() async throws {
        for status in [
            #"{"account":{"linked":false},"publicOrigin":"https://library.example.com"}"#,
            #"{"publicOrigin":"https://library.example.com"}"#,
            #"{"account":{"linked":true},"publicOrigin":"https://localhost:17601"}"#,
            #"{"account":{"linked":true},"publicOrigin":"https://192.0.2.80:17601"}"#,
            #"{"account":{"linked":true},"publicOrigin":"https://[::1]:17601"}"#,
            #"{"account":{"linked":true},"publicOrigin":"https://library.local"}"#,
            #"{"account":{"linked":true},"publicOrigin":"http://library.example.com"}"#,
            #"{"account":{"linked":true},"publicOrigin":"https://library.example.com/?token=fictional"}"#,
        ] {
            let fixture = try fixture { request in
                switch request.url?.path {
                case "/admin/credentials": return #"{"items":[{"fileKey":"invented-key","configured":false}]}"#
                case "/admin/config": return #"{"config":{}}"#
                case "/admin/cloud-relay": return status
                default: XCTFail("An untrusted redirect origin must not start authentication")
                    return "{}"
                }
            }
            defer { fixture.close() }
            let flow = try DesktopSourceFlow(descriptor: redirectDescriptor(), api: fixture.api)
            await flow.begin()
            XCTAssertFalse(flow.needsCredentials)
            XCTAssertNil(flow.credentials["redirect"])
            XCTAssertNil(flow.gatewayOrigin)
            XCTAssertNotNil(flow.error)
            XCTAssertNil(flow.flowId)
        }
    }

    func testExplicitConfiguredPublicOriginRemainsTheProviderRedirectAuthority() async throws {
        let fixture = try fixture { request in
            switch request.url?.path {
            case "/admin/credentials": return #"{"items":[{"fileKey":"invented-key","configured":false}]}"#
            case "/admin/config": return #"{"config":{"gateway":{"publicBaseUrl":"https://configured.example.org"}}}"#
            default: XCTFail("A configured public origin needs no account-origin fallback")
                return "{}"
            }
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: redirectDescriptor(), api: fixture.api)
        await flow.begin()
        XCTAssertEqual(flow.credentials["redirect"], "https://configured.example.org/oauth/callback")
        XCTAssertNil(flow.error)
    }

    func testSourceSettingsPreserveOpaqueConfigSiblingParametersAndPausedState() async throws {
        var sharedSaved = false
        var localSaved = false
        let global = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":false,"deviceId":"local","members":["local","other"],"multiDeviceMode":"replicated","config":{"params":{"shared":"before","untouched":"keep"},"opaque":{"flags":[true,null,3]}}}"#
        let member = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":false,"deviceId":"local","members":["local","other"],"multiDeviceMode":"replicated","config":{"params":{"shared":"before","path":"/example/before","future":"keep-local"}}}"#
        let a = String(repeating: "a", count: 64), b = String(repeating: "b", count: 64)
        let fixture = try fixture { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/admin/sources"):
                return #"{"items":[\#(global)],"pendingRemovals":[]}"#
            case ("GET", "/admin/sources/fixture-source"):
                let current = sharedSaved ? global.replacingOccurrences(of: "before", with: "after") : global
                return #"{"source":\#(current),"revision":"\#(a)"}"#
            case ("GET", "/admin/sources/fixture-source/members/local"):
                var current = member
                if sharedSaved { current = current.replacingOccurrences(of: #""shared":"before""#, with: #""shared":"after""#) }
                if localSaved { current = current.replacingOccurrences(of: "/example/before", with: "/example/after") }
                return #"{"source":\#(current),"revision":"\#(b)"}"#
            case ("POST", "/admin/sources/validate-param"): return #"{"valid":true}"#
            case ("PATCH", "/admin/sources/fixture-source"):
                let body = try Self.body(request)
                XCTAssertEqual(body["expectedRevision"] as? String, a)
                XCTAssertNil(body["enabled"])
                let config = try XCTUnwrap(body["config"] as? [String: Any])
                XCTAssertEqual(config["params"] as? [String: String], ["shared": "after", "untouched": "keep"])
                let opaque = try XCTUnwrap(config["opaque"] as? [String: Any])
                XCTAssertEqual((opaque["flags"] as? [Any])?.count, 3)
                sharedSaved = true
                return "{}"
            case ("PATCH", "/admin/sources/fixture-source/members/local"):
                let body = try Self.body(request)
                XCTAssertEqual(body["expectedRevision"] as? String, b)
                XCTAssertNil(body["enabled"])
                let overlay = try XCTUnwrap(body["configOverride"] as? [String: Any])
                XCTAssertEqual(overlay["params"] as? [String: String], ["path": "/example/after", "future": "keep-local"])
                localSaved = true
                return "{}"
            default: XCTFail("Unexpected settings request: \(request.url?.path ?? "")")
                return "{}"
            }
        }
        defer { fixture.close() }
        let descriptor =
            try basicDescriptor(
                extra: #", "memberScopedParamNames":["path","future"],"params":[{"name":"shared","label":"Shared value","type":"string"},{"name":"path","label":"Folder","type":"path","scope":"member"}]"#
            )
        let source = try decode(DesktopSource.self, global)
        let flow = DesktopSourceSettingsFlow(source: source, descriptor: descriptor, api: fixture.api)
        await flow.load()
        XCTAssertNil(flow.error)
        flow.sharedValues["shared"] = "after"
        await flow.saveShared()
        XCTAssertTrue(sharedSaved)
        XCTAssertEqual(flow.sharedValues["shared"], "after")
        flow.localValues["path"] = "/example/after"
        await flow.saveLocal()
        XCTAssertTrue(localSaved)
        XCTAssertEqual(flow.localValues["path"], "/example/after")
        XCTAssertEqual(flow.message, "Settings saved. The source remains paused.")
        XCTAssertNil(flow.error)
    }

    func testExclusiveMoveRequiresConfirmationAndLostReplyCannotResumeAPausedSource() async throws {
        let source = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":false,"deviceId":"other","multiDeviceMode":"exclusive","config":{"opaque":"keep"}}"#
        var moved = false
        var writes = 0
        let revision = String(repeating: "a", count: 64)
        let fixture = try fixture { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/admin/sources"):
                let current = moved ? source.replacingOccurrences(of: #""deviceId":"other""#, with: #""deviceId":"local""#) : source
                return #"{"items":[\#(current)]}"#
            case ("GET", "/admin/sources/fixture-source"): return #"{"source":\#(source),"revision":"\#(revision)"}"#
            case ("PATCH", "/admin/sources/fixture-source"):
                writes += 1
                let body = try Self.body(request)
                XCTAssertEqual(body["deviceId"] as? String, "local")
                XCTAssertEqual(body["expectedRevision"] as? String, revision)
                XCTAssertNil(body["enabled"])
                moved = true
                throw URLError(.networkConnectionLost)
            default: XCTFail("Unexpected move request")
                return "{}"
            }
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        flow.accounts = ["example-account"]
        flow.selectedAccounts = ["example-account"]
        await flow.add()
        XCTAssertNotNil(flow.pendingMove)
        XCTAssertEqual(writes, 0)
        XCTAssertFalse(flow.complete)
        await flow.confirmMove()
        XCTAssertNotNil(flow.error)
        XCTAssertEqual(writes, 1)
        await flow.add()
        XCTAssertEqual(writes, 1)
        XCTAssertTrue(flow.complete)
        XCTAssertTrue(flow.keptPausedAfterMove)
    }

    func testSettingsWithoutARevisionNeverEnableUnsafeWrites() async throws {
        let source = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":true,"deviceId":"local","config":{}}"#
        let fixture = try fixture { request in
            XCTAssertEqual(request.httpMethod, "GET")
            return #"{"source":\#(source)}"#
        }
        defer { fixture.close() }
        let flow = try DesktopSourceSettingsFlow(
            source: decode(DesktopSource.self, source),
            descriptor: basicDescriptor(),
            api: fixture.api
        )
        await flow.load()
        await flow.saveShared()
        XCTAssertNil(flow.snapshot)
        XCTAssertNotNil(flow.error)
        XCTAssertEqual(fixture.script.requests.count, 1)
    }

    func testDifferentFolderIdentityNeverOverwritesExistingSource() async throws {
        let source = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":false,"deviceId":"local","config":{"params":{"path":"/example/original"}}}"#
        let revision = String(repeating: "a", count: 64)
        let fixture = try fixture { request in
            XCTAssertNotEqual(request.httpMethod, "PATCH")
            switch request.url?.path {
            case "/admin/sources": return #"{"items":[\#(source)],"pendingRemovals":[]}"#
            case "/admin/sources/validate-param": return #"{"valid":true}"#
            case "/admin/sources/resolve-account": return #"{"accountId":"different-account"}"#
            default: return #"{"source":\#(source),"revision":"\#(revision)"}"#
            }
        }
        defer { fixture.close() }
        let descriptor =
            try basicDescriptor(
                extra: #", "hasResolveAccountId":true,"memberScopedParamNames":["path"],"params":[{"name":"path","label":"Folder","type":"path","scope":"member"}]"#
            )
        let flow = try DesktopSourceSettingsFlow(source: decode(DesktopSource.self, source), descriptor: descriptor, api: fixture.api)
        await flow.load()
        flow.localValues["path"] = "/example/different"
        await flow.saveLocal()
        XCTAssertTrue(flow.error?.contains("different account") == true)
        XCTAssertEqual(flow.localValues["path"], "/example/original")
    }

    func testLostRemovalReplyObservesDurableCompletionWithoutRepeatingDelete() async throws {
        let source = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":false,"deviceId":"local","config":{}}"#
        var removals = 0
        let fixture = try fixture { request in
            if request.httpMethod == "DELETE" {
                removals += 1
                throw URLError(.networkConnectionLost)
            }
            return #"{"items":[],"pendingRemovals":[]}"#
        }
        defer { fixture.close() }
        let flow = try DesktopSourceSettingsFlow(
            source: decode(DesktopSource.self, source),
            descriptor: basicDescriptor(),
            api: fixture.api
        )
        await flow.removeSource()
        XCTAssertTrue(flow.removalRequested)
        XCTAssertTrue(flow.removalComplete)
        XCTAssertNil(flow.error)
        await flow.removeSource()
        XCTAssertEqual(removals, 1)
    }

    func testRenderSourceSettingsMoveAndRemovalStates() async throws {
        let fixture = try fixture { _ in
            XCTFail("Prepared source previews must not access the network")
            return "{}"
        }
        defer { fixture.close() }
        let source = try decode(
            DesktopSource.self,
            #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":false,"deviceId":"local","members":["local","other"],"multiDeviceMode":"replicated","config":{"params":{}}}"#
        )
        let descriptor =
            try basicDescriptor(
                extra: #", "memberScopedParamNames":["path"],"params":[{"name":"shared","label":"History label","type":"string"},{"name":"path","label":"Library folder","type":"path","scope":"member"}]"#
            )
        let snapshot = try decode(
            DesktopSourceSettingsSnapshot.self,
            #"{"source":{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":false,"deviceId":"other","multiDeviceMode":"exclusive","config":{}},"revision":"\#(String(repeating: "a", count: 64))"}"#
        )
        let flow = DesktopSourceSettingsFlow(source: source, descriptor: descriptor, api: fixture.api)
        flow.snapshot = try decode(
            DesktopSourceSettingsSnapshot.self,
            #"{"source":{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":false,"deviceId":"local","members":["local","other"],"multiDeviceMode":"replicated","config":{}},"revision":"\#(String(repeating: "a", count: 64))"}"#
        )
        flow.memberSnapshot = flow.snapshot
        flow.memberIds = ["local", "other"]
        flow.sharedValues = ["shared": "Personal library"]
        flow.localValues = ["path": "/example/library"]
        let store = DesktopStore.preview()
        try await DesktopSnapshotRenderer.render(
            DesktopSourceSettingsView(flow: flow).environment(store),
            name: "source-settings-paused",
            size: CGSize(width: 660, height: 650)
        )
        let move = DesktopSourceFlow(descriptor: descriptor, api: fixture.api)
        try await DesktopSnapshotRenderer.render(
            DesktopSourceMoveConfirmation(flow: move, pending: snapshot).environment(store),
            name: "source-move-paused-confirmation",
            size: CGSize(width: 520, height: 360)
        )
        let removal = DesktopSourceSettingsFlow(source: source, descriptor: descriptor, api: fixture.api)
        removal.removalRequested = true
        try await DesktopSnapshotRenderer.render(
            DesktopSourceSettingsView(flow: removal).environment(store),
            name: "source-removing",
            size: CGSize(width: 660, height: 650)
        )
        let complete = DesktopSourceSettingsFlow(source: source, descriptor: descriptor, api: fixture.api)
        complete.removalRequested = true
        complete.removalComplete = true
        try await DesktopSnapshotRenderer.render(
            DesktopSourceSettingsView(flow: complete).environment(store),
            name: "source-removed",
            size: CGSize(width: 660, height: 650)
        )
        XCTAssertTrue(fixture.script.requests.isEmpty)
    }

    private func redirectDescriptor() throws -> DesktopDescriptor {
        try basicDescriptor(
            extra: #", "credentials":{"fileKey":"invented-key","required":true,"fields":[{"name":"redirect","label":"Redirect address","default":"{gatewayOrigin}/oauth/callback"}]}"#
        )
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
