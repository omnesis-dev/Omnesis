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

    func testControlTimeoutEndsAnActualHeldRequestAndKeepsItsSessionUsable() async throws {
        let pair = try await ContextHTTPPair.start()
        defer { pair.stop() }
        try await pair.configureA([
            "GET /fixture-owned-held-response": ["hold": true, "body": ["released": true]],
        ])
        let began = ContinuousClock.now
        do {
            try await pair.heldControlA()
            XCTFail("The actual held control response must time out")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .timedOut)
        }
        XCTAssertLessThan(began.duration(to: .now), .seconds(5), "Control transport must finish within the fixture polling bound")
        let requests = try await pair.requestsA()
        XCTAssertEqual(requests.filter { $0.method == "GET" && $0.path == "/fixture-owned-held-response" }.count, 1)
        // The timed-out task is complete. Release the server's owned hold and prove
        // the same control session still handles subsequent real requests.
        try await pair.releaseA()
        let afterRelease = try await pair.requestsA()
        XCTAssertEqual(afterRelease.count, requests.count)
        try await assertNoWrites(pair)
    }

    func testOffMacModelConfirmationCannotAuthorizeReplacementContext() async throws {
        recordContextStage(.offMacEntered)
        recordContextStage(.fixturesStarting)
        let pair = try await ContextHTTPPair.start()
        recordContextStage(.fixturesReady)
        defer {
            recordContextStage(.fixtureCleanupStarting)
            pair.stop()
            recordContextStage(.fixtureCleanupReturned)
        }
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
        recordContextStage(.configurationStarting)
        try await pair.configureA(routes)
        try await pair.configureB([:])
        recordContextStage(.configurationReturned)
        recordContextStage(.modelReadStarting)
        let decoded = try await pair.apiA.admin.modelOverview()
        recordContextStage(.modelReadReturned)
        let decodedChoices = DesktopModelSelection.choices(for: "agent", overview: decoded)
        XCTAssertEqual(decodedChoices.map(\.id), ["remote/fictional-chat"], "The actual client must decode the off-host fixture choice")
        XCTAssertEqual(decodedChoices.map(\.title), ["remote · fictional-chat"])
        XCTAssertEqual(decodedChoices.map(\.onHost), [false], "This selection must require the real off-host consent")
        let store = DesktopStore(startRuntime: false)
        store.api = pair.apiA
        recordContextStage(.mountStarting)
        let mounted = mount(.models, store: store)
        recordContextStage(.mountReturned)
        defer {
            recordContextStage(.windowCleanupStarting)
            mounted.window.close()
            recordContextStage(.windowCleanupReturned)
        }
        recordContextStage(.materializeStarting)
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        recordContextStage(.materializeReturned)
        try await wait { (try? DesktopAccessibilityDriver.element("model-role-picker-agent", in: mounted.host)) != nil }
        func popups(_ view: NSView) -> [NSPopUpButton] {
            (view as? NSPopUpButton).map { [$0] } ?? view.subviews.flatMap(popups)
        }
        var stage = "identified-role-cell"
        var tracking: DesktopOwnedPopupTracking?
        do {
            let identified = try DesktopAccessibilityDriver.element("model-role-picker-agent", in: mounted.host)
            let cell = try XCTUnwrap(identified.object as? NSCell, "The identified role must expose its actual native cell")
            let picker = try XCTUnwrap(cell.controlView as? NSPopUpButton, "The identified cell must belong to its real popup")
            guard picker.window === mounted.window, picker.isDescendant(of: mounted.host), picker.cell === cell else {
                throw DesktopAccessibilityDriver.Failure("The role popup must belong to the exact mounted window and cell")
            }
            let menu = try XCTUnwrap(picker.menu, "The exact popup must expose its actual menu")
            let selection = DesktopOwnedPopupTracking(
                picker: picker,
                cell: cell,
                menu: menu,
                root: mounted.host,
                window: mounted.window,
                title: "remote · fictional-chat"
            )
            tracking = selection
            stage = "native-menu-tracking"
            recordContextStage(.popupSelectionStarting)
            try await selection.select()
            recordContextStage(.popupSelectionReturned)
            stage = "visible-role-selection"
            try await wait {
                guard let role = try? DesktopAccessibilityDriver.element("model-role-picker-agent", in: mounted.host),
                      let save = try? DesktopAccessibilityDriver.element("model-role-save-agent", in: mounted.host) else { return false }
                return role.accessibilityTextValue() == "remote · fictional-chat" && save.isAccessibilityEnabled()
            }
            XCTAssertEqual(
                try DesktopAccessibilityDriver.element("model-role-picker-agent", in: mounted.host).accessibilityTextValue(),
                "remote · fictional-chat"
            )
            stage = "real-save-control"
            recordContextStage(.savePressStarting)
            try DesktopAccessibilityDriver.press("model-role-save-agent", in: mounted.host)
            recordContextStage(.savePressReturned)
            stage = "real-consent-control"
            recordContextStage(.consentWaiting)
            try await wait { (try? self.control("model-role-confirm-agent", mounted: mounted)) != nil }
            let oldConfirmation = try control("model-role-confirm-agent", mounted: mounted)
            recordContextStage(.consentObserved)
            recordContextStage(.contextReplacementStarting)
            store.api = pair.apiB
            recordContextStage(.contextReplacementReturned)
            await Task.yield()
            stage = "retired-consent-control"
            recordContextStage(.retiredConsentPressStarting)
            _ = oldConfirmation.accessibilityPerformPress()
            recordContextStage(.retiredConsentPressReturned)
            recordContextStage(.writeCheckStarting)
            try await assertNoWrites(pair)
            recordContextStage(.writeCheckReturned)
        } catch {
            try writeRolePickerDiagnostics(
                mounted.host,
                nativePopups: popups(mounted.host),
                stage: stage,
                tracking: tracking?.facts ?? [:]
            )
            throw error
        }
    }

    func testCurrentOffMacModelConsentSavesOnlyItsReviewedApiAndShowsFreshSelectedRole() async throws {
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
        routes["PATCH /admin/config"] = ["hold": true, "body": [:]]
        try await pair.configureA(routes)
        try await pair.configureB([:])
        let decoded = try await pair.apiA.admin.modelOverview()
        XCTAssertEqual(DesktopModelSelection.choices(for: "agent", overview: decoded).map(\.id), ["remote/fictional-chat"])
        let store = DesktopStore(startRuntime: false)
        store.api = pair.apiA
        let mounted = mount(.models, store: store)
        defer { mounted.window.close() }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try await wait { (try? DesktopAccessibilityDriver.element("model-role-picker-agent", in: mounted.host)) != nil }
        var stage = "current-role-cell"
        var tracking: DesktopOwnedPopupTracking?
        do {
            let role = try DesktopAccessibilityDriver.element("model-role-picker-agent", in: mounted.host)
            let cell = try XCTUnwrap(role.object as? NSCell)
            let popup = try XCTUnwrap(cell.controlView as? NSPopUpButton)
            let menu = try XCTUnwrap(popup.menu)
            let selection = DesktopOwnedPopupTracking(
                picker: popup,
                cell: cell,
                menu: menu,
                root: mounted.host,
                window: mounted.window,
                title: "remote · fictional-chat"
            )
            tracking = selection
            stage = "current-public-popup-selection"
            try await selection.select()
            try await wait {
                guard let selected = try? DesktopAccessibilityDriver.element("model-role-picker-agent", in: mounted.host),
                      let save = try? DesktopAccessibilityDriver.element("model-role-save-agent", in: mounted.host) else { return false }
                return selected.accessibilityTextValue() == "remote · fictional-chat" && save.isAccessibilityEnabled()
            }
            stage = "current-real-save"
            try DesktopAccessibilityDriver.press("model-role-save-agent", in: mounted.host)
            try await wait { (try? self.control("model-role-confirm-agent", mounted: mounted)) != nil }
            try await assertNoWrites(pair)
            XCTAssertTrue(store.api === pair.apiA)
            XCTAssertTrue(store.apiContext?.isCurrent == true)
            stage = "current-real-consent"
            let consent = try control("model-role-confirm-agent", mounted: mounted)
            XCTAssertTrue(consent.isAccessibilityEnabled())
            XCTAssertTrue(consent.accessibilityPerformPress())
            try await wait { try await pair.writesA().count == 1 }
            let heldWrites = try await pair.writesA()
            let policy = try XCTUnwrap(heldWrites.first)
            XCTAssertEqual(policy.method, "PATCH")
            XCTAssertEqual(policy.path, "/admin/config")
            XCTAssertEqual((policy.body?["inference"] as? [String: Any])?["allowRemoteInference"] as? Bool, true)
            XCTAssertFalse(
                try DesktopAccessibilityDriver.contains("Selected: Fictional remote · fictional-chat", in: mounted.host),
                "An unacknowledged policy write cannot show the role as selected"
            )
            var selectedOverview = overview
            selectedOverview["assignmentDisplays"] = ["agent": [
                "providerId": "remote", "providerLabel": "Fictional remote", "modelName": "fictional-chat",
                "available": true, "configured": true,
            ]]
            var inference = try XCTUnwrap(overview["inference"] as? [String: Any])
            inference["allowRemoteInference"] = true
            inference["assignments"] = ["agent": [
                "kind": "http",
                "available": true,
                "model": "fictional-chat",
                "backendKey": "remote",
                "onHost": false,
            ]]
            selectedOverview["inference"] = inference
            routes["GET /admin/models"] = ["body": selectedOverview]
            routes["PATCH /admin/config"] = ["body": [:]]
            try await pair.configureA(routes)
            stage = "current-write-acknowledgement"
            try await pair.releaseA()
            try await wait {
                guard try await pair.writesA().count == 2 else { return false }
                return try DesktopAccessibilityDriver.contains("Selected: Fictional remote · fictional-chat", in: mounted.host)
                    && DesktopAccessibilityDriver.contains("Selection saved. Current availability is shown above.", in: mounted.host)
            }
            let writes = try await pair.writesA()
            XCTAssertEqual(writes.map(\.method), ["PATCH", "PATCH"])
            XCTAssertEqual(writes.map(\.path), ["/admin/config", "/admin/config"])
            let assignment = try XCTUnwrap(writes.last?.body?["inference"] as? [String: Any])
            XCTAssertEqual(assignment["assignments"] as? [String: String], ["agent": "remote/fictional-chat"])
            let replacementWrites = try await pair.writesB()
            XCTAssertTrue(replacementWrites.isEmpty)
            let requests = try await pair.requestsA()
            let lastWrite = try XCTUnwrap(requests.lastIndex { $0.method == "PATCH" && $0.path == "/admin/config" })
            XCTAssertTrue(
                requests.indices.contains { $0 > lastWrite && requests[$0].method == "GET" && requests[$0].path == "/admin/models" },
                "The rendered selected role must come from a fresh read after the actual writes"
            )
        } catch {
            try writeRolePickerDiagnostics(
                mounted.host,
                nativePopups: Self.nativePopups(mounted.host),
                stage: stage,
                tracking: tracking?.facts ?? [:],
                name: "api-context-current-off-host-picker"
            )
            throw error
        }
    }

    private static func nativePopups(_ root: NSView) -> [NSPopUpButton] {
        (root as? NSPopUpButton).map { [$0] } ?? root.subviews.flatMap(nativePopups)
    }

    private func writeRolePickerDiagnostics(
        _ root: NSView,
        nativePopups: [NSPopUpButton],
        stage: String,
        tracking: [String: Any],
        name: String = "api-context-off-host-picker"
    ) throws {
        let picker = try DesktopAccessibilityDriver.elements(in: root).first { $0.accessibilityIdentifier() == "model-role-picker-agent" }
        var pending: [AnyObject] = picker.map { [$0.object] } ?? []
        var seen: Set<ObjectIdentifier> = [], nodes: [[String: Any]] = []
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
        let identifiedCell = picker?.object as? NSCell
        let facts: [String: Any] = [
            "stage": stage, "decodedChoice": "remote/fictional-chat", "tracking": tracking,
            "rolePickerPresent": picker != nil, "rolePickerNodes": nodes, "subtreeBoundReached": !pending.isEmpty,
            "nativePopups": nativePopups.prefix(32).map { popup in
                [
                    "type": String(reflecting: Swift.type(of: popup)),
                    "exactWindow": popup.window === root.window, "descendantOfMountedRoot": popup.isDescendant(of: root),
                    "matchesIdentifiedCell": identifiedCell.map { popup.cell === $0 } ?? false,
                    "menuPresent": popup.menu != nil,
                    "delegateType": popup.menu?.delegate.map { String(reflecting: Swift.type(of: $0)) } ?? "none",
                    "items": popup.itemTitles.prefix(64).map { String($0.prefix(240)) },
                ] as [String: Any]
            },
        ]
        let directory = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent(name + ".txt")
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
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3
        configuration.timeoutIntervalForResource = 3
        return URLSession(configuration: configuration)
    }()

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

    func heldControlA() async throws {
        _ = try await control(first.url, "fixture-owned-held-response")
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
        request.timeoutInterval = 3
        request.setValue("Bearer gui-fixture-token", forHTTPHeaderField: "Authorization")
        if let body { request.httpMethod = "POST"
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return data
    }
}

