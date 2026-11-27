// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation
@testable import OmnesisDesktop
import XCTest

private final class StatusMenuMetadataProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url, url.host == "status.example.test", request.httpMethod == "GET",
              request.value(forHTTPHeaderField: "Authorization") == "Bearer invented-menu-token",
              ["/admin/sources", "/admin/devices", "/admin/source-descriptors"].contains(url.path),
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: 200,
                  httpVersion: nil,
                  headerFields: ["Content-Type": "application/json"]
              )
        else { client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"items":[]}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
final class DesktopStatusMenuTests: XCTestCase {
    private final class Probe {
        var main = 0
        var settings = 0
        var quit = 0
        var startup = DesktopAutomaticStartup.Status.enabled
        var actions: DesktopStatusMenu.Actions {
            .init(openMain: { self.main += 1 }, openSettings: { self.settings += 1 }, quit: { self.quit += 1 })
        }
    }

    private func readyStore(_ probe: Probe) async throws -> (DesktopStore, URLSession) {
        let startup = DesktopAutomaticStartup(read: { probe.startup }, register: {})
        let store = DesktopStore(startRuntime: false, automaticStartup: startup, nativeOwnerVerified: true, monitorPrerequisites: false)
        store.state = try JSONDecoder().decode(DesktopState.self, from: Data(
            #"{"phase":"ready","mode":"joined","encrypted":true,"installationId":"desktop-0000000000000001","connection":{"url":"https://status.example.test","token":"invented-menu-token"}}"#
                .utf8
        ))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StatusMenuMetadataProtocol.self]
        let session = URLSession(configuration: configuration)
        store.api = try DesktopAPI(connection: XCTUnwrap(store.state.connection), sessionOverride: session)
        await store.refreshPrerequisiteMetadata()
        startup.refresh()
        XCTAssertTrue(store.sourcesLoaded)
        XCTAssertTrue(store.requiredSetupReady)
        return (store, session)
    }

    private func press(_ title: String, in controller: DesktopStatusMenu) throws {
        let index = controller.menu.indexOfItem(withTitle: title)
        XCTAssertGreaterThanOrEqual(index, 0)
        guard index >= 0 else { return }
        controller.menu.performActionForItem(at: index)
    }

    func testRealStatusButtonHasApplicationSemanticsAndOwnRemovalIsIdempotent() throws {
        let controller = DesktopStatusMenu(store: .preview(), actions: Probe().actions)
        defer { controller.invalidate() }
        controller.install()
        let item = try XCTUnwrap(controller.statusItem)
        let button = try XCTUnwrap(item.button)
        XCTAssertEqual(button.title, "Omnesis")
        XCTAssertEqual(button.accessibilityLabel(), "Omnesis")
        XCTAssertEqual(button.accessibilityIdentifier(), "Omnesis")
        XCTAssertEqual(button.image?.size, NSSize(width: 18, height: 18))
        XCTAssertEqual(button.imagePosition, .imageOnly)
        XCTAssertTrue(item.menu === controller.menu)
        controller.install()
        XCTAssertTrue(controller.statusItem === item)
        controller.invalidate()
        controller.invalidate()
        XCTAssertNil(controller.statusItem)
        XCTAssertNil(item.menu)
        controller.install()
        XCTAssertNil(controller.statusItem, "An invalidated owner cannot recreate its status item")
    }

    func testNativeCommandTitlesAndAccessibilityLabelsMatch() throws {
        let controller = DesktopStatusMenu(store: .preview(), actions: Probe().actions)
        controller.install()
        defer { controller.invalidate() }
        for title in ["Ask Omnesis", "Search", "Sources", "Review setup", "Open Omnesis", "Settings…", "Quit Omnesis"] {
            let matches = controller.menu.items.filter { $0.title == title }
            XCTAssertEqual(matches.count, 1)
            let item = try XCTUnwrap(matches.first)
            XCTAssertEqual(item.title, title)
            XCTAssertEqual(item.accessibilityLabel(), title)
            XCTAssertNotNil(item.action)
            XCTAssertTrue(item.target === controller)
        }
    }

    func testMenuOpeningProjectsCurrentReadinessWithoutAWindowOrAnOSGrant() async throws {
        let probe = Probe()
        let (store, session) = try await readyStore(probe)
        defer { session.invalidateAndCancel() }
        let controller = DesktopStatusMenu(store: store, actions: probe.actions)
        controller.install()
        defer { controller.invalidate() }
        controller.menuWillOpen(controller.menu)
        XCTAssertEqual(controller.menu.item(at: 0)?.title, "Ready")
        XCTAssertEqual(controller.menu.item(withTitle: "Review setup")?.isHidden, true)
        probe.startup = .disabled
        store.automaticStartup.refresh()
        controller.menuWillOpen(controller.menu)
        XCTAssertEqual(controller.menu.item(at: 0)?.title, "Setup needs attention")
        XCTAssertEqual(controller.menu.item(withTitle: "Review setup")?.isHidden, false)
        XCTAssertEqual(controller.menu.item(withTitle: "Review setup")?.isEnabled, true)
        try press("Review setup", in: controller)
        XCTAssertEqual(store.destination, .setup)
        XCTAssertEqual(probe.main, 1)
        store.state = DesktopState(phase: .waiting, message: "An invented library is unavailable.")
        controller.menuNeedsUpdate(controller.menu)
        XCTAssertEqual(controller.menu.item(at: 0)?.title, store.menuStatusLabel)
        XCTAssertEqual(controller.menu.item(at: 1)?.title, "An invented library is unavailable.")
        XCTAssertEqual(controller.menu.item(withTitle: "Ask Omnesis")?.isEnabled, false)
        XCTAssertEqual(controller.menu.item(withTitle: "Open Omnesis")?.isEnabled, true)
        let fullMessage = "  \n" + String(repeating: "A fictional recovery message with details. \n", count: 8)
        store.state = DesktopState(phase: .waiting, message: fullMessage)
        controller.menuWillOpen(controller.menu)
        let summary = try XCTUnwrap(controller.menu.item(at: 1)?.title)
        XCTAssertLessThanOrEqual(summary.count, 80)
        XCTAssertTrue(summary.hasPrefix("A fictional recovery message"))
        XCTAssertTrue(summary.hasSuffix("…"))
        XCTAssertFalse(summary.contains("\n"))
        XCTAssertFalse(summary.contains("  "))
        XCTAssertEqual(store.state.message, fullMessage, "The main window must retain the complete error message")
        XCTAssertEqual(controller.menu.item(withTitle: "Open Omnesis")?.isEnabled, true)
    }

    func testActualMenuActionsUseTheirCallbacksAndRecheckAvailabilityAtDispatch() async throws {
        let probe = Probe()
        let (store, session) = try await readyStore(probe)
        defer { session.invalidateAndCancel() }
        let controller = DesktopStatusMenu(store: store, actions: probe.actions)
        controller.install()
        defer { controller.invalidate() }
        for (title, destination) in [("Ask Omnesis", DesktopStore.Destination.ask), ("Search", .search), ("Sources", .sources)] {
            try press(title, in: controller)
            XCTAssertEqual(store.destination, destination)
        }
        XCTAssertEqual(probe.main, 3)
        try press("Settings…", in: controller)
        XCTAssertEqual(probe.settings, 1)
        try press("Quit Omnesis", in: controller)
        XCTAssertEqual(probe.quit, 1)
        // Simulate a queued menu action after its earlier enabled projection became stale.
        store.state = DesktopState(phase: .waiting)
        try press("Search", in: controller)
        XCTAssertEqual(probe.main, 3)
        XCTAssertEqual(store.destination, .sources)
        try press("Open Omnesis", in: controller)
        XCTAssertEqual(probe.main, 4)
        let queuedItem = try XCTUnwrap(controller.menu.item(withTitle: "Open Omnesis"))
        let queuedAction = try XCTUnwrap(queuedItem.action)
        controller.invalidate()
        XCTAssertNil(queuedItem.action)
        XCTAssertTrue(NSApp.sendAction(queuedAction, to: controller, from: queuedItem))
        XCTAssertEqual(probe.main, 4, "A queued owned action cannot dispatch after its controller is invalidated")
    }

    func testDelegateInstallsOnceForEitherConfigurationLaunchOrderWithoutRootAppearance() throws {
        for configuredFirst in [false, true] {
            let delegate = DesktopApplicationDelegate()
            let store = DesktopStore.preview()
            let probe = Probe()
            let notification = Notification(name: NSApplication.didFinishLaunchingNotification)
            if configuredFirst { delegate.configure(store: store, actions: probe.actions) }
            delegate.applicationDidFinishLaunching(notification)
            if !configuredFirst { delegate.configure(store: store, actions: probe.actions) }
            let controller = try XCTUnwrap(delegate.statusMenu)
            defer { controller.invalidate() }
            let item = try XCTUnwrap(controller.statusItem)
            delegate.configure(store: store, actions: Probe().actions)
            delegate.applicationDidFinishLaunching(notification)
            XCTAssertTrue(delegate.statusMenu === controller)
            XCTAssertTrue(controller.statusItem === item)
            XCTAssertTrue(delegate.store === store)
            try press("Open Omnesis", in: controller)
            XCTAssertEqual(probe.main, 1, "Repeated App.body evaluation must retain the first immutable scene actions")
            XCTAssertFalse(delegate.applicationShouldTerminateAfterLastWindowClosed(NSApp))
        }
    }
}
