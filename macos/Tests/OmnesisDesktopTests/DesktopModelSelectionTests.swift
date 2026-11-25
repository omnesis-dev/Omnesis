// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Omnesis
@testable import OmnesisDesktop
import XCTest

final class DesktopModelSelectionTests: XCTestCase {
    func testOnlyAdvertisedRoleCapableModelsAppearAndUnsupportedSubscriptionsStayHidden() throws {
        let overview = ModelsOverview(assignmentDisplays: [:], capabilities: [], inference: InferenceOverview(
            backends: [
                "saved-api": BackendStatus(
                    type: "http",
                    status: "ok",
                    url: "https://model.example.com",
                    models: ["chat", "embed"],
                    modelRoles: ["chat": ["agent"], "embed": ["embedder"]]
                ),
                "unprobed": BackendStatus(type: "http", status: "probing", models: ["chat"], modelRoles: ["chat": ["agent"]]),
                "unsupported-subscription": BackendStatus(
                    type: "claude-code",
                    status: "unavailable",
                    models: ["do-not-offer"],
                    modelRoles: ["do-not-offer": ["agent"]]
                ),
            ],
            codex: CodexBackendStatus(
                configured: true,
                status: "unavailable",
                loggedIn: true,
                runtime: CodexRuntimeStatus(supported: false),
                models: ["do-not-offer"],
                modelRoles: ["do-not-offer": ["agent"]]
            ),
            assignments: [:]
        ), catalog: [], installed: [])
        let chat = DesktopModelSelection.choices(for: "agent", overview: overview)
        XCTAssertEqual(chat.map(\.id), ["saved-api/chat"])
        XCTAssertFalse(try XCTUnwrap(chat.first).onHost)
        XCTAssertEqual(DesktopModelSelection.choices(for: "embedder", overview: overview).map(\.id), ["saved-api/embed"])
    }

    func testOnlyActuallyInstalledLocalCatalogModelsCanBeReenabledWithoutDownloadingAnything() throws {
        let overview = ModelsOverview(
            assignmentDisplays: [:],
            capabilities: [],
            inference: InferenceOverview(backends: [:], assignments: [:]),
            catalog: [
                CatalogEntry(kind: "gguf", id: "installed-search", name: "Installed search model", roles: ["embed"]),
                CatalogEntry(kind: "gguf", id: "not-installed", name: "Not downloaded", roles: ["embed"]),
            ],
            installed: [ManifestEntry(id: "installed-search")]
        )
        let choices = DesktopModelSelection.choices(for: "embedder", overview: overview)
        XCTAssertEqual(choices.map(\.id), ["local/installed-search"])
        let choice = try XCTUnwrap(choices.first)
        XCTAssertTrue(choice.onHost)
        XCTAssertEqual(choice.apply, .activate("installed-search", "embed"))
    }
}
