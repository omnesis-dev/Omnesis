// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
@testable import OmnesisDesktop
import XCTest

@MainActor
final class RuntimeInteractionIdentityTests: XCTestCase {
    private func promptEnvelope(_ id: String, kind: String) throws -> BridgeEnvelope {
        var prompt: [String: Any] = [
            "id": id, "kind": kind, "code": "123456",
            "choices": [["id": "fixture-choice", "name": "Invented library"]],
        ]
        if kind == "openBrowser" { prompt["url"] = "javascript:invented-fixture" }
        return try JSONDecoder().decode(BridgeEnvelope.self, from: JSONSerialization.data(withJSONObject: [
            "version": 1, "event": "interaction", "interaction": prompt,
        ]))
    }

    func testRenderedResponsesCannotClearOrAnswerAReplacementOrAbsentPrompt() throws {
        for (kind, value) in [("compareCode", "approve"), ("chooseGateway", "fixture-choice"), ("openBrowser", "continue")] {
            for replacement in [false, true] {
                let bridge = RuntimeBridge()
                let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, monitorPrerequisites: false)
                try bridge.onEnvelope?(promptEnvelope("11111111-1111-4111-8111-111111111111", kind: kind))
                let rendered = try XCTUnwrap(store.interaction)
                let delayedAction = { store.respond(value, interactionID: rendered.id) }
                if replacement {
                    try bridge.onEnvelope?(promptEnvelope("22222222-2222-4222-8222-222222222222", kind: kind))
                } else { store.interaction = nil }
                let current = store.interaction, state = store.state
                store.failure = "Existing fixture diagnostic"
                delayedAction()
                XCTAssertEqual(store.interaction, current)
                XCTAssertEqual(store.state, state)
                XCTAssertEqual(store.failure, "Existing fixture diagnostic")
                XCTAssertFalse(store.busy)
            }
        }
    }

    func testMatchingRenderedResponsesKeepExistingClearingWithoutClaimingTransportAcceptance() throws {
        for (kind, value) in [("compareCode", "approve"), ("chooseGateway", "fixture-choice"), ("openBrowser", "continue")] {
            let bridge = RuntimeBridge()
            let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, monitorPrerequisites: false)
            try bridge.onEnvelope?(promptEnvelope("22222222-2222-4222-8222-222222222222", kind: kind))
            let current = try XCTUnwrap(store.interaction), state = store.state
            store.respond(value, interactionID: current.id)
            XCTAssertNil(store.interaction)
            XCTAssertEqual(store.state, state)
            XCTAssertEqual(store.failure, BridgeLaunchError.notRunning.localizedDescription)
            XCTAssertFalse(store.busy)
        }
    }

    func testRenderedCancellationCannotClearAReplacementOrAbsentPrompt() throws {
        for replacement in [false, true] {
            let bridge = RuntimeBridge()
            let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, monitorPrerequisites: false)
            try bridge.onEnvelope?(promptEnvelope("11111111-1111-4111-8111-111111111111", kind: "compareCode"))
            let rendered = try XCTUnwrap(store.interaction)
            let delayedAction = { store.cancelInteraction(rendered.id) }
            if replacement {
                try bridge.onEnvelope?(promptEnvelope("22222222-2222-4222-8222-222222222222", kind: "compareCode"))
            } else { store.interaction = nil }
            let current = store.interaction, state = store.state
            store.failure = "Existing fixture diagnostic"
            delayedAction()
            XCTAssertEqual(store.interaction, current)
            XCTAssertEqual(store.state, state)
            XCTAssertEqual(store.failure, "Existing fixture diagnostic")
            XCTAssertFalse(store.busy)
        }
    }

    func testMatchingRenderedCancellationKeepsExistingClearingWithoutTransportAcceptance() throws {
        let bridge = RuntimeBridge()
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, monitorPrerequisites: false)
        try bridge.onEnvelope?(promptEnvelope("22222222-2222-4222-8222-222222222222", kind: "compareCode"))
        let current = try XCTUnwrap(store.interaction), state = store.state
        store.cancelInteraction(current.id)
        XCTAssertNil(store.interaction)
        XCTAssertEqual(store.state, state)
        XCTAssertEqual(store.failure, BridgeLaunchError.notRunning.localizedDescription)
        XCTAssertFalse(store.busy)
    }

    func testRenderedBrowserActionRefusesReplacementOrAbsentPromptBeforeExistingURLValidation() throws {
        // An invalid scheme exercises the original validation branch without opening any browser.
        for replacement in [false, true] {
            let bridge = RuntimeBridge()
            let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, monitorPrerequisites: false)
            try bridge.onEnvelope?(promptEnvelope("11111111-1111-4111-8111-111111111111", kind: "openBrowser"))
            let rendered = try XCTUnwrap(store.interaction)
            let invalidURL = try XCTUnwrap(rendered.url)
            let delayedAction = { store.openInteractionBrowser(invalidURL, interactionID: rendered.id) }
            if replacement {
                try bridge.onEnvelope?(promptEnvelope("22222222-2222-4222-8222-222222222222", kind: "openBrowser"))
            } else { store.interaction = nil }
            let current = store.interaction, state = store.state
            store.failure = "Existing fixture diagnostic"
            delayedAction()
            XCTAssertEqual(store.interaction, current)
            XCTAssertEqual(store.state, state)
            XCTAssertEqual(store.failure, "Existing fixture diagnostic")
            XCTAssertFalse(store.busy)
            if let current {
                store.openInteractionBrowser(invalidURL, interactionID: current.id)
                XCTAssertEqual(store.interaction, current)
                XCTAssertEqual(store.failure, "Omnesis received an invalid sign-in link. Try starting sign-in again.")
            }
        }
    }
}
