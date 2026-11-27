// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Omnesis
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopOnboardingUXTests: XCTestCase {
    func testHomeWaitingDescribesThisMacAndDoesNotOfferASecondLibraryChoice() async throws {
        let store = try store(#"{"phase":"waiting","mode":"home"}"#)
        try await render(DesktopOnboardingView().environment(store), "waiting-home") { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Starting your library on this Mac", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Open Omnesis on the Mac that keeps", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Change setup choice", in: view))
        }
    }

    func testUnpreparedWaitingOffersChangeChoiceWithoutCreatingAnInstall() async throws {
        let store = try store(#"{"phase":"waiting"}"#)
        try await render(DesktopOnboardingView().environment(store), "waiting-unprepared") { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Change setup choice", in: view))
        }
    }

    func testMissingTermsExplainsRefusalAndDisablesConsentAndSignIn() async throws {
        let store = try store(#"{"phase":"accountRequired","signup":{"policy":"invite"}}"#)
        try await render(DesktopOnboardingView().environment(store), "account-terms-unavailable") { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("terms could not be loaded", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.element("account-terms", in: view).isAccessibilityEnabled())
            XCTAssertFalse(try DesktopAccessibilityDriver.element("connect-account", in: view).isAccessibilityEnabled())
        }
    }

    func testAvailableTermsExplainDeviceConnectionAndRequireExplicitConsent() async throws {
        let store = try store(#"{"phase":"accountRequired","signup":{"policy":"open","acmeTermsUrl":"https://ca.example.com/terms"}}"#)
        try await render(DesktopOnboardingView().environment(store), "account-terms-available") { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Certificate authority terms", in: view))
            XCTAssertTrue(try DesktopAccessibilityDriver.element("account-terms", in: view).isAccessibilityEnabled())
            XCTAssertFalse(try DesktopAccessibilityDriver.element("connect-account", in: view).isAccessibilityEnabled())
        }
    }

    func testFreshAndRestoredAISettingsExplainChoicesWithoutAutomaticallyEnablingModels() async throws {
        let overview = ModelsOverview(assignmentDisplays: [:], capabilities: [
            CapabilityMeta(
                role: "agent",
                title: "Questions and answers",
                description: "The model that answers when you ask Omnesis.",
                icon: "chat"
            ),
            CapabilityMeta(role: "embedder", title: "Search", description: "Find related information in your library.", icon: "search"),
        ], inference: InferenceOverview(backends: [:], assignments: [:]), catalog: [], installed: [])
        for restored in [false, true] {
            let store = DesktopStore(startRuntime: false)
            let connection = try JSONDecoder().decode(DesktopConnection.self, from: Data(
                #"{"url":"https://gateway.example.com","token":"fixture-only"}"#.utf8
            ))
            store.api = try DesktopAPI(connection: connection)
            store.reviewModelsAfterRestore = restored
            try await render(
                DesktopModelsView(initialOverview: overview, loadModels: false, context: store.apiContext).environment(store),
                restored ? "models-restored" : "models-fresh"
            ) { view in
                XCTAssertTrue(try DesktopAccessibilityDriver.contains("Choose how Omnesis answers", in: view))
                XCTAssertTrue(try DesktopAccessibilityDriver.contains("usage charges", in: view))
                XCTAssertEqual(try DesktopAccessibilityDriver.contains("After restoring", in: view), restored)
                XCTAssertEqual(
                    try DesktopAccessibilityDriver.contains("Choose which models to use", in: view),
                    restored,
                    "A fresh setup with no usable models should lead with connecting one, not an empty model picker"
                )
            }
        }
    }

    func testChatGPTInstructionsUseCurrentPluginLabelsAndKeepOtherAssistantsSeparate() async throws {
        let url = try XCTUnwrap(URL(string: "https://library.example.com/mcp"))
        try await render(ScrollView { DesktopChatGPTInstructions(mcpURL: url).padding(24) }, "assistant-chatgpt-setup") { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Add custom MCP server", in: view))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Create as a plugin", in: view))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Other assistants", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("developer mode", in: view))
        }
        try await render(DesktopChatGPTFinishInstructions().padding(24), "assistant-chatgpt-install") { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("@Omnesis", in: view))
        }
    }

    func testErrorGuidanceDoesNotPromiseProtectionOrAnAppRestartRepair() async throws {
        let messages: [String?] = [
            "Omnesis could not finish checking your connection. Try again to check its status.",
            "Omnesis could not finish this step. Try again to check the current status.",
            nil,
        ]
        for (index, message) in messages.enumerated() {
            let state = DesktopState(phase: .error, message: message)
            let store = DesktopStore(startRuntime: false)
            store.state = state
            XCTAssertFalse(state.canOpenLibrary)
            XCTAssertNil(state.connection)
            XCTAssertNil(state.encrypted)
            try await render(DesktopOnboardingView().environment(store), "connection-error-guidance-\(index)") { view in
                if let message {
                    XCTAssertTrue(try DesktopAccessibilityDriver.contains(message, in: view))
                    XCTAssertTrue(try DesktopAccessibilityDriver.contains("Review the message below before trying again.", in: view))
                } else {
                    XCTAssertTrue(try DesktopAccessibilityDriver.contains(
                        "Omnesis could not finish this step. Try again to check the current status.", in: view
                    ))
                    XCTAssertFalse(try DesktopAccessibilityDriver.contains("Review the message below", in: view))
                }
                let retries = try DesktopAccessibilityDriver.elements(in: view).filter {
                    $0.accessibilityRole() == .button &&
                        ($0.accessibilityLabel() == "Try again" || $0.accessibilityTextValue() == "Try again")
                }
                XCTAssertEqual(retries.count, 1)
                let retry = try XCTUnwrap(retries.first)
                XCTAssertTrue(retry.isAccessibilityEnabled())
                XCTAssertGreaterThan(retry.accessibilityFrame().width, 0)
                XCTAssertGreaterThan(retry.accessibilityFrame().height, 0)
                XCTAssertTrue(try XCTUnwrap(view.window).frame.contains(retry.accessibilityFrame()))
                XCTAssertFalse(try DesktopAccessibilityDriver.contains("Your information is kept safe", in: view))
                XCTAssertFalse(try DesktopAccessibilityDriver.contains("reopen the app", in: view))
                XCTAssertFalse(try DesktopAccessibilityDriver.contains("Unlock your Mac", in: view))
            }
        }
    }

    private func store(_ json: String) throws -> DesktopStore {
        let result = DesktopStore(startRuntime: false)
        result.state = try JSONDecoder().decode(DesktopState.self, from: Data(json.utf8))
        return result
    }

    private func render(_ view: some View, _ name: String, validate: @escaping (NSView) throws -> Void) async throws {
        try await DesktopSnapshotRenderer.render(view, name: name, size: CGSize(width: 900, height: 820), validate: validate)
    }
}
