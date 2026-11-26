// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopAPIContextTests: XCTestCase {
    func testMountedCredentialDraftCannotFollowReplacementApiAndFailedMetadata() async throws {
        let pair = try await ContextHTTPPair.start()
        defer { pair.stop() }
        try await pair.configureA(Self.modelRoutes)
        try await pair.configureB([
            "GET /admin/models": ["status": 500, "body": [:]],
            "GET /admin/model-credentials": ["status": 500, "body": [:]],
        ])
        let store = DesktopStore(startRuntime: false)
        store.api = pair.apiA
        let mounted = mount(.models, store: store)
        defer { mounted.window.close() }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        let field = "model-credential-fixture-key-apiKey"
        try await wait { (try? DesktopAccessibilityDriver.element(field, in: mounted.host)) != nil }
        try type("invented-scope-a-key", into: field, in: mounted.host)
        let old = try DesktopAccessibilityDriver.element("model-credential-save-fixture-key", in: mounted.host)
        XCTAssertTrue(old.isAccessibilityEnabled())
        store.api = pair.apiB
        try await wait { (try? DesktopAccessibilityDriver.element(field, in: mounted.host)) == nil }
        _ = old.accessibilityPerformPress()
        try await wait { try await !(pair.requestsB()).isEmpty }
        XCTAssertFalse(try DesktopAccessibilityDriver.contains("Fictional provider A", in: mounted.host))
        try await assertNoWrites(pair)
    }

    func testMountedCredentialSaveUsesItsReviewedApiAndOrdinaryClient() async throws {
        let pair = try await ContextHTTPPair.start()
        defer { pair.stop() }
        try await pair.configureA(Self.modelRoutes)
        let decoded = try await pair.apiA.admin.listModelCredentials()
        XCTAssertEqual(decoded.map(\.fileKey), ["fixture-key"], "The mounted form must receive the real paginated credentials contract")
        let store = DesktopStore(startRuntime: false)
        store.api = pair.apiA
        let mounted = mount(.models, store: store)
        defer { mounted.window.close() }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try await wait { (try? DesktopAccessibilityDriver.element("model-credential-fixture-key-apiKey", in: mounted.host)) != nil }
        try type("invented-scoped-key", into: "model-credential-fixture-key-apiKey", in: mounted.host)
        try DesktopAccessibilityDriver.press("model-credential-save-fixture-key", in: mounted.host)
        try await wait { try await (pair.writesA()).count == 1 }
        let writes = try await pair.writesA()
        let written = try XCTUnwrap(writes.first)
        XCTAssertEqual(written.path, "/admin/model-credentials/fixture-key")
        XCTAssertEqual(written.body?["fields"] as? [String: String], ["apiKey": "invented-scoped-key"])
        let replacementWrites = try await pair.writesB()
        XCTAssertTrue(replacementWrites.isEmpty)
    }

    func testStorageConfirmationAndPolicyActionsCannotCrossApiReplacement() async throws {
        let pair = try await ContextHTTPPair.start()
        defer { pair.stop() }
        try await pair.configureA(["GET /admin/storage": ["body": Self.storage]])
        try await pair.configureB(["GET /admin/storage": ["status": 500, "body": [:]]])
        let store = DesktopStore(startRuntime: false)
        store.api = pair.apiA
        let mounted = mount(.storage, store: store)
        defer { mounted.window.close() }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try await wait { (try? DesktopAccessibilityDriver.element("storage-save-limit", in: mounted.host)) != nil }
        let oldSave = try DesktopAccessibilityDriver.element("storage-save-limit", in: mounted.host)
        try DesktopAccessibilityDriver.press("storage-review-cleanup", in: mounted.host)
        try await wait { (try? self.control("storage-confirm-cleanup", mounted: mounted)) != nil }
        let oldConfirm = try control("storage-confirm-cleanup", mounted: mounted)
        store.api = pair.apiB
        try await wait { try await !(pair.requestsB()).isEmpty }
        _ = oldConfirm.accessibilityPerformPress()
        _ = oldSave.accessibilityPerformPress()
        try await assertNoWrites(pair)
        XCTAssertFalse(try DesktopAccessibilityDriver.contains("Storage has room for new information.", in: mounted.host))
    }

    func testQueuedOldContextWritesAreRefusedIncludingAbaAndCachedRosterClearsSynchronously() async throws {
        let pair = try await ContextHTTPPair.start()
        defer { pair.stop() }
        let store = DesktopStore(startRuntime: false)
        store.api = pair.apiA
        let first = try XCTUnwrap(store.apiContext)
        store.sources = try JSONDecoder().decode(
            [DesktopSource].self,
            from: Data(#"[{"id":"old-source","type":"example","accountId":"old-account","enabled":true,"deviceId":"old-device"}]"#.utf8)
        )
        store.devices = try JSONDecoder().decode(
            [DesktopDevice].self,
            from: Data(#"[{"id":"old-device","kind":"collector","name":"Old fixture computer"}]"#.utf8)
        )
        let pending = first.run { scope in
            try? await scope.mutate("PATCH", "admin/config", body: ["fictionalKey": "never-dispatched"])
        }
        store.api = pair.apiB
        XCTAssertTrue(store.sources.isEmpty)
        XCTAssertTrue(store.devices.isEmpty)
        XCTAssertFalse(store.sourcesLoaded)
        XCTAssertFalse(first.isCurrent)
        store.api = nil
        store.api = pair.apiA
        let replacement = try XCTUnwrap(store.apiContext)
        XCTAssertGreaterThan(replacement.id, first.id)
        await pending?.value
        do {
            try await first.mutate("POST", "admin/storage/cleanup/jobs", body: ["target": "conversations"])
            XCTFail("An old context cannot regain mutation authority when its API object reappears")
        } catch is CancellationError {} catch { XCTFail("Unexpected refusal type") }
        try await assertNoWrites(pair)
    }

    func testLateOldModelsCannotPopulateReplacementWhenReplacementFails() async throws {
        let pair = try await ContextHTTPPair.start()
        defer { pair.stop() }
        var held = Self.modelRoutes
        held["GET /admin/models"] = ["body": Self.models, "hold": true]
        try await pair.configureA(held)
        try await pair.configureB([
            "GET /admin/models": ["status": 500, "body": [:]],
            "GET /admin/model-credentials": ["status": 500, "body": [:]],
        ])
        let store = DesktopStore(startRuntime: false)
        store.api = pair.apiA
        let mounted = mount(.models, store: store)
        defer { mounted.window.close() }
        try await wait { try await (pair.requestsA()).contains { $0.path == "/admin/models" } }
        store.api = pair.apiB
        try await pair.releaseA()
        try await wait { try await !(pair.requestsB()).isEmpty }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        XCTAssertFalse(try DesktopAccessibilityDriver.contains("Fictional provider A", in: mounted.host))
        XCTAssertNil(try? DesktopAccessibilityDriver.element("model-credential-save-fixture-key", in: mounted.host))
        let replacementWrites = try await pair.writesB()
        XCTAssertTrue(replacementWrites.isEmpty)
    }

    func testLateMintedPhoneCodeIsWithdrawnOnlyFromIssuingApi() async throws {
        let pair = try await ContextHTTPPair.start()
        defer { pair.stop() }
        let expiry = Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)
        try await pair.configureA([
            "GET /admin/devices": ["body": ["items": []]],
            "POST /admin/devices/pair": ["body": ["pairingCode": "invented-late-a-code", "expiresAt": expiry], "hold": true],
            "DELETE /admin/devices/pair": ["body": ["revoked": true]],
        ])
        let store = DesktopStore(startRuntime: false)
        store.api = pair.apiA
        let context = try XCTUnwrap(store.apiContext)
        let model = DesktopPhonePairing()
        let starting = Task { await model.start(context: context, gatewayOrigin: URL(string: "https://library.example.com")!) }
        try await wait { try await (pair.requestsA()).contains { $0.method == "POST" && $0.path == "/admin/devices/pair" } }
        store.api = pair.apiB
        try await pair.releaseA()
        await starting.value
        await model.cancel()
        let deletes = try await pair.writesA().filter { $0.method == "DELETE" }
        XCTAssertEqual(deletes.count, 1)
        XCTAssertEqual(deletes.first?.body?["pairingCode"] as? String, "invented-late-a-code")
        let replacementWrites = try await pair.writesB()
        XCTAssertTrue(replacementWrites.isEmpty)
        XCTAssertNil(model.payload)
    }

    func testIssuedPhoneCodeRetiresWithoutDependingOnWindowDisappearance() async throws {
        let pair = try await ContextHTTPPair.start()
        defer { pair.stop() }
        let expiry = Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)
        try await pair.configureA([
            "GET /admin/devices": ["body": ["items": []]],
            "POST /admin/devices/pair": ["body": ["pairingCode": "invented-ready-code", "expiresAt": expiry]],
            "POST /admin/devices/pair-addresses": ["body": ["platform": "ios", "addresses": [[
                "gatewayUrl": "https://library.example.com", "host": "library.example.com", "label": "Fixture library",
                "usable": true, "systemTrust": true, "kind": "relay",
            ]]]],
            "POST /admin/devices/pair-qr": ["body": ["qrPayload": "invented-ready-qr"]],
            "DELETE /admin/devices/pair": ["body": ["revoked": true]],
        ])
        let store = DesktopStore(startRuntime: false)
        store.api = pair.apiA
        let context = try XCTUnwrap(store.apiContext)
        let model = DesktopPhonePairing()
        try await model.start(context: context, gatewayOrigin: XCTUnwrap(URL(string: "https://library.example.com")))
        XCTAssertEqual(model.payload, "invented-ready-qr")
        store.api = pair.apiB
        await context.drain()
        XCTAssertNil(model.payload)
        XCTAssertNil(model.pending)
        await model.cancel()
        let writes = try await pair.writesA()
        let withdrawn = writes.filter { $0.method == "DELETE" }
        XCTAssertEqual(withdrawn.count, 1)
        XCTAssertEqual(withdrawn.first?.body?["pairingCode"] as? String, "invented-ready-code")
        let replacementWrites = try await pair.writesB()
        XCTAssertTrue(replacementWrites.isEmpty)
    }

    func testDormantIntermediateContextsAndNilTransitionsJoinLateIssuanceBeforeSuccessorDispatch() async throws {
        let pair = try await ContextHTTPPair.start()
        defer { pair.stop() }
        let expiry = Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)
        try await pair.configureA([
            "GET /admin/devices": ["body": ["items": []]],
            "POST /admin/devices/pair": ["body": ["pairingCode": "invented-drained-code", "expiresAt": expiry], "hold": true],
            "DELETE /admin/devices/pair": ["body": ["revoked": true], "hold": true],
        ])
        try await pair.configureB(["PATCH /admin/config": ["body": [:]]])
        let store = DesktopStore(startRuntime: false)
        store.api = pair.apiA
        let first = try XCTUnwrap(store.apiContext)
        let model = DesktopPhonePairing()
        let starting = Task { await model.start(context: first, gatewayOrigin: URL(string: "https://library.example.com")!) }
        try await wait { try await (pair.requestsA()).contains { $0.method == "POST" } }
        store.api = pair.apiB
        store.api = nil
        store.api = pair.apiA
        store.api = nil
        store.api = pair.apiB
        let successor = try XCTUnwrap(store.apiContext)
        let next = successor.run { scope in
            do { try await scope.mutate("PATCH", "admin/config", body: ["fixture": "current-library-only"]) }
            catch { XCTFail("Current successor request failed: \(error)") }
        }
        await Task.yield()
        let premature = try await pair.writesB()
        XCTAssertTrue(premature.isEmpty, "Dormant intermediate contexts must not hide a physical predecessor request")
        try await pair.releaseA()
        try await wait { try await (pair.writesA()).contains { $0.method == "DELETE" } }
        let whileCleanupPending = try await pair.writesB()
        XCTAssertTrue(whileCleanupPending.isEmpty, "Successor dispatch must wait for exact issuing-API cleanup to complete")
        try await pair.releaseA()
        await starting.value
        await next?.value
        await model.cancel()
        let issuingWrites = try await pair.writesA()
        XCTAssertEqual(issuingWrites.map(\.method), ["POST", "DELETE"])
        XCTAssertEqual(issuingWrites.last?.body?["pairingCode"] as? String, "invented-drained-code")
        let successorWrites = try await pair.writesB()
        XCTAssertEqual(successorWrites.count, 1)
        XCTAssertEqual(successorWrites.first?.path, "/admin/config")
    }

    func testSearchResultsAndOpenDocumentAreDiscardedOnReplacement() async throws {
        let first = try await ScriptedAgentFixture.start()
        let second = try await ScriptedAgentFixture.start()
        defer { first.stop()
            second.stop()
        }
        let store = DesktopStore(startRuntime: false)
        store.api = try ContextHTTPPair.api(first.url)
        let mounted = mount(.search, store: store)
        defer { mounted.window.close() }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try type("Fictional outline", into: "library-search-input", in: mounted.host)
        try DesktopAccessibilityDriver.press("library-search-submit", in: mounted.host)
        try await wait { (try? DesktopAccessibilityDriver.element("search-document-fictional-document", in: mounted.host)) != nil }
        try DesktopAccessibilityDriver.press("search-document-fictional-document", in: mounted.host)
        try await wait { mounted.window.attachedSheet != nil }
        store.api = try ContextHTTPPair.api(second.url)
        try await wait {
            mounted.window.attachedSheet == nil &&
                (try? DesktopAccessibilityDriver.element("search-document-fictional-document", in: mounted.host)) == nil
        }
        let status = try await second.status()
        XCTAssertEqual(status.documentReads, 0)
        XCTAssertEqual(status.sends, 0)
    }

    func testMemoryAndBackupButtonsCannotReuseReviewedOldContext() async throws {
        let pair = try await ContextHTTPPair.start()
        defer { pair.stop() }
        try await pair.configureA([
            "GET /admin/config": ["body": ["config": ["gateway": [:]]]],
            "GET /admin/process-vitals": ["body": ["memory": ["current": ["rssBytes": 2048]]]],
            "GET /admin/artifacts": ["body": ["items": []]],
            "GET /admin/backup/status": ["body": ["running": false]],
            "GET /admin/export/status": ["body": ["running": false]],
        ])
        try await pair.configureB([:])
        for (screen, identifier) in [(Screen.memory, "memory-save"), (.backups, "backup-create")] {
            let store = DesktopStore(startRuntime: false)
            store.api = pair.apiA
            let mounted = mount(screen, store: store)
            try await DesktopAccessibilityDriver.materializeOwnedApplication()
            try await wait { (try? DesktopAccessibilityDriver.element(identifier, in: mounted.host).isAccessibilityEnabled()) == true }
            let oldAction = try DesktopAccessibilityDriver.element(identifier, in: mounted.host)
            store.api = pair.apiB
            try await wait { store.apiContext?.api === pair.apiB }
            _ = oldAction.accessibilityPerformPress()
            await Task.yield()
            mounted.window.close()
        }
        try await assertNoWrites(pair)
    }

    func testOffMacModelConfirmationCannotAuthorizeReplacementContext() async throws {
        let pair = try await ContextHTTPPair.start()
        defer { pair.stop() }
        var routes = Self.modelRoutes
        var overview = Self.models
        overview["capabilities"] = [["role": "agent", "title": "Questions", "description": "Fixture answers", "icon": "sparkles"]]
        overview["inference"] = ["allowRemoteInference": false, "assignments": [:], "backends": [
            "remote": [
                "type": "http",
                "status": "ok",
                "url": "https://model.example.com",
                "models": ["fictional-chat"],
                "modelRoles": ["fictional-chat": ["agent"]],
            ],
        ]]
        routes["GET /admin/models"] = ["body": overview]
        try await pair.configureA(routes)
        try await pair.configureB([:])
        let decoded = try await pair.apiA.admin.modelOverview()
        let decodedChoices = DesktopModelSelection.choices(for: "agent", overview: decoded)
        XCTAssertEqual(decodedChoices.map(\.id), ["remote/fictional-chat"], "The actual client must decode the off-host fixture choice")
        XCTAssertEqual(decodedChoices.map(\.title), ["remote · fictional-chat"])
        XCTAssertEqual(decodedChoices.map(\.onHost), [false], "This selection must require the real off-host consent")
        let store = DesktopStore(startRuntime: false)
        store.api = pair.apiA
        let mounted = mount(.models, store: store)
        defer { mounted.window.close() }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try await wait { (try? DesktopAccessibilityDriver.element("model-role-picker-agent", in: mounted.host)) != nil }
        func popups(_ view: NSView) -> [NSPopUpButton] {
            (view as? NSPopUpButton).map { [$0] } ?? view.subviews.flatMap(popups)
        }
        do {
            try await wait { popups(mounted.host).contains { $0.itemTitles.contains("remote · fictional-chat") } }
        } catch {
            try writeRolePickerDiagnostics(mounted.host, nativePopups: popups(mounted.host))
            throw error
        }
        let picker = try XCTUnwrap(popups(mounted.host).first { $0.itemTitles.contains("remote · fictional-chat") })
        picker.selectItem(withTitle: "remote · fictional-chat")
        XCTAssertTrue(picker.sendAction(picker.action, to: picker.target))
        try await wait {
            (try? DesktopAccessibilityDriver.element("model-role-save-agent", in: mounted.host).isAccessibilityEnabled()) == true
        }
        try DesktopAccessibilityDriver.press("model-role-save-agent", in: mounted.host)
        try await wait { (try? self.control("model-role-confirm-agent", mounted: mounted)) != nil }
        let oldConfirmation = try control("model-role-confirm-agent", mounted: mounted)
        store.api = pair.apiB
        await Task.yield()
        _ = oldConfirmation.accessibilityPerformPress()
        try await assertNoWrites(pair)
    }

    private func writeRolePickerDiagnostics(_ root: NSView, nativePopups: [NSPopUpButton]) throws {
        let picker = try DesktopAccessibilityDriver.element("model-role-picker-agent", in: root)
        var pending = [picker.object], seen: Set<ObjectIdentifier> = [], nodes: [[String: Any]] = []
        while let object = pending.popLast(), nodes.count < 128 {
            guard seen.insert(ObjectIdentifier(object)).inserted else { continue }
            let element = DesktopAccessibilityDriver.Element(object: object)
            nodes.append([
                "type": String(reflecting: Swift.type(of: object)), "role": element.accessibilityRole()?.rawValue ?? "none",
                "identifier": String((element.accessibilityIdentifier() ?? "").prefix(160)),
                "label": String((element.accessibilityLabel() ?? "").prefix(240)),
                "text": String((element.accessibilityTextValue() ?? "").prefix(240)),
                "enabled": element.isAccessibilityEnabled(),
            ])
            pending.append(contentsOf: element.accessibilityChildren().map { $0 as AnyObject })
            if let view = object as? NSView { pending.append(contentsOf: view.subviews) }
        }
        let facts: [String: Any] = [
            "stage": "native-role-picker-items", "decodedChoice": "remote/fictional-chat",
            "rolePickerNodes": nodes, "subtreeBoundReached": !pending.isEmpty,
            "nativePopups": nativePopups.prefix(32).map { popup in
                [
                    "type": String(reflecting: Swift.type(of: popup)),
                    "items": popup.itemTitles.prefix(64).map { String($0.prefix(240)) },
                ] as [String: Any]
            },
        ]
        let directory = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent("api-context-off-host-picker.txt")
        try JSONSerialization.data(withJSONObject: facts, options: [.sortedKeys]).write(to: destination, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
    }

    private func assertNoWrites(_ pair: ContextHTTPPair) async throws {
        let first = try await pair.writesA(), second = try await pair.writesB()
        XCTAssertTrue(first.isEmpty)
        XCTAssertTrue(second.isEmpty)
    }

    private enum Screen { case models, storage, search, memory, backups }
    private struct Root: View {
        @Environment(DesktopStore.self) private var store
        let screen: Screen
        var body: some View {
            Group {
                switch screen {
                case .models: DesktopModelsView(context: store.apiContext)
                case .storage: DesktopStorageView(context: store.apiContext)
                case .search: DesktopSearchView(context: store.apiContext)
                case .memory: DesktopMemoryView(context: store.apiContext)
                case .backups: DesktopBackupsView(context: store.apiContext)
                }
            }.id(store.apiContextEpoch).omnesisTheme()
        }
    }

    private struct Mounted { let window: NSWindow
        let host: NSView
    }

    private func mount(_ screen: Screen, store: DesktopStore) -> Mounted {
        let host = NSHostingView(rootView: Root(screen: screen).environment(store))
        host.frame = NSRect(x: 0, y: 0, width: 900, height: 900)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        return Mounted(window: window, host: host)
    }

    private func control(_ id: String, mounted: Mounted) throws -> DesktopAccessibilityDriver.Element {
        if let sheet = mounted.window.attachedSheet?.contentView,
           let element = try? DesktopAccessibilityDriver.element(id, in: sheet) { return element }
        return try DesktopAccessibilityDriver.element(id, in: mounted.host)
    }

    private func type(_ value: String, into identifier: String, in host: NSView) throws {
        let control = try DesktopAccessibilityDriver.element(identifier, in: host)
        func fields(_ view: NSView) -> [NSTextField] {
            (view as? NSTextField).map { [$0] } ?? view.subviews.flatMap(fields)
        }
        let matches = fields(host).filter { field in
            guard field.isEditable, !field.isHiddenOrHasHiddenAncestor, let window = field.window else { return false }
            let frame = window.convertToScreen(field.convert(field.bounds, to: nil))
            return abs(frame.midX - control.accessibilityFrame().midX) <= 2 && abs(frame.midY - control.accessibilityFrame().midY) <= 2
        }
        let field = try XCTUnwrap(matches.count == 1 ? matches.first : nil)
        let window = try XCTUnwrap(field.window)
        XCTAssertTrue(window.makeFirstResponder(field))
        field.selectText(nil)
        let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
        editor.insertText(value, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
        XCTAssertEqual(editor.string, value)
    }

    private func wait(_ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if try await condition() { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw URLError(.timedOut)
    }

    private static let models: [String: Any] = [
        "assignmentDisplays": [:], "capabilities": [], "catalog": [], "installed": [],
        "inference": ["backends": [:], "assignments": [:]],
    ]
    private static let credentials: [String: Any] = ["items": [[
        "fileKey": "fixture-key", "providerType": "http", "providerName": "Fictional provider A", "configured": true,
        "spec": ["fields": [["name": "apiKey", "label": "Fixture API key", "secret": true]]],
    ]], "pageInfo": ["hasMore": false, "limit": 100]]
    private static let modelRoutes: [String: Any] = [
        "GET /admin/models": ["body": models], "GET /admin/model-credentials": ["body": credentials],
        "POST /admin/model-credentials/fixture-key": ["body": [:]],
    ]
    private static let storage: [String: Any] = [
        "pressure": ["state": "normal"], "policy": [:], "cleanupJobs": [], "retention": [],
    ]
}

@MainActor
private final class ContextHTTPPair {
    struct Request {
        let method: String
        let path: String
        let body: [String: Any]?
    }

    let first: ScriptedAgentFixture
    let second: ScriptedAgentFixture
    let apiA: DesktopAPI
    let apiB: DesktopAPI
    private let session = URLSession(configuration: .ephemeral)
    private init(_ first: ScriptedAgentFixture, _ second: ScriptedAgentFixture) throws {
        self.first = first
        self.second = second
        apiA = try Self.api(first.url)
        apiB = try Self.api(second.url)
    }

    static func start() async throws -> ContextHTTPPair {
        let first = try await ScriptedAgentFixture.start(scriptName: "api-context-fixture.mjs")
        do {
            let second = try await ScriptedAgentFixture.start(scriptName: "api-context-fixture.mjs")
            return try ContextHTTPPair(first, second)
        } catch { first.stop()
            throw error
        }
    }

    static func api(_ url: URL) throws -> DesktopAPI {
        try DesktopAPI(connection: JSONDecoder().decode(DesktopConnection.self, from: JSONSerialization.data(withJSONObject: [
            "url": url.absoluteString, "token": "gui-fixture-token",
        ])))
    }

    func stop() {
        session.invalidateAndCancel()
        first.stop()
        second.stop()
    }

    func configureA(_ routes: [String: Any]) async throws {
        _ = try await control(first.url, "fixture-config", body: ["routes": routes])
    }

    func configureB(_ routes: [String: Any]) async throws {
        _ = try await control(second.url, "fixture-config", body: ["routes": routes])
    }

    func releaseA() async throws {
        _ = try await control(first.url, "fixture-release", body: [:])
    }

    func requestsA() async throws -> [Request] {
        try await requests(first.url)
    }

    func requestsB() async throws -> [Request] {
        try await requests(second.url)
    }

    func writesA() async throws -> [Request] {
        try await requestsA().filter { $0.method != "GET" }
    }

    func writesB() async throws -> [Request] {
        try await requestsB().filter { $0.method != "GET" }
    }

    private func requests(_ url: URL) async throws -> [Request] {
        let data = try await control(url, "fixture-context-status")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let rows = try XCTUnwrap(object["requests"] as? [[String: Any]])
        return try rows.map { try .init(
            method: XCTUnwrap($0["method"] as? String),
            path: XCTUnwrap($0["path"] as? String),
            body: $0["body"] as? [String: Any]
        ) }
    }

    private func control(_ url: URL, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        var request = URLRequest(url: url.appendingPathComponent(path))
        request.setValue("Bearer gui-fixture-token", forHTTPHeaderField: "Authorization")
        if let body { request.httpMethod = "POST"
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return data
    }
}
