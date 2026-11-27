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
    func testFilledBackupRecoveryFieldKeepsItsSeparateVisibleLabelInBothAppearances() async throws {
        @MainActor final class Draft {
            var code = ""
            var envelope: BridgeValue?
            var appearances = 0
        }
        let draft = Draft()
        let view = DesktopRestoreRecoveryInput(
            code: Binding(get: { draft.code }, set: { draft.code = $0 }),
            envelope: Binding(get: { draft.envelope }, set: { draft.envelope = $0 })
        ).padding(24)
        try await render(view, "restore-backup-persistent-code-label") { host in
            draft.appearances += 1
            let entered = "invented-backup-code-\(draft.appearances)"
            let label = try DesktopAccessibilityDriver.element("restore-backup-code-label", in: host)
            XCTAssertEqual(label.accessibilityRole(), .staticText)
            XCTAssertEqual(label.accessibilityTextValue() ?? label.accessibilityLabel(), "Backup recovery code")
            let emptyOrPreviousFrame = label.accessibilityFrame()
            try DesktopAccessibilityDriver.type(entered, into: "restore-backup-code", in: host)
            XCTAssertEqual(draft.code, entered, "The actual native editor must update the production field binding")
            let filledLabel = try DesktopAccessibilityDriver.element("restore-backup-code-label", in: host)
            let field = try DesktopAccessibilityDriver.element("restore-backup-code", in: host)
            XCTAssertFalse(filledLabel.object === field.object, "An input AX label is not a separate visible field label")
            XCTAssertEqual(filledLabel.accessibilityTextValue() ?? filledLabel.accessibilityLabel(), "Backup recovery code")
            let labelFrame = filledLabel.accessibilityFrame()
            let fieldFrame = field.accessibilityFrame()
            let window = try XCTUnwrap(host.window)
            for frame in [labelFrame, fieldFrame] {
                XCTAssertGreaterThan(frame.width, 0)
                XCTAssertGreaterThan(frame.height, 0)
                XCTAssertTrue(window.frame.contains(frame))
            }
            XCTAssertEqual(labelFrame, emptyOrPreviousFrame, "Entering a value must not remove or move the persistent label")
            XCTAssertGreaterThanOrEqual(labelFrame.minY, fieldFrame.maxY - 1)
            XCTAssertLessThanOrEqual(labelFrame.minY - fieldFrame.maxY, 24)
            XCTAssertLessThan(abs(labelFrame.minX - fieldFrame.minX), 8)
            XCTAssertNil(draft.envelope, "Typing a recovery code must not select or read a recovery file")
        }
        XCTAssertEqual(draft.appearances, 2, "Both actual Light and Dark renderer callbacks must validate the filled field")
    }

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
        var appearances = 0
        try await render(DesktopOnboardingView().environment(store), "account-terms-unavailable") { view in
            appearances += 1
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("terms could not be loaded", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.element("account-terms", in: view).isAccessibilityEnabled())
            XCTAssertFalse(try DesktopAccessibilityDriver.element("connect-account", in: view).isAccessibilityEnabled())
            let explanation = try DesktopAccessibilityDriver.element("account-terms-unavailable-explanation", in: view)
            XCTAssertEqual(
                explanation.accessibilityTextValue() ?? explanation.accessibilityLabel(),
                "The certificate authority’s terms could not be loaded. Check your internet connection and try again. Sign-in stays paused until you can read them."
            )
            let frame = explanation.accessibilityFrame()
            let window = try XCTUnwrap(view.window)
            let content = window.convertToScreen(view.convert(view.bounds, to: nil))
            let pixel = 1 / window.backingScaleFactor
            XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
            XCTAssertGreaterThan(frame.width, 300, "The explanation must use a readable column, not a narrow clipped fragment")
            XCTAssertLessThanOrEqual(frame.width, 640, "Essential setup guidance remains within the form column")
            let lineHeight = NSLayoutManager().defaultLineHeight(for: NSFont.systemFont(ofSize: 13))
            XCTAssertGreaterThanOrEqual(
                frame.height + pixel,
                2 * lineHeight,
                "The full essential explanation must visibly wrap, not ellipsize"
            )
            XCTAssertTrue(content.insetBy(dx: -pixel, dy: -pixel).contains(frame))
            let retries = try DesktopAccessibilityDriver.elements(in: view).filter {
                $0.accessibilityRole() == .button &&
                    ($0.accessibilityLabel() == "Load terms again" || $0.accessibilityTextValue() == "Load terms again")
            }
            XCTAssertEqual(retries.count, 1)
            let retry = try XCTUnwrap(retries.first)
            XCTAssertTrue(retry.isAccessibilityEnabled())
            XCTAssertTrue(content.insetBy(dx: -pixel, dy: -pixel).contains(retry.accessibilityFrame()))
            XCTAssertGreaterThanOrEqual(
                frame.minY + pixel,
                retry.accessibilityFrame().maxY,
                "Read the reason before the separate recovery action"
            )
        }
        XCTAssertEqual(appearances, 2, "Both actual Light and Dark renders must preserve the complete explanation")
    }

    func testJoinedAccountSetupDescribesTheLibraryComputerWithoutClaimingLocalMacStorage() async throws {
        let store = try store(#"{"phase":"accountRequired","mode":"joined","signup":{"policy":"invite"}}"#)
        XCTAssertEqual(store.state.mode, "joined")
        var appearances = 0
        try await render(DesktopOnboardingView().environment(store), "account-joined-library-location") { view in
            appearances += 1
            XCTAssertTrue(try DesktopAccessibilityDriver.contains(
                "Your private library stays on the computer where you keep it.", in: view
            ))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Your private library stays on your Mac", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.element("account-terms", in: view).isAccessibilityEnabled())
            XCTAssertFalse(try DesktopAccessibilityDriver.element("connect-account", in: view).isAccessibilityEnabled())
        }
        XCTAssertEqual(appearances, 2)
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

    func testWaitingStatesKeepOnePrincipalHeadingAndTheirDistinctGuidanceAndActions() async throws {
        let scenarios: [(json: String, title: String, summary: String?, detail: String, actions: [String], absent: [String])] = [
            (
                #"{"phase":"waiting"}"#,
                "Waiting to connect",
                "waiting-disconnected-summary",
                "Start Omnesis on the computer that keeps your library. If it has not been set up yet, start there first.",
                ["Look again", "Change setup choice"],
                ["Check this Mac’s library", "Review removal"]
            ),
            (
                #"{"phase":"waiting","mode":"home"}"#,
                "Starting your library",
                nil,
                "Keep Omnesis open while your library starts. If it does not connect, check again or reopen the app. Your saved library stays on this Mac.",
                ["Check this Mac’s library"],
                ["Look again", "Change setup choice", "Review removal"]
            ),
            (
                #"{"phase":"waiting","retired":true,"retirement":{"mode":"keep-data","phase":"complete"}}"#,
                "Omnesis is stopped",
                "waiting-retired-summary",
                "Your removal choice is kept. Omnesis will not start in the background.",
                ["Review removal", "Set up Omnesis again"],
                ["Look again", "Change setup choice", "Check this Mac’s library"]
            ),
        ]
        for (index, scenario) in scenarios.enumerated() {
            let store = try store(scenario.json)
            var appearances = 0
            try await render(DesktopOnboardingView().environment(store), "waiting-heading-hierarchy-\(index)") { view in
                appearances += 1
                let title = try DesktopAccessibilityDriver.element("onboarding-page-title", in: view)
                XCTAssertEqual(title.accessibilityTextValue() ?? title.accessibilityLabel(), scenario.title)
                XCTAssertTrue(try DesktopAccessibilityDriver.contains(scenario.detail, in: view))
                let window = try XCTUnwrap(view.window)
                let content = window.convertToScreen(view.convert(view.bounds, to: nil))
                let pixel = 1 / window.backingScaleFactor
                let titleFrame = title.accessibilityFrame()
                XCTAssertTrue(content.insetBy(dx: -pixel, dy: -pixel).contains(titleFrame))
                if let identifier = scenario.summary {
                    let summary = try DesktopAccessibilityDriver.element(identifier, in: view)
                    XCTAssertEqual(
                        summary.accessibilityTextValue() ?? summary.accessibilityLabel(),
                        identifier == "waiting-retired-summary" ? "Omnesis is stopped on this Mac" : "Your library is not connected yet"
                    )
                    let summaryFrame = summary.accessibilityFrame()
                    XCTAssertTrue([summaryFrame.minX, summaryFrame.minY, summaryFrame.width, summaryFrame.height].allSatisfy(\.isFinite))
                    XCTAssertGreaterThan(summaryFrame.width, 0)
                    XCTAssertGreaterThan(summaryFrame.height, 0)
                    let titleTextFrame = try self.waitingTextFrame(title, expected: scenario.title, part: .title, scenario: index, in: view)
                    let summaryText = identifier == "waiting-retired-summary" ? "Omnesis is stopped on this Mac" : "Your library is not connected yet"
                    let summaryTextFrame = try self.waitingTextFrame(
                        summary,
                        expected: summaryText,
                        part: .summary,
                        scenario: index,
                        in: view
                    )
                    XCTAssertLessThan(
                        summaryTextFrame.height,
                        titleTextFrame.height,
                        "Waiting detail text must not compete with the principal page heading text"
                    )
                    XCTAssertTrue(content.insetBy(dx: -pixel, dy: -pixel).contains(summaryFrame))
                    XCTAssertLessThanOrEqual(summaryFrame.maxY, titleFrame.minY + pixel)
                } else {
                    let identifiers = try DesktopAccessibilityDriver.elements(in: view).compactMap { $0.accessibilityIdentifier() }
                    XCTAssertFalse(identifiers.contains("waiting-disconnected-summary"))
                    XCTAssertFalse(identifiers.contains("waiting-retired-summary"))
                    XCTAssertTrue(try DesktopAccessibilityDriver.contains("Starting your library on this Mac…", in: view))
                }
                let buttons = try DesktopAccessibilityDriver.elements(in: view).filter { $0.accessibilityRole() == .button }
                for name in scenario.actions {
                    let matches = buttons.filter { ($0.accessibilityTextValue() ?? $0.accessibilityLabel()) == name }
                    XCTAssertEqual(matches.count, 1)
                    let button = try XCTUnwrap(matches.first)
                    XCTAssertTrue(button.isAccessibilityEnabled())
                    XCTAssertTrue(content.insetBy(dx: -pixel, dy: -pixel).contains(button.accessibilityFrame()))
                }
                for name in scenario.absent {
                    XCTAssertFalse(buttons.contains { ($0.accessibilityTextValue() ?? $0.accessibilityLabel()) == name })
                }
            }
            XCTAssertEqual(appearances, 2)
        }
    }

    private enum WaitingTextPart: String { case title, summary }

    /// A native Label can aggregate its icon and text; character-range geometry measures only text.
    private func waitingTextFrame(
        _ element: DesktopAccessibilityDriver.Element, expected: String, part: WaitingTextPart,
        scenario: Int, in view: NSView
    ) throws
        -> NSRect {
        let range = NSRange(location: 0, length: expected.utf16.count)
        let frame = element.object.accessibilityFrame?(for: range)
        let text = element.accessibilityTextValue() ?? element.accessibilityLabel()
        let finite = frame.map { [$0.minX, $0.minY, $0.width, $0.height].allSatisfy(\.isFinite) } ?? false
        let positive = frame.map { $0.width > 0 && $0.height > 0 } ?? false
        var facts: [String: Any] = [
            "scenario": scenario, "part": part.rawValue,
            "textSource": "owned-value-or-label",
            "rangeFramePresent": frame != nil, "exactText": text == expected,
            "finiteRangeFrame": finite, "positiveRangeFrame": positive,
            "rangeLength": range.length,
        ]
        if let frame, finite {
            facts["rangeWidth"] = frame.width
            facts["rangeHeight"] = frame.height
        }
        let appearance = view.window?.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? "Dark" : "Light"
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        if (0 ... 2).contains(scenario), let bytes = try? JSONSerialization.data(withJSONObject: facts), bytes.count <= 1024 {
            try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            try? bytes.write(
                to: output.appendingPathComponent("waiting-text-range-\(scenario)-\(part.rawValue)-\(appearance).txt"),
                options: .atomic
            )
        }
        XCTAssertEqual(text, expected, "The exact owned AX value or label must match the requested text range")
        let measured = try XCTUnwrap(frame, "The actual owned text must expose public character-range geometry")
        XCTAssertTrue(finite)
        XCTAssertTrue(positive)
        let window = try XCTUnwrap(view.window)
        let pixel = 1 / window.backingScaleFactor
        XCTAssertTrue(element.accessibilityFrame().insetBy(dx: -pixel, dy: -pixel).contains(measured))
        return measured
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