/// Runs only the exact mounted popup's ordinary AppKit tracking and item action.
@MainActor
private final class DesktopOwnedPopupTracking {
    private let picker: NSPopUpButton
    private let cell: NSCell
    private let menu: NSMenu
    private let root: NSView
    private let window: NSWindow
    private let title: String
    private var acceptingCallbacks = false
    private var began = false
    private var ended = false
    private var performedAction = false
    private var deadlineExpired = false
    private var refusal: String?
    private var stage = "not-started"
    private var choices: [String] = []
    private var namedPressSupported = false
    private var directPressSupported = false
    private var pressAccepted = false
    private var pressDispatch = "none"

    init(picker: NSPopUpButton, cell: NSCell, menu: NSMenu, root: NSView, window: NSWindow, title: String) {
        self.picker = picker
        self.cell = cell
        self.menu = menu
        self.root = root
        self.window = window
        self.title = title
    }

    private var owned: Bool {
        picker.window === window && picker.isDescendant(of: root) && window.contentView === root
            && picker.cell === cell && cell.controlView === picker && picker.menu === menu && window.isVisible
    }

    var facts: [String: Any] {
        [
            "stage": stage,
            "ownershipCurrent": owned,
            "began": began,
            "ended": ended,
            "controlEnabled": picker.isEnabled,
            "controlActionPresent": picker.action != nil,
            "namedPressSupported": namedPressSupported, "directPressSupported": directPressSupported,
            "pressAccepted": pressAccepted, "pressDispatch": pressDispatch,
            "nativeItemCount": menu.items.count,
            "selectedNativeTitle": String((picker.titleOfSelectedItem ?? "").prefix(240)),
            "nativeCellValue": String(cell.stringValue.prefix(240)),
            "performedItemAction": performedAction,
            "deadlineExpired": deadlineExpired,
            "refusal": refusal ?? "none",
            "choices": choices,
        ]
    }

