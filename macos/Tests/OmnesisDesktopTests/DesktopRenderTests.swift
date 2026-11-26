// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopRenderTests: XCTestCase {
    func testSettingsPrerequisiteOrderKeepsUnknownBeforeHealthyChecks() {
        let entryOrder = DesktopSettingsView.orderedPrerequisites(startupReady: true, powerReady: true, servicesReady: false, home: true)
        XCTAssertEqual(entryOrder, [.services, .startup, .power])
        XCTAssertEqual(
            DesktopSettingsView.orderedPrerequisites(startupReady: true, powerReady: false, servicesReady: false, home: true),
            [.power, .services, .startup]
        )
        XCTAssertEqual(
            DesktopSettingsView.orderedPrerequisites(startupReady: false, powerReady: false, servicesReady: false, home: false),
            [.startup]
        )
    }

    func testSettingsStorageRepairPrecedesCompletedPrerequisites() async throws {
        let power = DesktopMacServerPowerFlow(probe: { DesktopMacServerPowerObservation(status: .ready) })
        let startup = DesktopAutomaticStartup(read: { .enabled }, register: {})
        let store = DesktopStore(startRuntime: false, automaticStartup: startup, serverPower: power, nativeOwnerVerified: true)
        let expiry = floor(Date().timeIntervalSince1970 * 1000) + 60000
        store.state = try DesktopState(
            phase: .ready,
            mode: "home",
            connection: JSONDecoder().decode(
                DesktopConnection.self,
                from: Data(#"{"url":"https://gateway.example.com","token":"fixture-only"}"#.utf8)
            ),
            encrypted: true,
            installationId: "desktop-0000000000000001",
            storageAdmission: .init(state: "blocked", validUntil: expiry),
            remoteRoute: .init(state: "ready", validUntil: expiry)
        )
        store.homeServices.receive(store.state)
        startup.refresh()
        await power.refresh()
        try await DesktopSnapshotRenderer.render(
            DesktopSettingsView().environment(store),
            name: "settings-storage-required-first",
            size: CGSize(width: 720, height: 640)
        ) { hosting in
            let repairElement = try DesktopAccessibilityDriver.element("setup-review-storage", in: hosting)
            let repair = repairElement.accessibilityFrame()
            XCTAssertEqual(repairElement.accessibilityLabel(), "Review storage")
            XCTAssertGreaterThan(repair.width, 0)
            XCTAssertGreaterThan(repair.height, 0)
            let header = try DesktopAccessibilityDriver.element("settings-prerequisite-services", in: hosting)
            XCTAssertNotEqual(header.accessibilityIdentifier(), repairElement.accessibilityIdentifier())
            XCTAssertEqual(header.accessibilityLabel(), "Library storage and connection · Required")
            let startupHeader = try DesktopAccessibilityDriver.element("settings-prerequisite-startup", in: hosting)
            XCTAssertEqual(startupHeader.accessibilityLabel(), "Launch at sign-in · Required")
            let startupSection = startupHeader.accessibilityFrame()
            XCTAssertGreaterThan(repair.minY, startupSection.maxY, "The incomplete storage repair must precede healthy startup")
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Automatic sleep is off while plugged in", in: hosting))
        }
    }

    func testOrdinaryMinimumLibraryWindowKeepsNativeControlsAndRequiredActionsOnScreen() async throws {
        let store = try await minimumWindowStore()
        store.sources = try JSONDecoder().decode([DesktopSource].self, from: Data(
            #"[{"id":"example:notes","type":"Example notes","accountId":"Example notebook","enabled":true,"deviceId":"fixture-device"}]"#
                .utf8
        ))
        store.destination = .sources
        try await DesktopSnapshotRenderer.renderVisibleWindow(
            DesktopRootView().environment(store).frame(minWidth: 860, minHeight: 600),
            name: "minimum-library", size: CGSize(width: 860, height: 600)
        ) { hosting in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Example notebook", in: hosting))
            try writeMinimumToolbarFacts(hosting)
            // Toolbar text can be combined into its button leaf; retain the actual window capture for visible-text review.
            let add = try DesktopAccessibilityDriver.element("add-source", in: hosting)
            XCTAssertEqual(add.accessibilityRole(), .button)
            XCTAssertEqual(add.accessibilityLabel(), "Add a source")
            XCTAssertTrue(add.isAccessibilityEnabled())
            XCTAssertGreaterThan(add.accessibilityFrame().width, 0)
            XCTAssertGreaterThan(add.accessibilityFrame().height, 0)
            let window = try XCTUnwrap(hosting.window)
            XCTAssertTrue(window.frame.contains(add.accessibilityFrame()), "The actual Add-source button must remain inside the toolbar")
            XCTAssertTrue(add.accessibilityPerformPress())
            let presentationDeadline = ContinuousClock.now + .seconds(3)
            while window.attachedSheet == nil, ContinuousClock.now < presentationDeadline {
                try await Task.sleep(for: .milliseconds(25))
            }
            let pickerSheet = try XCTUnwrap(window.attachedSheet, "Add a source must present its actual picker sheet")
            XCTAssertTrue(window.attachedSheet === pickerSheet)
            XCTAssertTrue(pickerSheet.sheetParent === window)
            let pickerContent = try XCTUnwrap(pickerSheet.contentView)
            while ContinuousClock.now < presentationDeadline {
                let doneReady = (try? DesktopAccessibilityDriver.elements(in: pickerContent))?.contains {
                    $0.accessibilityRole() == .button && $0.accessibilityLabel() == "Done" && $0.isAccessibilityEnabled()
                        && $0.accessibilityFrame().width > 0 && $0.accessibilityFrame().height > 0
                        && pickerSheet.frame.contains($0.accessibilityFrame())
                } == true
                if doneReady, (try? DesktopAccessibilityDriver.contains("Finding available sources", in: pickerContent)) == true { break }
                try await Task.sleep(for: .milliseconds(25))
            }
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Finding available sources", in: pickerContent))
            let done = try XCTUnwrap(DesktopAccessibilityDriver.elements(in: pickerContent).first {
                $0.accessibilityRole() == .button && $0.accessibilityLabel() == "Done" && $0.isAccessibilityEnabled()
            })
            XCTAssertGreaterThan(done.accessibilityFrame().width, 0)
            XCTAssertGreaterThan(done.accessibilityFrame().height, 0)
            XCTAssertTrue(pickerSheet.frame.contains(done.accessibilityFrame()))
            XCTAssertTrue(done.accessibilityPerformPress())
            let dismissalDeadline = ContinuousClock.now + .seconds(3)
            while window.attachedSheet != nil, ContinuousClock.now < dismissalDeadline {
                try await Task.sleep(for: .milliseconds(25))
            }
            XCTAssertNil(window.attachedSheet, "The picker's actual Done action must dismiss its own sheet")
            try DesktopSnapshotRenderer.assertRequiredBannerLayout(hosting, below: ["library-brand-title"])
            let review = try DesktopAccessibilityDriver.element("required-setup-review", in: hosting)
            XCTAssertTrue(review.isAccessibilityEnabled())
            XCTAssertTrue(review.accessibilityPerformPress())
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertEqual(store.destination, .setup, "The visible required action must navigate through its real handler")
            try DesktopSnapshotRenderer.assertRequiredBannerLayout(hosting, below: ["library-brand-title"])
            // Return through ordinary store navigation so both appearances cover the source list.
            store.destination = .sources
        }
    }

    private func writeMinimumToolbarFacts(_ hosting: NSView) throws {
        let window = try XCTUnwrap(hosting.window)
        func rect(_ frame: NSRect) -> [String: CGFloat] {
            ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
        }
        let elements = try DesktopAccessibilityDriver.elements(in: hosting)
        var facts: [String: Any] = [
            "windowNumber": window.windowNumber,
            "windowFrame": rect(window.frame), "usableFrame": rect(window.convertToScreen(window.contentLayoutRect)),
            "hostingBounds": rect(hosting.bounds),
        ]
        facts["toolbarAX"] = elements.filter {
            ["add-source", "add-source-title"].contains($0.accessibilityIdentifier() ?? "")
                || ($0.accessibilityLabel() ?? "").contains("Add a source")
                || ($0.accessibilityTextValue() ?? "").contains("Add a source")
        }.prefix(64).map { element -> [String: Any] in
            var row: [String: Any] = [
                "type": String(reflecting: Swift.type(of: element.object)),
                "role": element.accessibilityRole()?.rawValue ?? "none", "identifier": element.accessibilityIdentifier() ?? "",
                "label": String((element.accessibilityLabel() ?? "").prefix(240)),
                "text": String((element.accessibilityTextValue() ?? "").prefix(240)),
                "frame": rect(element.accessibilityFrame()), "enabled": element.isAccessibilityEnabled(),
                "children": element.accessibilityChildren().count,
            ]
            if let cell = element.object as? NSCell, let control = cell.controlView {
                row["nativeControl"] = String(reflecting: Swift.type(of: control))
                row["exactWindow"] = control.window === window
                if control.window === window {
                    row["nativeFrame"] = rect(window.convertToScreen(control.convert(control.bounds, to: nil)))
                }
                if let button = control as? NSButton {
                    row["nativeTitle"] = String(button.title.prefix(240))
                    row["nativeAttributedTitle"] = String(button.attributedTitle.string.prefix(240))
                }
            }
            return row
        }
        let directory = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let appearance = window.appearance?.name.rawValue ?? "unknown"
        let destination = directory.appendingPathComponent("minimum-library-toolbar-\(window.windowNumber)-\(appearance).txt")
        try JSONSerialization.data(withJSONObject: facts, options: [.sortedKeys]).write(to: destination, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
    }

    func testOrdinaryFittedSettingsKeepsTabsScrollingAndRequiredRepairReachable() async throws {
        let store = try await minimumWindowStore()
        try await DesktopSnapshotRenderer.renderVisibleWindow(
            DesktopSettingsView().environment(store),
            name: "minimum-settings", size: CGSize(width: 720, height: 600)
        ) { hosting in
            let window = try XCTUnwrap(hosting.window)
            @MainActor func assertRepairVisible() throws {
                let repair = try DesktopAccessibilityDriver.element("setup-review-storage", in: hosting)
                XCTAssertTrue(repair.isAccessibilityEnabled())
                XCTAssertGreaterThan(repair.accessibilityFrame().width, 0)
                XCTAssertGreaterThan(repair.accessibilityFrame().height, 0)
                XCTAssertTrue(
                    window.convertToScreen(window.contentLayoutRect).contains(repair.accessibilityFrame()),
                    "The required repair must be visible in the real fitted settings viewport"
                )
            }
            try assertRepairVisible()
            let scroll = try XCTUnwrap(Self.descendants(hosting).compactMap { $0 as? NSScrollView }.first {
                !$0.isHiddenOrHasHiddenAncestor && ($0.documentView?.bounds.height ?? 0) > $0.contentView.bounds.height
            })
            let document = try XCTUnwrap(scroll.documentView)
            let original = scroll.contentView.bounds.origin
            let bottom = document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.height : document.bounds.minY
            scroll.contentView.scroll(to: NSPoint(x: original.x, y: bottom))
            scroll.reflectScrolledClipView(scroll.contentView)
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertNotEqual(scroll.contentView.bounds.origin.y, original.y, "The fitted General form must actually scroll")
            scroll.contentView.scroll(to: original)
            scroll.reflectScrolledClipView(scroll.contentView)
            try await Task.sleep(for: .milliseconds(100))
            try assertRepairVisible()
            for (title, tab) in [("Privacy", "privacy"), ("General", "general")] {
                let control = try XCTUnwrap(DesktopAccessibilityDriver.elements(in: hosting).first {
                    $0.accessibilityLabel() == title && $0.isAccessibilityEnabled()
                        && ($0.accessibilityRole() == .button || $0.accessibilityRole() == .radioButton)
                }, "The fitted settings window must expose its real \(title) tab control")
                XCTAssertTrue(window.frame.contains(control.accessibilityFrame()))
                XCTAssertTrue(control.accessibilityPerformPress())
                try await Task.sleep(for: .milliseconds(100))
                XCTAssertEqual(store.settingsTab, tab, "Tab navigation must invoke its actual control")
            }
            try assertRepairVisible()
        }
    }

    private func minimumWindowStore() async throws -> DesktopStore {
        let startup = DesktopAutomaticStartup(read: { .enabled }, register: {})
        let power = DesktopMacServerPowerFlow(probe: { DesktopMacServerPowerObservation(status: .ready) })
        let store = DesktopStore(startRuntime: false, automaticStartup: startup, serverPower: power, nativeOwnerVerified: true)
        let expiry = floor(Date().timeIntervalSince1970 * 1000) + 60000
        store.state = try DesktopState(
            phase: .ready, mode: "home",
            connection: JSONDecoder().decode(DesktopConnection.self, from: Data(
                #"{"url":"https://gateway.example.com","token":"fixture-only"}"#.utf8
            )), encrypted: true, installationId: "desktop-0000000000000001",
            storageAdmission: .init(state: "blocked", validUntil: expiry), remoteRoute: .init(state: "ready", validUntil: expiry)
        )
        store.homeServices.receive(store.state)
        startup.refresh()
        await power.refresh()
        return store
    }

    func testMountedSettingsKeepsSectionOrderWhenPrerequisitePollCompletes() async throws {
        let startup = DesktopAutomaticStartup(read: { .enabled }, register: {})
        let power = DesktopMacServerPowerFlow(probe: { DesktopMacServerPowerObservation(status: .ready) })
        let store = DesktopStore(startRuntime: false, automaticStartup: startup, serverPower: power, nativeOwnerVerified: true)
        let connection = try JSONDecoder().decode(
            DesktopConnection.self,
            from: Data(#"{"url":"https://gateway.example.com","token":"fixture-only"}"#.utf8)
        )
        let expiry = floor(Date().timeIntervalSince1970 * 1000) + 60000
        func state(_ storage: String) -> DesktopState {
            DesktopState(
                phase: .ready,
                mode: "home",
                connection: connection,
                encrypted: true,
                installationId: "desktop-0000000000000001",
                storageAdmission: .init(state: storage, validUntil: expiry),
                remoteRoute: .init(
                    state: "ready",
                    validUntil: expiry
                )
            )
        }
        store.state = state("blocked")
        store.homeServices.receive(store.state)
        XCTAssertEqual(store.homeServices.storage, .blocked)
        startup.refresh()
        await power.refresh()
        let hosting = NSHostingView(rootView: DesktopSettingsView().environment(store).frame(width: 720, height: 640))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 640),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        defer { window.close() }
        window.makeKeyAndOrderFront(nil)
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        func assertServicesFirst() throws {
            let services = try DesktopAccessibilityDriver.element("settings-prerequisite-services", in: hosting).accessibilityFrame()
            let startup = try DesktopAccessibilityDriver.element("settings-prerequisite-startup", in: hosting).accessibilityFrame()
            XCTAssertGreaterThan(services.minY, startup.maxY, "A mounted poll must not reorder prerequisite sections")
        }
        XCTAssertTrue(try DesktopAccessibilityDriver.contains("Collection needs more storage", in: hosting))
        try assertServicesFirst()
        for status in ["checking", "ready"] {
            store.state = state(status)
            store.homeServices.receive(store.state)
            hosting.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
            if status == "checking" {
                XCTAssertEqual(store.homeServices.storage, .checking)
                XCTAssertTrue(try DesktopAccessibilityDriver.contains("Checking space for collection", in: hosting))
            } else {
                XCTAssertEqual(store.homeServices.storage, .ready)
                XCTAssertTrue(try DesktopAccessibilityDriver.contains("Storage is ready for collection", in: hosting))
            }
            try assertServicesFirst()
        }
    }

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

    func testBrandedSettingsHasActualLibraryInformation() async throws {
        let store = DesktopStore.preview()
        store.state = try JSONDecoder().decode(DesktopState.self, from: Data(
            #"{"phase":"ready","mode":"home","encrypted":true,"homeName":"Example library","connection":{"url":"https://gateway.example.com","token":"fixture-only"}}"#
                .utf8
        ))
        store.settingsTab = "general"
        try await DesktopSnapshotRenderer.render(
            DesktopSettingsView().environment(store), name: "settings-branded", size: CGSize(width: 720, height: 640)
        ) { hosting in
            try DesktopSnapshotRenderer.assertOwnedWindowChrome(XCTUnwrap(hosting.window))
            XCTAssertTrue(
                try DesktopAccessibilityDriver.contains("Example library", in: hosting),
                "Settings must render the actual selected library"
            )
            XCTAssertTrue(
                try DesktopAccessibilityDriver.contains("Recovery protection", in: hosting),
                "Settings must retain its recovery action"
            )
        }
    }

    func testWaiting() async throws {
        try await DesktopSnapshotRenderer.render(
            DesktopRootView().environment(DesktopStore.preview(phase: .waiting)),
            name: "waiting",
            size: CGSize(width: 1080, height: 740)
        ) { hosting in
            XCTAssertFalse(
                Self.descendants(hosting).contains { $0 is NSTableView },
                "Connection setup must not present unavailable library navigation"
            )
        }
    }

    func testReadyLibraryNavigationHasVisibleRows() async throws {
        let store = DesktopStore.preview()
        store.state = try JSONDecoder().decode(DesktopState.self, from: Data(
            #"{"phase":"ready","mode":"home","encrypted":true,"connection":{"url":"https://gateway.example.com","token":"fixture-only"}}"#
                .utf8
        ))
        store.destination = .setup
        try await DesktopSnapshotRenderer.render(
            DesktopRootView().environment(store),
            name: "ready-sidebar",
            size: CGSize(width: 1080, height: 740)
        ) { hosting in
            let tables = Self.descendants(hosting).compactMap { $0 as? NSTableView }
            XCTAssertTrue(
                tables.contains { table in
                    table.numberOfRows > 0 && table.bounds.width >= 160 && table.visibleRect.height >= 120
                        && !table.isHiddenOrHasHiddenAncestor
                        && table.rowView(atRow: 0, makeIfNecessary: false) != nil
                },
                "The sidebar must lay out actual navigation rows, not an empty material panel"
            )
        }
    }

    func testReadySourcesWindowContainsTheRegisteredSourceAndNativeActions() async throws {
        let store = DesktopStore.preview()
        store.state = try JSONDecoder().decode(DesktopState.self, from: Data(
            #"{"phase":"ready","mode":"home","encrypted":true,"connection":{"url":"https://gateway.example.com","token":"fixture-only"}}"#
                .utf8
        ))
        store.sources = try JSONDecoder().decode([DesktopSource].self, from: Data(
            #"[{"id":"example:notes","type":"Example notes","accountId":"Example notebook","enabled":true,"deviceId":"fixture-device"}]"#
                .utf8
        ))
        store.destination = .sources
        try await DesktopSnapshotRenderer.render(
            DesktopRootView().environment(store),
            name: "sources-library",
            size: CGSize(width: 1080, height: 740)
        ) { hosting in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Example notebook", in: hosting))
            let window = try XCTUnwrap(hosting.window)
            DesktopSnapshotRenderer.assertOwnedWindowChrome(window)
            try DesktopSnapshotRenderer.writeOwnedLayoutFacts(window, name: "sources-banner")
            try DesktopSnapshotRenderer.assertRequiredBannerLayout(hosting, below: ["library-brand-title"])
            XCTAssertNotNil(hosting.window?.toolbar, "Source actions must remain reachable in the native window toolbar")
        }
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
        try await DesktopSnapshotRenderer.render(
            DesktopAskView().environment(DesktopStore.preview()),
            name: "ask-empty",
            size: CGSize(width: 1080, height: 740)
        ) { hosting in
            let window = try XCTUnwrap(hosting.window)
            let content = window.convertToScreen(hosting.convert(hosting.bounds, to: nil))
            let title = try DesktopAccessibilityDriver.element("chat-empty-title", in: hosting).accessibilityFrame()
            let input = try DesktopAccessibilityDriver.element("chat-input", in: hosting).accessibilityFrame()
            for frame in [title, input] {
                XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
                XCTAssertGreaterThan(frame.width, 0)
                XCTAssertGreaterThan(frame.height, 0)
                XCTAssertTrue(content.contains(frame), "The empty conversation and composer must remain inside the content")
            }
            XCTAssertGreaterThan(input.width, 400, "The actual composer must use the available reading width")
            XCTAssertLessThan(input.minY - content.minY, 120, "The composer must remain near the bottom of the window")
            XCTAssertGreaterThan(title.minY - input.maxY, 250, "Ask must fill the window instead of collapsing at the bottom")
        }
    }

    func testAskIncreasedContrastUsesVisibleSelectionAndComposerBoundaries() async throws {
        var environment = EnvironmentValues()
        let nativeContrast = environment.colorSchemeContrast
        XCTAssertEqual(environment.desktopContrast, nativeContrast)
        environment.desktopContrast = .increased
        XCTAssertEqual(environment.desktopContrast, .increased)
        XCTAssertEqual(
            environment.colorSchemeContrast,
            nativeContrast,
            "The app-local preference must not mutate the system contrast value"
        )
        let store = DesktopStore.preview()
        store.state = try JSONDecoder().decode(DesktopState.self, from: Data(
            #"{"phase":"ready","mode":"home","encrypted":true,"connection":{"url":"https://gateway.example.com","token":"fixture-only"}}"#
                .utf8
        ))
        try await DesktopSnapshotRenderer.render(
            DesktopRootView().environment(store).environment(\.desktopContrast, .increased),
            name: "ask-increased-contrast", size: CGSize(width: 860, height: 600)
        ) { hosting in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Ask", in: hosting))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Message to Omnesis", in: hosting))
        }
    }

    func testPausedSourceNeverPresentsItsCachedSyncAsCurrentCompletion() async throws {
        let source = try JSONDecoder().decode(DesktopSource.self, from: Data(
            #"{"id":"example:notes","type":"example","accountId":"Example notebook","enabled":false,"deviceId":"fixture-device"}"#.utf8
        ))
        let status = try JSONDecoder().decode(DesktopSourceHealth.self, from: Data(
            #"{"sourceId":"example:notes","state":"synced","lastSyncAt":"2026-01-01T12:00:00Z"}"#.utf8
        ))
        try await DesktopSnapshotRenderer.render(
            DesktopSourceHealthView(
                source: source,
                status: status,
                current: true,
                devices: [],
                canSignIn: false,
                signIn: { _ in XCTFail("Render must not sign in") }
            ).padding(32),
            name: "source-paused-cached-sync", size: CGSize(width: 720, height: 400)
        ) { hosting in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Paused", in: hosting))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Last sync complete", in: hosting))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Collecting information", in: hosting))
        }
    }

    func testRevokedSourceHostNeedingPairingRemainsVisibleWithRepairInstructions() async throws {
        let store = DesktopStore.preview()
        store.devices = try JSONDecoder().decode([DesktopDevice].self, from: Data(
            #"[{"id":"repair-host","name":"Example laptop","kind":"collector","online":false,"revokedAt":1,"needsPairing":true},{"id":"retired-host","name":"Retired device fixture","kind":"collector","revokedAt":1,"needsPairing":false}]"#
                .utf8
        ))
        try await DesktopSnapshotRenderer.render(
            DesktopDevicesView().environment(store),
            name: "devices-needs-pairing",
            size: CGSize(width: 860, height: 600)
        ) { hosting in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Example laptop", in: hosting))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Needs pairing", in: hosting))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Repair instructions", in: hosting))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Retired device fixture", in: hosting))
        }
    }

    private static func descendants(_ view: NSView) -> [NSView] {
        view.subviews.flatMap { [$0] + descendants($0) }
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
