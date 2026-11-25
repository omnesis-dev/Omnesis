// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopRenderTests: XCTestCase {
    func testVerifiedUpdateStillRequiresExplicitInstallConfirmation() async throws {
        let store = DesktopStore.preview()
        store.update = try JSONDecoder().decode(DesktopUpdatePresentation.self, from: Data(
            #"{"kind":"desktopUpdate","phase":"verified","currentVersion":"1.0.0","targetVersion":"1.1.0","message":"The installer signature was checked. Review the backup and installation before continuing.","confirmationId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#
                .utf8
        ))
        try await render(DesktopUpdatesView(loadStatus: false).environment(store), name: "update-verified-awaiting-confirmation")
    }

    func testWelcome() async throws {
        try await render(DesktopRootView().environment(DesktopStore.preview()), name: "welcome")
    }

    func testHomeChoice() async throws {
        try await render(DesktopRootView().environment(DesktopStore.preview(phase: .chooseHome)), name: "choose-home")
    }

    func testWaiting() async throws {
        try await render(DesktopRootView().environment(DesktopStore.preview(phase: .waiting)), name: "waiting")
    }

    func testPreparing() async throws {
        try await render(DesktopRootView().environment(DesktopStore.preview(phase: .preparing)), name: "preparing")
    }

    func testAccountRequired() async throws {
        try await render(
            DesktopRootView().environment(DesktopStore.preview(phase: .accountRequired)),
            name: "account-required"
        )
    }

    func testEmptySources() async throws {
        try await render(DesktopSourcesView().environment(DesktopStore.preview()), name: "sources-empty")
    }

    func testAskEmpty() async throws {
        try await render(DesktopAskView().environment(DesktopStore.preview()), name: "ask-empty")
    }

    func testSearchEmpty() async throws {
        try await render(DesktopSearchView().environment(DesktopStore.preview()), name: "search-empty")
    }

    func testDevicesEmpty() async throws {
        try await render(DesktopDevicesView().environment(DesktopStore.preview()), name: "devices-empty")
    }

    func testRemovalPreservesDataByDefault() async throws {
        try await render(DesktopRemovalView().environment(DesktopStore.preview()), name: "removal-preserve-default")
    }

    func testRemovalWithPendingKeyCleanup() async throws {
        let store = DesktopStore.preview()
        store.removalOutcome = try JSONDecoder().decode(
            DesktopRemovalOutcome.self,
            from: Data(#"{"status":"key-cleanup-pending","data":"erased","keyring":"pending"}"#.utf8)
        )
        try await render(DesktopRemovalView().environment(store), name: "removal-key-cleanup-pending")
    }

    func testRecoveryProtectionRequiresExplicitReplacement() async throws {
        let store = DesktopStore.preview()
        store.recoveryStatus = try JSONDecoder().decode(
            DesktopRecoveryStatus.self,
            from: Data(#"{"available":true,"hasEnvelope":true,"envelopeValid":true}"#.utf8)
        )
        try await render(DesktopRecoveryView(loadStatus: false).environment(store), name: "recovery-existing")
    }

    func testJoinedMacExplainsRecoveryLocation() async throws {
        let store = DesktopStore.preview()
        store.recoveryStatus = try JSONDecoder().decode(
            DesktopRecoveryStatus.self,
            from: Data(#"{"available":false,"hasEnvelope":false,"envelopeValid":false}"#.utf8)
        )
        try await render(DesktopRecoveryView(loadStatus: false).environment(store), name: "recovery-on-library-home")
    }

    func testStorageBlockedAndPartiallyCancelledCleanup() async throws {
        let snapshot = try JSONDecoder().decode(
            DesktopStorageSnapshot.self,
            from: Data(
                #"{"pressure":{"state":"blocked","usageBytes":5368709120,"measuredAt":1900000000000},"policy":{"maxBytes":10737418240},"retention":[],"cleanupJobs":[{"id":"fixture","target":"backups","state":"cancelled","removed":2,"protected":1,"hasPendingRemoval":false,"error":null}]}"#
                    .utf8
            )
        )
        try await render(
            DesktopStorageView(snapshot: snapshot).environment(DesktopStore.preview()),
            name: "storage-blocked-partial-cleanup"
        )
    }

    private func render(_ view: some View, name: String) async throws {
        try await DesktopSnapshotRenderer.render(view, name: name, size: CGSize(width: 1080, height: 740))
    }
}