    func select() async throws {
        guard owned, picker.isEnabled else {
            throw DesktopAccessibilityDriver.Failure("The exact owned popup must be enabled")
        }
        let object = cell as AnyObject
        namedPressSupported = (object.accessibilityActionNames?() ?? []).contains(.press)
            && object.accessibilityPerformAction != nil
        directPressSupported = object.accessibilityPerformPress != nil
        guard namedPressSupported || directPressSupported else {
            throw DesktopAccessibilityDriver.Failure("The exact observed popup cell must expose a public press action")
        }
        pressDispatch = namedPressSupported ? "named-public-press" : "public-press-selector"
        let deadline = ContinuousClock.now + .seconds(5)
        acceptingCallbacks = true
        let center = NotificationCenter.default
        let begin = center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: menu, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.trackingBegan() }
        }
        let end = center.addObserver(forName: NSMenu.didEndTrackingNotification, object: menu, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.acceptingCallbacks == true { self?.ended = true } }
        }
        let timer = Timer(timeInterval: 5, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.acceptingCallbacks else { return }
                self.deadlineExpired = true
                self.stage = "tracking-deadline"
                recordContextStage(.popupDeadline)
                self.menu.cancelTracking()
            }
        }
        RunLoop.main.add(timer, forMode: .default)
        RunLoop.main.add(timer, forMode: .eventTracking)
        defer {
            recordContextStage(.popupCleanupStarting)
            acceptingCallbacks = false
            timer.invalidate()
            center.removeObserver(begin)
            center.removeObserver(end)
            menu.cancelTracking()
            recordContextStage(.popupCleanupReturned)
        }
        stage = "dispatching-owned-public-press"
        recordContextStage(.popupPressStarting)
        pressAccepted = DesktopAccessibilityDriver.Element(object: object).accessibilityPerformPress()
        recordContextStage(.popupPressReturned)
        guard pressAccepted else {
            throw DesktopAccessibilityDriver.Failure("The exact popup's public press action was refused")
        }
        while !(began && performedAction && ended), !deadlineExpired, refusal == nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(25))
        }
        try Task.checkCancellation()
        guard began, performedAction, ended, !deadlineExpired, refusal == nil else {
            throw DesktopAccessibilityDriver.Failure("The real owned popup tracking did not complete its expected item action")
        }
        stage = "owned-tracking-completed"
    }

    private func trackingBegan() {
        guard acceptingCallbacks, !began else { return }
        began = true
        stage = "tracking-began"
        recordContextStage(.popupTrackingBegan)
        RunLoop.main.perform(inModes: [.eventTracking]) { [weak self] in
            MainActor.assumeIsolated { self?.selectActualItem() }
        }
    }

    private func selectActualItem() {
        guard acceptingCallbacks, !performedAction, !ended, !deadlineExpired else { return }
        guard owned, menu.items.count <= 64 else { refuse("ownership-or-item-bound")
            return
        }
        choices = menu.items.map { String($0.title.prefix(240)) }
        let matches = menu.items.enumerated().filter { _, item in
            item.title == title && item.isEnabled && !item.isHidden && item.menu === menu
        }
        guard matches.count == 1, let (index, item) = matches.first,
              item.action != nil, item.target != nil else { refuse("unique-enabled-real-action-missing")
            return
        }
        performedAction = true
        stage = "sending-real-item-action"
        recordContextStage(.popupItemStarting)
        menu.performActionForItem(at: index)
        recordContextStage(.popupItemReturned)
        stage = "real-item-action-returned"
        menu.cancelTracking()
    }

    private func refuse(_ reason: String) {
        refusal = reason
        stage = "tracking-refused"
        menu.cancelTracking()
    }
}

