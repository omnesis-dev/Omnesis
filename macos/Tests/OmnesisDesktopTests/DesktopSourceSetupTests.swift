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
    private let descriptorFixture = SourceSetupDescriptorFixture()
    func testFailedRegistrationRetainsAnAccountRecoveryActionAfterSignInCompleted() async throws {
        let fixture = try fixture { request in
            if request.url?.path == "/admin/sources" { return #"{"items":[]}"# }
            XCTAssertEqual(request.url?.path, "/admin/sources/add")
            throw URLError(.cannotConnectToHost)
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        flow.accounts = ["fictional-account"]
        flow.selectedAccounts = ["fictional-account"]
        flow.auth = try decode(AuthSnapshot.self, #"{"state":"completed"}"#)
        await flow.add()
        XCTAssertNotNil(flow.error)
        XCTAssertFalse(flow.complete)
        XCTAssertEqual(flow.auth?.state, "completed")
        XCTAssertTrue(flow.offersAnotherAccountAfterFailure)
        XCTAssertTrue(flow.offersRegistrationRetry)
        XCTAssertEqual(fixture.script.operationRequests.map { $0.url?.path }, ["/admin/sources", "/admin/sources/add"])
        flow.accounts = []
        flow.auth = nil
        XCTAssertFalse(flow.offersRegistrationRetry)
        XCTAssertFalse(
            flow.offersAnotherAccountAfterFailure,
            "A general failure before choosing an account should not suggest another account"
        )
    }

    func testFailedRegistrationRetryShowsActualProgressThenSuccessWithoutWaitingForSignInAgain() async throws {
        let gate = SourceSetupMetadataGate()
        defer { gate.release() }
        let replies = SourceSetupResponseState()
        let fixture = try fixture { request in
            switch request.url?.path {
            case "/admin/sources", "/admin/source-descriptors": return #"{"items":[]}"#
            case "/agent/conversations":
                XCTAssertEqual(request.httpMethod, "GET")
                return #"{"conversations":[],"nextCursor":null}"#
            case "/admin/sources/add":
                if replies.get("attempt") != "retry" {
                    replies.set("attempt", "retry")
                    throw URLError(.cannotConnectToHost)
                }
                try gate.waitForRelease()
                return "{}"
            default: XCTFail("Registration retry must reuse the chosen account, without restarting sign-in")
                return "{}"
            }
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        flow.accounts = ["fictional-account"]
        flow.selectedAccounts = ["fictional-account"]
        flow.auth = try decode(AuthSnapshot.self, #"{"state":"completed"}"#)
        await flow.add()
        XCTAssertNotNil(flow.error)
        let store = DesktopStore.preview()
        store.api = fixture.api
        let retiringContext = try XCTUnwrap(store.apiContext)
        let host = NSHostingView(rootView: SourceSetupView(flow: flow).environment(store).omnesisTheme())
        host.frame = NSRect(x: 0, y: 0, width: 680, height: 600)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        @MainActor func contains(_ identifier: String) throws -> Bool {
            try DesktopAccessibilityDriver.elements(in: host).contains { $0.accessibilityIdentifier() == identifier }
        }
        @MainActor func wait(_ condition: () throws -> Bool) async throws {
            let deadline = ContinuousClock.now + .seconds(3)
            while ContinuousClock.now < deadline {
                if try condition(), ContinuousClock.now < deadline { return }
                try await Task.sleep(for: .milliseconds(10))
            }
            throw DesktopAPIError.message("The mounted source setup did not reach its expected state.")
        }
        var failure: Error?
        do {
            try await DesktopAccessibilityDriver.materializeOwnedApplication()
            try await wait { try contains("source-auth-attention") }
            let heading = try DesktopAccessibilityDriver.element("source-auth-attention", in: host)
            XCTAssertTrue(heading.accessibilityLabel() == "Connection needs attention" || heading
                .accessibilityTextValue() == "Connection needs attention")
            XCTAssertTrue(try contains("source-setup-error"))
            XCTAssertFalse(try contains("source-auth-waiting"))
            XCTAssertFalse(try contains("source-setup-progress"))
            let retry = try DesktopAccessibilityDriver.element("source-recovery-registration", in: host)
            XCTAssertTrue(retry.isAccessibilityEnabled())
            XCTAssertTrue(retry.accessibilityPerformPress())
            try await wait { gate.entered && flow.busy }
            try await wait { try contains("source-setup-progress") && contains("source-auth-complete") }
            XCTAssertNil(flow.error)
            XCTAssertEqual(flow.auth?.state, "completed")
            XCTAssertFalse(try contains("source-auth-attention"))
            XCTAssertFalse(try contains("source-auth-waiting"), "Registration is running; sign-in is already complete")
            gate.release()
            try await wait { flow.complete && !flow.busy && store.sourcesLoaded }
            XCTAssertTrue(try contains("source-setup-added"))
            XCTAssertFalse(try contains("source-setup-error"))
            XCTAssertFalse(try contains("source-auth-waiting"))
            XCTAssertFalse(try contains("source-setup-progress"))
            XCTAssertEqual(fixture.script.operationRequests.filter { $0.url?.path == "/admin/sources/add" }.count, 2)
            XCTAssertFalse(fixture.script.operationRequests.contains { $0.url?.path.hasPrefix("/admin/auth-flows") == true })
        } catch { failure = error }
        gate.release()
        window.contentView = nil
        window.close()
        await flow.cancel()
        store.api = nil
        // Source completion refreshes real history too; join that retired request scope.
        await retiringContext.drain()
        if let failure { throw failure }
    }

    func testChoosingAnotherAccountCancelsRefusedFlowAndCollectsFreshAccountCredentials() async throws {
        let fixture = try fixture { request in
            switch request.url?.path {
            case "/admin/auth-flows/refused/cancel": return "{}"
            case "/admin/credentials":
                return #"{"items":[{"fileKey":"invented-key","configured":true,"brokeredAccounts":["previous-account"]}]}"#
            default: XCTFail("Choosing another account must not discover or reuse prior credentials")
                return "{}"
            }
        }
        defer { fixture.close() }
        let descriptor = try basicDescriptor(
            extra: #", "credentials":{"fileKey":"invented-key","perAccount":true,"required":true,"fields":[{"name":"token","label":"Access key","secret":true,"required":true}]}"#,
            discover: true
        )
        let flow = DesktopSourceFlow(descriptor: descriptor, api: fixture.api)
        flow.flowId = "refused"
        flow.auth = try decode(AuthSnapshot.self, #"{"state":"error","errorDetail":{"code":"denied","retryable":false}}"#)
        flow.credentials = ["token": "previous-account-fixture"]
        flow.accounts = ["previous-account"]
        flow.selectedAccounts = ["previous-account"]
        XCTAssertTrue(flow.canAuthenticateAnotherAccount)
        await flow.authenticateAnotherAccount()
        XCTAssertTrue(flow.needsCredentials)
        XCTAssertTrue(flow.credentials.isEmpty)
        XCTAssertTrue(flow.accounts.isEmpty)
        XCTAssertTrue(flow.selectedAccounts.isEmpty)
        XCTAssertNil(flow.auth)
        XCTAssertNil(flow.error)
        XCTAssertEqual(fixture.script.operationRequests.map { $0.url?.path }, ["/admin/auth-flows/refused/cancel", "/admin/credentials"])
    }

    func testExistingAccountRepairCannotSwitchToAnotherAccount() async throws {
        let fixture = try fixture { _ in XCTFail("Pinned repair must not start another account flow")
            return "{}"
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api, accountId: "pinned-account", hostId: "local")
        XCTAssertFalse(flow.canAuthenticateAnotherAccount)
        await flow.authenticateAnotherAccount()
        XCTAssertTrue(fixture.script.operationRequests.isEmpty)
        XCTAssertEqual(flow.deviceId, "local")
    }

    func testActualSerializedCredentialWizardPreservesRequiredDefaultAndPattern() throws {
        let descriptor = try decode(
            DesktopDescriptor.self,
            #"{"id":"invented","name":"Invented","description":"Fictional provider","permissionRequirements":[],"hasAuthFlow":true,"hasDiscover":false,"devices":[{"id":"local","name":"My Mac"}],"credentials":{"fileKey":"fictional-key","required":true,"publicClient":false,"perAccount":true,"fields":[{"name":"token","label":"Access key","secret":true,"required":true,"default":"prefix-","pattern":"^prefix-.+$","patternHint":"Start with prefix-"}],"wizard":{"intro":"Connect an account","why":"The provider needs a key","estMinutes":2,"steps":[{"kind":"open-url","title":"Create a key","body":"Use your library at {gatewayOrigin}","url":"https://provider.example.com/keys"}]}}}"#
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
        XCTAssertEqual(fixture.script.operationRequests.count, 1)
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
        XCTAssertTrue(fixture.script.operationRequests.isEmpty)
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
        XCTAssertEqual(fixture.script.operationRequests.count, 1)
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
        refused.auth = try decode(AuthSnapshot.self, #"{"state":"error","errorDetail":{"code":"denied"}}"#)
        refused.error = "Access was declined. Choose another account or review the provider’s permissions."
        try await renderSource(refused, name: "source-refused")
        let question = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        question.auth = try decode(
            AuthSnapshot.self,
            #"{"state":"awaiting-user","pendingChallenge":{"id":"question-1","expectsAnswer":true,"challenge":{"kind":"fields","title":"Choose the information to connect","instructions":"Choose a region and confirm your preferences.","schema":{"region":{"kind":"select","label":"Region","options":[{"value":"north","label":"North"},{"value":"south","label":"South"}]},"count":{"kind":"number","label":"History in months","min":1,"max":12},"includeArchived":{"kind":"boolean","label":"Include archived items"}}}}}"#
        )
        question.answer = ["region": "north", "count": "3", "includeArchived": "false"]
        try await renderSource(question, name: "source-auth-question")
        XCTAssertTrue(fixture.script.operationRequests.isEmpty)
    }

    func testRenderedSourceFailuresExplainTheReasonBeforeSupportedRecoveryAndCancellation() async throws {
        let fixture = try fixture { _ in XCTFail("Rendering recovery must not invoke authentication or registration")
            return "{}"
        }
        defer { fixture.close() }
        let cases: [(String, String, Bool, Bool, [String])] = [
            ("account", "denied", false, false, ["source-recovery-account"]),
            (
                "retry",
                "temporarily-unavailable",
                true,
                false,
                ["source-recovery-sign-in", "source-recovery-credentials", "source-recovery-account"]
            ),
            ("credentials", "denied", true, false, ["source-recovery-credentials", "source-recovery-account"]),
            ("no-supported-repair", "denied", false, true, []),
            ("registration", "completed", false, false, ["source-recovery-registration", "source-recovery-account"]),
        ]
        let allRepairs = [
            "source-recovery-sign-in",
            "source-recovery-credentials",
            "source-recovery-account",
            "source-recovery-registration",
        ]
        for (name, code, credentials, pinned, repairs) in cases {
            let descriptor = try basicDescriptor(extra: credentials
                ? #", "credentials":{"fileKey":"invented-key","required":true,"fields":[{"name":"token","label":"Access key","secret":true}]}"#
                : "")
            let flow = DesktopSourceFlow(descriptor: descriptor, api: fixture.api, accountId: pinned ? "fictional-account" : nil)
            flow.auth = try decode(
                AuthSnapshot.self,
                code == "completed"
                    ? #"{"state":"completed"}"#
                    : #"{"state":"error","errorDetail":{"code":"\#(code)"}}"#
            )
            if code == "completed" {
                flow.accounts = ["fictional-account"]
                flow.selectedAccounts = ["fictional-account"]
            }
            let reason = "The provider could not finish this step. Review the available recovery actions."
            flow.error = reason
            try await renderSource(flow, name: "source-recovery-\(name)") { root in
                let elements = try DesktopAccessibilityDriver.elements(in: root)
                let explanation = try DesktopAccessibilityDriver.element("source-setup-error", in: root)
                XCTAssertTrue(explanation.accessibilityLabel() == reason || explanation.accessibilityTextValue() == reason)
                let heading = try DesktopAccessibilityDriver.element("source-auth-attention", in: root)
                let attention = code == "completed" ? "Connection needs attention" : "Sign-in needs attention"
                XCTAssertTrue(heading.accessibilityLabel() == attention || heading.accessibilityTextValue() == attention)
                XCTAssertFalse(elements.contains { $0.accessibilityIdentifier() == "source-auth-waiting" })
                let window = try XCTUnwrap(root.window)
                @MainActor func visibleFrame(_ element: DesktopAccessibilityDriver.Element) -> NSRect {
                    let frame = element.accessibilityFrame()
                    XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
                    XCTAssertGreaterThan(frame.width, 0)
                    XCTAssertGreaterThan(frame.height, 0)
                    XCTAssertTrue(window.frame.contains(frame), "Recovery must remain inside its owning window")
                    return frame
                }
                var previous = visibleFrame(explanation)
                for identifier in allRepairs {
                    let present = elements.contains { $0.accessibilityIdentifier() == identifier }
                    XCTAssertEqual(present, repairs.contains(identifier), "Only supported recovery controls may be shown")
                }
                for identifier in repairs + ["source-cancel-sign-in", "source-advanced-setup"] {
                    let control = try DesktopAccessibilityDriver.element(identifier, in: root)
                    XCTAssertEqual(control.accessibilityRole(), .button)
                    XCTAssertTrue(control.isAccessibilityEnabled())
                    let frame = visibleFrame(control)
                    XCTAssertGreaterThanOrEqual(
                        previous.minY,
                        frame.maxY,
                        "Reason, recovery, cancellation and advanced setup must read in order"
                    )
                    previous = frame
                }
            }
        }
        XCTAssertTrue(fixture.script.operationRequests.isEmpty, "Presentation cannot start, retry or cancel a server operation")
    }

    func testRenderedInputFailureKeepsThePendingChallengeActionableWithoutClaimingActiveWaiting() async throws {
        let fixture = try fixture { _ in XCTFail("Rendering sign-in state must not submit an answer")
            return "{}"
        }
        defer { fixture.close() }
        let challenge = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        challenge.auth = try decode(
            AuthSnapshot.self,
            #"{"state":"awaiting-user","pendingChallenge":{"id":"fictional-code","expectsAnswer":true,"challenge":{"kind":"code","title":"Confirm this connection"}}}"#
        )
        challenge.answer = ["code": "invented-code"]
        challenge.error = "Enter the confirmation code, then continue."
        try await renderSource(challenge, name: "source-auth-input-needs-attention") { root in
            let elements = try DesktopAccessibilityDriver.elements(in: root)
            XCTAssertTrue(elements.contains { $0.accessibilityIdentifier() == "source-auth-attention" })
            XCTAssertEqual(challenge.answer["code"], "invented-code")
            XCTAssertFalse(elements.contains { $0.accessibilityIdentifier() == "source-auth-waiting" })
            XCTAssertTrue(elements.contains { $0.accessibilityLabel() == "Confirmation code" && $0.accessibilityRole() == .textField })
            let answer = try XCTUnwrap(elements.first { $0.accessibilityIdentifier() == "source-auth-answer" })
            XCTAssertEqual(answer.accessibilityRole(), .textField)
            XCTAssertEqual(answer.accessibilityLabel(), "Confirmation code")
            XCTAssertTrue(answer.isAccessibilityEnabled())
            XCTAssertTrue(elements
                .contains { $0.accessibilityLabel() == "Continue" && $0.accessibilityRole() == .button && $0.isAccessibilityEnabled() })
            XCTAssertTrue(elements.contains { $0.accessibilityIdentifier() == "source-cancel-sign-in" })
        }
        let waiting = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        waiting.auth = try decode(
            AuthSnapshot.self,
            #"{"state":"awaiting-callback","message":"Finish sign-in in the app you are connecting."}"#
        )
        try await renderSource(waiting, name: "source-auth-awaiting-confirmation") { root in
            let elements = try DesktopAccessibilityDriver.elements(in: root)
            XCTAssertTrue(elements.contains { $0.accessibilityIdentifier() == "source-auth-waiting" })
            XCTAssertFalse(elements.contains { $0.accessibilityIdentifier() == "source-auth-attention" })
        }
        XCTAssertTrue(fixture.script.operationRequests.isEmpty)
    }

    private func renderSource(
        _ flow: DesktopSourceFlow, name: String, validate: ((NSView) throws -> Void)? = nil
    ) async throws {
        let store = DesktopStore.preview()
        store.api = flow.api
        await flow.prepareSelectedDevice()
        let view = SourceSetupView(flow: flow).environment(store)
        try await DesktopSnapshotRenderer.render(view, name: name, size: CGSize(width: 680, height: 680), validate: validate)
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
        XCTAssertEqual(fixture.script.operationRequests.count, 1)
    }

    func testMalformedRepeatedSettingsAreRefusedBeforePresentationOrWrites() async throws {
        let source = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":true,"deviceId":"local","config":{}}"#
        let fixture = try fixture { request in
            XCTAssertEqual(request.httpMethod, "GET")
            if request.url?.path == "/admin/sources" { return #"{"items":[\#(source)]}"# }
            return #"{"source":\#(source),"revision":"\#(String(repeating: "a", count: 64))"}"#
        }
        defer { fixture.close() }
        let descriptor =
            try basicDescriptor(
                extra: #", "params":[{"name":"folder","label":"Folder","type":"path"},{"name":"folder","label":"Repeated folder","type":"path"}]"#
            )
        let flow = try DesktopSourceSettingsFlow(source: decode(DesktopSource.self, source), descriptor: descriptor, api: fixture.api)
        await flow.load()
        XCTAssertTrue(flow.error?.contains("repeated a setting") == true)
        XCTAssertNil(flow.snapshot)
    }

    func testDifferentFolderIdentityNeverOverwritesExistingSource() async throws {
        let source = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":false,"deviceId":"local","config":{"params":{"path":"/example/original"}}}"#
        let revision = String(repeating: "a", count: 64)
        let fixture = try fixture(scopedDescriptors: { device in
            #"{"deviceId":"\#(device)","items":[{"id":"invented","name":"Selected source","description":"Current schema","hasAuthFlow":true,"hasDiscover":false,"hasResolveAccountId":true,"permissionRequirements":[],"memberScopedParamNames":["path"],"params":[{"name":"path","label":"Folder","type":"path","scope":"member"}]}]}"#
        }) { request in
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
                extra: #", "memberScopedParamNames":["path"],"params":[{"name":"path","label":"Folder","type":"path","scope":"member"}]"#
            )
        let flow = try DesktopSourceSettingsFlow(source: decode(DesktopSource.self, source), descriptor: descriptor, api: fixture.api)
        await flow.load()
        flow.localValues["path"] = "/example/different"
        await flow.saveLocal()
        XCTAssertTrue(flow.error?.contains("different account") == true)
        XCTAssertEqual(flow.localValues["path"], "/example/different")
        XCTAssertFalse(flow.canEditSelectedHost, "A rejected identity keeps the draft read-only until a fresh review")
    }

    func testLostRemovalReplyObservesDurableCompletionWithoutRepeatingDelete() async throws {
        let source = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":false,"deviceId":"local","config":{}}"#
        var removals = 0
        let fixture = try fixture { request in
            if request.httpMethod == "DELETE" {
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "\"\(String(repeating: "a", count: 64))\"")
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
        flow.snapshot = try decode(
            DesktopSourceSettingsSnapshot.self,
            #"{"source":\#(source),"revision":"\#(String(repeating: "a", count: 64))"}"#
        )
        await flow.removeSource()
        XCTAssertTrue(flow.removalRequested)
        XCTAssertTrue(flow.removalComplete)
        XCTAssertNil(flow.error)
        await flow.removeSource()
        XCTAssertEqual(removals, 1)
    }

    func testRenderSourceSettingsMoveAndRemovalStates() async throws {
        let prepared = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":false,"deviceId":"local","members":["local","other"],"multiDeviceMode":"replicated","config":{"params":{"shared":"Personal library","path":"/example/library"}}}"#
        let fixture = try fixture { request in
            XCTAssertEqual(request.httpMethod, "GET", "Rendering prepared settings must not mutate a source")
            if request.url?.path == "/admin/sources" { return #"{"items":[\#(prepared)]}"# }
            return #"{"source":\#(prepared),"revision":"\#(String(repeating: "a", count: 64))"}"#
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
        await flow.load()
        XCTAssertNil(flow.error)
        XCTAssertTrue(flow.canEditSelectedHost)
        XCTAssertEqual(flow.localValues["path"], "/example/library")
        let store = DesktopStore.preview()
        store.api = fixture.api
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
        XCTAssertTrue(fixture.script.requests.allSatisfy { $0.httpMethod == "GET" })
    }

    func testHistoricalSettingsLoadWithoutMemberAndRemovalRemainsAccessible() async throws {
        let source = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":false,"deviceId":"forgotten","members":[],"archived":true,"archivedDevices":[{"deviceId":"forgotten","name":"Previous computer","kind":"collector","forgottenAt":1}],"config":{}}"#
        var removed = false
        let fixture = try fixture { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/admin/sources"):
                return removed ? #"{"items":[],"pendingRemovals":[]}"# : #"{"items":[\#(source)],"pendingRemovals":[]}"#
            case ("GET", "/admin/sources/fixture-source"):
                return #"{"source":\#(source),"revision":"\#(String(repeating: "a", count: 64))"}"#
            case ("DELETE", "/admin/sources/fixture-source"):
                removed = true
                return #"{"ok":true,"state":"removing"}"#
            default: XCTFail("Historical settings must not request a member or start collection")
                return "{}"
            }
        }
        defer { fixture.close() }
        let flow = try DesktopSourceSettingsFlow(
            source: decode(DesktopSource.self, source),
            descriptor: basicDescriptor(),
            api: fixture.api
        )
        await flow.load()
        XCTAssertNil(flow.error)
        XCTAssertNotNil(flow.snapshot)
        XCTAssertTrue(flow.historical)
        XCTAssertTrue(flow.memberIds.isEmpty)
        XCTAssertNil(flow.memberSnapshot)
        XCTAssertFalse(flow.canEditSelectedHost)
        await flow.setEnabled(true)
        XCTAssertFalse(fixture.script.requests.contains { $0.httpMethod == "PATCH" })
        let store = DesktopStore.preview()
        store.api = fixture.api
        try await DesktopSnapshotRenderer.render(
            DesktopSourceSettingsView(flow: flow).environment(store),
            name: "source-settings-historical", size: CGSize(width: 660, height: 650)
        )
        await flow.removeSource()
        XCTAssertTrue(flow.removalComplete)
        XCTAssertTrue(removed)
    }

    func testFocusedFolderSettingsCannotSilentlyFallBackToAnotherComputer() async throws {
        let initial = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":true,"deviceId":"local","members":["local","other"],"config":{}}"#
        let changed = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":true,"deviceId":"other","members":["other"],"config":{}}"#
        let fixture = try fixture { request in
            if request.url?.path == "/admin/sources" { return #"{"items":[\#(changed)]}"# }
            XCTAssertEqual(request.url?.path, "/admin/sources/fixture-source")
            return #"{"source":\#(changed),"revision":"\#(String(repeating: "a", count: 64))"}"#
        }
        defer { fixture.close() }
        let flow = try DesktopSourceSettingsFlow(
            source: decode(DesktopSource.self, initial),
            descriptor: basicDescriptor(),
            api: fixture.api,
            focusDeviceId: "local"
        )
        await flow.load()
        XCTAssertNotNil(flow.error)
        XCTAssertEqual(flow.selectedDeviceId, "local")
        XCTAssertNil(flow.memberSnapshot)
        XCTAssertFalse(
            fixture.script.requests.contains { $0.url?.path.contains("/members/") == true },
            "An access-recovery route must never open a sibling’s folder settings"
        )
    }

    func testMixedHistoricalSettingsSelectOnlyActualHealthyMember() async throws {
        let source = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":true,"deviceId":"forgotten","members":["other"],"archivedDevices":[{"deviceId":"forgotten","name":"Previous computer","kind":"collector","forgottenAt":1}],"config":{}}"#
        let fixture = try fixture { request in
            if request.url?.path == "/admin/sources" { return #"{"items":[\#(source)]}"# }
            XCTAssertTrue(["/admin/sources/fixture-source", "/admin/sources/fixture-source/members/other"]
                .contains(request.url?.path ?? ""))
            return #"{"source":\#(source),"revision":"\#(String(repeating: "a", count: 64))"}"#
        }
        defer { fixture.close() }
        let flow = try DesktopSourceSettingsFlow(
            source: decode(DesktopSource.self, source),
            descriptor: basicDescriptor(),
            api: fixture.api
        )
        await flow.load()
        XCTAssertNil(flow.error)
        XCTAssertEqual(flow.memberIds, ["other"])
        XCTAssertEqual(flow.selectedDeviceId, "other")
        XCTAssertTrue(flow.canEditSelectedHost)
        XCTAssertNotNil(flow.memberSnapshot)
        XCTAssertFalse(flow.historical)
    }

    func testRepairRefusesChangedMembershipBeforeAuthOrCredentialPublication() async throws {
        for lifecycle in [
            #""members":[],"archived":true"#,
            #""members":["other"]"#,
            #""members":["local"],"dormantHosts":["local"]"#,
        ] {
            let source = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":true,"deviceId":"local",\#(lifecycle)}"#
            let fixture = try fixture { request in
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/admin/sources")
                return #"{"items":[\#(source)]}"#
            }
            defer { fixture.close() }
            let flow = try DesktopSourceFlow(
                descriptor: basicDescriptor(), api: fixture.api, accountId: "example-account", hostId: "local",
                repairSourceId: "fixture-source"
            )
            await flow.begin()
            XCTAssertNotNil(flow.error)
            XCTAssertNil(flow.flowId)
            XCTAssertFalse(fixture.script.requests.contains { $0.httpMethod == "POST" })
        }
    }

    func testRepairRefusesRevokedRosterAndDoesNotFallBackToHealthySibling() async throws {
        let source = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":true,"deviceId":"local","members":["local","other"]}"#
        let fixture =
            try fixture(
                roster: #"{"items":[{"id":"local","name":"Previous computer","kind":"collector","revokedAt":1,"needsPairing":true},{"id":"other","name":"Other computer","kind":"collector"}]}"#
            ) { request in
                XCTAssertEqual(request.url?.path, "/admin/sources")
                return #"{"items":[\#(source)]}"#
            }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(
            descriptor: basicDescriptor(),
            api: fixture.api,
            accountId: "example-account",
            hostId: "local",
            repairSourceId: "fixture-source"
        )
        await flow.begin()
        XCTAssertNotNil(flow.error)
        XCTAssertEqual(flow.deviceId, "local")
        XCTAssertFalse(fixture.script.requests.contains { $0.httpMethod == "POST" })
    }

    func testOpenSettingsRechecksRetiredSelectedHostBeforeSaving() async throws {
        var retired = false
        let source = #"{"id":"fixture-source","type":"invented","accountId":"example-account","enabled":true,"deviceId":"local","members":["local"],"config":{"params":{}}}"#
        let fixture = try fixture { request in
            XCTAssertEqual(request.httpMethod, "GET")
            if request.url?.path == "/admin/sources" {
                let row = retired ? source
                    .replacingOccurrences(of: #""members":["local"]"#, with: #""members":[],"archived":true"#) : source
                return #"{"items":[\#(row)]}"#
            }
            return #"{"source":\#(source),"revision":"\#(String(repeating: "a", count: 64))"}"#
        }
        defer { fixture.close() }
        let flow = try DesktopSourceSettingsFlow(
            source: decode(DesktopSource.self, source),
            descriptor: basicDescriptor(),
            api: fixture.api
        )
        await flow.load()
        XCTAssertTrue(flow.canEditSelectedHost)
        retired = true
        await flow.saveShared()
        XCTAssertNotNil(flow.error)
        XCTAssertTrue(flow.historical)
        XCTAssertNil(flow.memberSnapshot)
        XCTAssertFalse(fixture.script.requests.contains { $0.httpMethod == "PATCH" || $0.httpMethod == "POST" })
    }

    func testDeniedAccessBlocksBeforeDiscoveryAuthAndRegistrationAndKeepsTheSourceDraft() async throws {
        let requirements = #"[{"id":"chosen-folder","kind":"selected-folder","summary":"Read the chosen folder","scope":"Only your chosen notebook","blocking":true,"actions":[{"kind":"choose-folder"},{"kind":"retry-access"}]}]"#
        let fixture = try fixture { request in
            if request.url?.path == "/admin/sources/validate-param" {
                let body = try Self.body(request)
                XCTAssertEqual(body["deviceId"] as? String, "local")
                XCTAssertEqual(body["paramName"] as? String, "folder")
                XCTAssertEqual(body["value"] as? String, "/tmp/fictional-notebook")
                return #"{"valid":true}"#
            }
            XCTAssertEqual(request.url?.path, "/admin/sources/permissions")
            let body = try Self.body(request)
            XCTAssertEqual(body["deviceId"] as? String, "local")
            XCTAssertEqual((body["params"] as? [String: String])?["folder"], "/tmp/fictional-notebook")
            return #"{"deviceId":"local","descriptorId":"invented","checkedAt":"2030-01-01T12:00:00Z","scopeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"denied","target":"unverified","requirements":\#(requirements)}"#
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(
            descriptor: basicDescriptor(
                extra: #","params":[{"name":"folder","label":"Notebook folder","type":"string","required":true}]"#,
                discover: true,
                requirements: requirements
            ),
            api: fixture.api
        )
        flow.params = ["folder": "/tmp/fictional-notebook"]
        await flow.begin()
        XCTAssertTrue(flow.needsAccess)
        XCTAssertEqual(flow.access.state, .denied)
        XCTAssertFalse(flow.complete)
        XCTAssertEqual(flow.params["folder"], "/tmp/fictional-notebook")
        XCTAssertEqual(fixture.script.operationRequests.count, 2, "Only parameter validation and the access check may run")
        XCTAssertFalse(fixture.script.operationRequests.contains {
            ["/admin/sources/discover", "/admin/auth-flows", "/admin/sources"].contains($0.url?.path ?? "")
        }, "No discovery, sign-in or registration may precede the access gate")
        await flow.tryCollectionToCheckAccess()
        XCTAssertEqual(fixture.script.operationRequests.count, 2, "A known denial must not dispatch anything beyond the two initial checks")
        await flow.cancel()
    }

    func testUnknownScopedAccessNeedsExplicitChoiceAndNeverBecomesVerified() async throws {
        let requirements = #"[{"id":"chosen-folder","kind":"selected-folder","summary":"Read chosen folders","scope":"Selected notebook roots","blocking":true,"actions":[{"kind":"retry-access"}]}]"#
        let fixture = try fixture { request in
            if request.url?.path == "/admin/sources/permissions" {
                return #"{"deviceId":"local","descriptorId":"invented","checkedAt":"2030-01-01T12:00:00Z","scopeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"unavailable","publicationGuard":"managed-v1","target":"unverified","requirements":\#(requirements)}"#
            }
            if request.url?.path == "/admin/auth-flows", request.httpMethod == "POST" { return #"{"flowId":"fictional-access-flow"}"# }
            if request.url?.path.hasSuffix("/cancel") == true { return #"{}"# }
            return #"{"state":"running"}"#
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(requirements: requirements), api: fixture.api)
        await flow.begin()
        XCTAssertNil(flow.flowId)
        await flow.tryCollectionToCheckAccess()
        XCTAssertEqual(flow.flowId, "fictional-access-flow")
        XCTAssertFalse(flow.access.allowsCollection)
        XCTAssertFalse(flow.complete)
        XCTAssertEqual(
            fixture.script.requests.filter { $0.url?.path == "/admin/sources/permissions" }.count,
            2,
            "Explicit continuation must recheck the same scope"
        )
        await flow.cancel()
    }

    func testActualSelectedDescriptorControlsFullAuthAndPermissionsRegardlessOfFleetOrder() async throws {
        let modern = #"{"id":"invented","name":"Selected current source","description":"Actual selected schema","hasAuthFlow":true,"hasDiscover":false,"permissionRequirements":[]}"#
        let legacy = #"{"id":"invented","name":"Selected legacy source","description":"Unknown access declaration","hasAuthFlow":false,"hasDiscover":false}"#
        for fleetRequirements in ["", #", "permissionRequirements":[]"#] {
            let fixture = try fixture(scopedDescriptors: { device in
                #"{"deviceId":"\#(device)","items":[\#(device == "local" ? modern : legacy)]}"#
            }) { request in
                switch request.url?.path {
                case "/admin/auth-flows":
                    let body = try Self.body(request)
                    XCTAssertEqual(body["deviceId"] as? String, "local")
                    XCTAssertTrue((body["params"] as? [String: String] ?? [:]).isEmpty)
                    return #"{"flowId":"selected-current-flow"}"#
                case "/admin/sources/permissions":
                    return #"{"deviceId":"other","descriptorId":"invented","scopeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","checkedAt":"2030-01-01T12:00:00Z","status":"unsupported","target":"unverified"}"#
                default: return request.url?.path.hasSuffix("/cancel") == true ? "{}" : #"{"state":"running"}"#
                }
            }
            let catalog = try decode(
                DesktopDescriptor.self,
                #"{"id":"invented","name":"Fleet summary","description":"Browse only","hasAuthFlow":false,"hasDiscover":false,"devices":[{"id":"local","name":"Current Mac"},{"id":"other","name":"Legacy Mac"}]\#(fleetRequirements)}"#
            )
            let current = DesktopSourceFlow(descriptor: catalog, api: fixture.api)
            current.params = ["old-draft-value": "kept"]
            await current.begin()
            XCTAssertEqual(current.flowId, "selected-current-flow")
            XCTAssertEqual(current.descriptor.name, "Selected current source")
            XCTAssertEqual(current.descriptor.permissionRequirements?.count, 0)
            XCTAssertEqual(current.params["old-draft-value"], "kept", "Changing operational schema must preserve the editable draft")
            XCTAssertFalse(fixture.script.requests.contains { $0.url?.path == "/admin/sources/permissions" })
            await current.cancel()
            let old = DesktopSourceFlow(descriptor: catalog, api: fixture.api)
            old.selectHost("other")
            await old.begin()
            XCTAssertEqual(old.descriptor.name, "Selected legacy source")
            XCTAssertNil(old.descriptor.permissionRequirements)
            XCTAssertFalse(old.descriptor.hasAuthFlow)
            XCTAssertNil(old.flowId)
            XCTAssertTrue(old.needsAccess, "Another collector’s [] must never authorize this legacy collector")
            await old.cancel()
            fixture.close()
        }
    }

    func testReplacingLibraryImmediatelyInvalidatesOwnedSourceDraftBeforeAnyLaterDispatch() async throws {
        let fixture = try fixture { request in
            if request.url?.path == "/admin/auth-flows" { return #"{"flowId":"old-owned-flow"}"# }
            return request.url?.path.hasSuffix("/cancel") == true ? "{}" : #"{"state":"running"}"#
        }
        defer { fixture.close() }
        let replacement = try self.fixture { _ in XCTFail("The replacement library must receive no source dispatch")
            return "{}"
        }
        defer { replacement.close() }
        let store = DesktopStore(startRuntime: false)
        store.api = fixture.api
        let draft = try store.sourceDraft(basicDescriptor(), api: fixture.api)
        await draft.begin()
        XCTAssertEqual(draft.flowId, "old-owned-flow")
        draft.credentials = ["key": "fictional-value"]
        store.api = replacement.api
        XCTAssertNil(draft.flowId)
        XCTAssertTrue(draft.credentials.isEmpty)
        draft.accounts = ["fictional-account"]
        draft.selectedAccounts = ["fictional-account"]
        await draft.add()
        await draft.cancel()
        XCTAssertFalse(fixture.script.requests.contains { $0.url?.path == "/admin/sources/add" })
        XCTAssertTrue(replacement.script.requests.isEmpty)
    }

    func testChangingSelectedComputerDuringMetadataReadCannotApplyItsSchemaOrStartAuthentication() async throws {
        let gate = SourceSetupMetadataGate()
        defer { gate.release() }
        let fixture = try fixture(scopedDescriptors: { device in
            if device == "local" { try gate.waitForRelease() }
            let requirements = device == "local" ? #", "permissionRequirements":[]"# : ""
            return #"{"deviceId":"\#(device)","items":[{"id":"invented","name":"Selected \#(device)","description":"Actual selected schema","hasAuthFlow":true,"hasDiscover":false\#(requirements)}]}"#
        }) { request in
            XCTAssertEqual(request.url?.path, "/admin/sources/permissions")
            return #"{"deviceId":"other","descriptorId":"invented","scopeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","checkedAt":"2030-01-01T12:00:00Z","status":"unsupported","target":"unverified"}"#
        }
        defer { fixture.close() }
        let catalog = try decode(
            DesktopDescriptor.self,
            #"{"id":"invented","name":"Fleet source","description":"Browse only","hasAuthFlow":true,"hasDiscover":false,"permissionRequirements":[],"devices":[{"id":"local"},{"id":"other"}]}"#
        )
        let flow = DesktopSourceFlow(descriptor: catalog, api: fixture.api)
        flow.params = ["draft": "kept"]
        let old = Task { await flow.begin() }
        let end = ContinuousClock.now + .seconds(2)
        while !gate.entered, ContinuousClock.now < end {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(gate.entered)
        flow.deviceId = "other"
        gate.release()
        await old.value
        XCTAssertNil(flow.descriptorDeviceId)
        XCTAssertNil(flow.flowId)
        XCTAssertEqual(flow.params["draft"], "kept")
        await flow.begin()
        XCTAssertEqual(flow.descriptorDeviceId, "other")
        XCTAssertNil(flow.descriptor.permissionRequirements)
        XCTAssertNil(flow.flowId)
        XCTAssertTrue(flow.needsAccess)
        await flow.cancel()
    }

    func testAuthenticationCompletionRechecksDescriptorAndRequiresReviewBeforeRegistrationAfterDrift() async throws {
        let state = SourceSetupResponseState()
        state.set("requirements", #", "permissionRequirements":[]"#)
        let fixture = try fixture(scopedDescriptors: { device in
            #"{"deviceId":"\#(device)","items":[{"id":"invented","name":"Current source","description":"Selected schema","hasAuthFlow":true,"hasDiscover":false\#(state.get("requirements"))}]}"#
        }) { request in
            switch request.url?.path {
            case "/admin/auth-flows": return #"{"flowId":"drift-flow"}"#
            case "/admin/auth-flows/drift-flow":
                return state.get("completed") == "yes" ? #"{"state":"completed","resolvedAccountIds":["fictional-account"]}"# : #"{"state":"running"}"#
            case "/admin/auth-flows/drift-flow/cancel": return "{}"
            default: XCTFail("Schema drift must be reviewed before any source dispatch")
                return "{}"
            }
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        flow.params = ["draft": "kept"]
        await flow.begin()
        XCTAssertEqual(flow.flowId, "drift-flow")
        state.set("requirements", "")
        state.set("completed", "yes")
        let end = ContinuousClock.now + .seconds(3)
        while !flow.needsDescriptorReview, ContinuousClock.now < end {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(flow.needsDescriptorReview)
        XCTAssertEqual(flow.params["draft"], "kept")
        XCTAssertNil(flow.descriptor.permissionRequirements)
        await flow.add()
        XCTAssertFalse(fixture.script.requests.contains { $0.url?.path == "/admin/sources/add" })
        XCTAssertTrue(flow.needsDescriptorReview, "A retry cannot silently accept the new schema")
        await flow.cancel()
    }

    func testQueuedSettingsActionsCannotMutateAnAPIThatIsNoLongerCurrent() async throws {
        let source = #"{"id":"fixture-source","type":"invented","accountId":"fictional-account","enabled":true,"deviceId":"local","members":["local","other"],"config":{}}"#
        let fixture = try fixture { request in
            XCTAssertEqual(request.httpMethod, "GET", "A stale queued pause, detach or remove must dispatch no writes")
            if request.url?.path == "/admin/sources" { return #"{"items":[\#(source)]}"# }
            return #"{"source":\#(source),"revision":"\#(String(repeating: "a", count: 64))"}"#
        }
        defer { fixture.close() }
        let flow = try DesktopSourceSettingsFlow(
            source: decode(DesktopSource.self, source),
            descriptor: basicDescriptor(),
            api: fixture.api
        )
        await flow.load()
        XCTAssertNil(flow.error)
        flow.isCurrentAPI = { false }
        await flow.setEnabled(false)
        await flow.detachSelectedDevice()
        await flow.removeSource()
        XCTAssertTrue(fixture.script.requests.allSatisfy { $0.httpMethod == "GET" })
        XCTAssertFalse(flow.removalRequested)
        XCTAssertFalse(flow.disconnected)
    }

    func testMoveConfirmationRefusesChangedSelectedSchemaBeforeAnyPatch() async throws {
        let state = SourceSetupResponseState()
        state.set("extra", "")
        let fixture = try fixture(scopedDescriptors: { device in
            #"{"deviceId":"\#(device)","items":[{"id":"invented","name":"Current source","description":"Selected schema","hasAuthFlow":true,"hasDiscover":false,"permissionRequirements":[]\#(state.get("extra"))}]}"#
        }) { _ in XCTFail("A changed source schema must not reach move dispatch")
            return "{}"
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(), api: fixture.api)
        await flow.prepareSelectedDevice()
        flow.params = ["draft": "kept"]
        flow.pendingMove = try decode(
            DesktopSourceSettingsSnapshot.self,
            #"{"source":{"id":"fixture-source","type":"invented","accountId":"fictional-account","enabled":false,"deviceId":"other","config":{}},"revision":"\#(String(repeating: "a", count: 64))"}"#
        )
        state.set("extra", #", "params":[{"name":"new-folder","label":"New folder","type":"path","required":true}]"#)
        await flow.confirmMove()
        XCTAssertTrue(flow.needsDescriptorReview)
        XCTAssertEqual(flow.params["draft"], "kept")
        XCTAssertFalse(fixture.script.requests.contains { $0.httpMethod == "PATCH" })
        await flow.cancel()
    }

    func testTrialMustRecheckCollectorGuardAndCannotReuseChoiceAfterGuardDisappears() async throws {
        let requirements = #"[{"id":"chosen-folder","kind":"selected-folder","summary":"Read selected folders","scope":"Selected notebook roots","blocking":true,"actions":[{"kind":"retry-access"}]}]"#
        var guarded = true
        let fixture = try fixture { request in
            XCTAssertEqual(request.url?.path, "/admin/sources/permissions")
            let declaration = guarded ? #""publicationGuard":"managed-v1","# : ""
            return #"{"deviceId":"local","descriptorId":"invented","checkedAt":"2030-01-01T12:00:00Z","scopeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"unavailable",\#(declaration)"target":"unverified","requirements":\#(requirements)}"#
        }
        defer { fixture.close() }
        let flow = try DesktopSourceFlow(descriptor: basicDescriptor(requirements: requirements), api: fixture.api)
        await flow.begin()
        guarded = false
        await flow.tryCollectionToCheckAccess()
        XCTAssertNil(flow.flowId)
        XCTAssertEqual(
            fixture.script.operationRequests.count,
            2,
            "The missing guard on the fresh check must prevent starting authentication"
        )
        guarded = true
        await flow.begin()
        XCTAssertNil(flow.flowId, "A refused trial is consumed rather than silently reused later")
        XCTAssertEqual(fixture.script.operationRequests.count, 3)
        await flow.cancel()
    }

    func testUnsupportedRemoteCollectorCannotUseTheManagedLocalTrial() async throws {
        let requirements = #"[{"id":"chosen-folder","kind":"selected-folder","summary":"Read selected folders","scope":"Selected notebook roots","blocking":true,"actions":[{"kind":"retry-access"}]}]"#
        let descriptor = try decode(
            DesktopDescriptor.self,
            #"{"id":"invented","name":"Invented","description":"Fictional source","hasAuthFlow":true,"hasDiscover":false,"devices":[{"id":"local","name":"This Mac"},{"id":"other","name":"Other computer"}],"permissionRequirements":\#(requirements)}"#
        )
        let fixture = try fixture { request in
            XCTAssertEqual(request.url?.path, "/admin/sources/permissions")
            return #"{"deviceId":"other","descriptorId":"invented","checkedAt":"2030-01-01T12:00:00Z","scopeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"unsupported","target":"unverified"}"#
        }
        defer { fixture.close() }
        let flow = DesktopSourceFlow(descriptor: descriptor, api: fixture.api, hostId: "other")
        await flow.begin()
        XCTAssertEqual(flow.access.state, .unsupported)
        let count = fixture.script.operationRequests.count
        await flow.tryCollectionToCheckAccess()
        XCTAssertEqual(fixture.script.operationRequests.count, count)
        XCTAssertNil(flow.flowId)
        XCTAssertFalse(flow.complete)
        XCTAssertFalse(flow.access.allowsCollection)
    }

    func testLocalCollectorIdentityWithoutRecognizedPublicationGuardCannotUseTrial() async throws {
        let requirements = #"[{"id":"chosen-folder","kind":"selected-folder","summary":"Read selected folders","scope":"Selected notebook roots","blocking":true,"actions":[{"kind":"retry-access"}]}]"#
        for declaration in ["", #""publicationGuard":"future-v2","#] {
            let fixture = try fixture { request in
                XCTAssertEqual(request.url?.path, "/admin/sources/permissions")
                return #"{"deviceId":"local","descriptorId":"invented","checkedAt":"2030-01-01T12:00:00Z","scopeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"unavailable",\#(declaration)"target":"unverified","requirements":\#(requirements)}"#
            }
            let flow = try DesktopSourceFlow(descriptor: basicDescriptor(requirements: requirements), api: fixture.api)
            await flow.begin()
            let count = fixture.script.operationRequests.count
            await flow.tryCollectionToCheckAccess()
            XCTAssertEqual(fixture.script.operationRequests.count, count)
            XCTAssertNil(flow.flowId)
            XCTAssertFalse(flow.complete)
            await flow.cancel()
            fixture.close()
        }
    }

    private func redirectDescriptor() throws -> DesktopDescriptor {
        try basicDescriptor(
            extra: #", "credentials":{"fileKey":"invented-key","required":true,"fields":[{"name":"redirect","label":"Redirect address","default":"{gatewayOrigin}/oauth/callback"}]}"#
        )
    }

    private func basicDescriptor(extra: String = "", discover: Bool = false, requirements: String? = "[]") throws -> DesktopDescriptor {
        try decode(
            DesktopDescriptor.self,
            #"{"id":"invented","name":"Invented","description":"Fictional source","hasAuthFlow":true,"hasDiscover":\#(discover),"devices":[{"id":"local","name":"My Mac"}]\#(requirements.map { ",\"permissionRequirements\":" + $0 } ?? "")\#(extra)}"#
        )
    }

    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        if type == DesktopDescriptor.self { descriptorFixture.set(text) }
        return try JSONDecoder().decode(type, from: Data(text.utf8))
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

    private func fixture(
        scopedDescriptors: ((String) throws -> String)? = nil,
        roster: String? =
            #"{"items":[{"id":"local","name":"This Mac","kind":"collector","revokedAt":null},{"id":"other","name":"Other computer","kind":"collector","revokedAt":null}]}"#,
        _ reply: @escaping (URLRequest) throws -> String
    ) throws
        -> Fixture {
        let host = "source-fixture-\(UUID().uuidString.lowercased()).example.com"
        let metadata = descriptorFixture
        let script = SourceSetupScript { request in
            if request.url?.path == "/admin/devices", let roster { return roster }
            if request.url?.path == "/admin/sources/descriptors" {
                XCTAssertEqual(request.httpMethod, "GET")
                let selected = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
                    .first(where: { $0.name == "deviceId" })?.value ?? ""
                if let scopedDescriptors { return try scopedDescriptors(selected) }
                return try metadata.response(deviceId: selected)
            }
            return try reply(request)
        }
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

    /// Metadata-only reads are separate from the existing auth/add/CAS dispatch assertions.
    var operationRequests: [URLRequest] {
        requests.filter { $0.httpMethod != "GET" || !["/admin/devices", "/admin/sources/descriptors"].contains($0.url?.path ?? "") }
    }

    func respond(_ request: URLRequest) throws -> String {
        lock.lock()
        seen.append(request)
        lock.unlock()
        return try reply(request)
    }
}

private final class SourceSetupDescriptorFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var text = "{}"
    func set(_ value: String) {
        lock.withLock { text = value }
    }

    func response(deviceId: String) throws -> String {
        let value = lock.withLock { text }
        let descriptor = try JSONSerialization.jsonObject(with: Data(value.utf8))
        return try String(decoding: JSONSerialization.data(withJSONObject: ["deviceId": deviceId, "items": [descriptor]]), as: UTF8.self)
    }
}

private final class SourceSetupMetadataGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var started = false
    private var released = false
    var entered: Bool {
        condition.lock()
        defer { condition.unlock() }
        return started
    }

    func waitForRelease() throws {
        condition.lock()
        defer { condition.unlock() }
        started = true
        let end = Date().addingTimeInterval(3)
        while !released {
            guard condition.wait(until: end) else { throw URLError(.timedOut) }
        }
    }

    func release() {
        condition.lock()
        released = true
        condition.broadcast()
        condition.unlock()
    }
}

private final class SourceSetupResponseState: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ key: String) -> String {
        lock.withLock { values[key] ?? "" }
    }

    func set(_ key: String, _ value: String) {
        lock.withLock { values[key] = value }
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