/// Fixed stage names only; emit before synchronous AppKit calls rather than
/// depending on a catch handler or an accessibility traversal after a blockage.
private enum DesktopContextStage: String {
    case offMacEntered = "off-mac-entered"
    case fixturesStarting = "fixtures-starting", fixturesReady = "fixtures-ready"
    case configurationStarting = "configuration-starting", configurationReturned = "configuration-returned"
    case modelReadStarting = "model-read-starting", modelReadReturned = "model-read-returned"
    case mountStarting = "mount-starting", mountReturned = "mount-returned"
    case materializeStarting = "materialize-starting", materializeReturned = "materialize-returned"
    case popupSelectionStarting = "popup-selection-starting", popupSelectionReturned = "popup-selection-returned"
    case popupPressStarting = "popup-press-starting", popupPressReturned = "popup-press-returned"
    case popupTrackingBegan = "popup-tracking-began", popupDeadline = "popup-deadline"
    case popupItemStarting = "popup-item-starting", popupItemReturned = "popup-item-returned"
    case popupCleanupStarting = "popup-cleanup-starting", popupCleanupReturned = "popup-cleanup-returned"
    case savePressStarting = "save-press-starting", savePressReturned = "save-press-returned"
    case consentWaiting = "consent-waiting", consentObserved = "consent-observed"
    case contextReplacementStarting = "context-replacement-starting", contextReplacementReturned = "context-replacement-returned"
    case retiredConsentPressStarting = "retired-consent-press-starting", retiredConsentPressReturned = "retired-consent-press-returned"
    case writeCheckStarting = "write-check-starting", writeCheckReturned = "write-check-returned"
    case windowCleanupStarting = "window-cleanup-starting", windowCleanupReturned = "window-cleanup-returned"
    case fixtureCleanupStarting = "fixture-cleanup-starting", fixtureCleanupReturned = "fixture-cleanup-returned"
}

private func recordContextStage(_ stage: DesktopContextStage) {
    FileHandle.standardError.write(Data("desktop-context-stage:\(stage.rawValue)\n".utf8))
}
