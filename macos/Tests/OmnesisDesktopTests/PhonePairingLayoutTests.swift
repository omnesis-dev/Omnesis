// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation
import Omnesis
@testable import OmnesisDesktop
import SwiftUI
import XCTest

/// Qualifies this wrapper's attached sheet, not navigation through Devices.
@MainActor
private struct PhonePairingSheetFixture: View {
    let store: DesktopStore
    let context: DesktopAPIContext
    @State private var presented = true
    var body: some View {
        Text("Fictional device settings")
            .omnesisSheet(isPresented: $presented) { DesktopPhonePairingView(context: context).environment(store) }
    }
}

@MainActor
final class PhonePairingLayoutTests: XCTestCase {
    private func wait(_ condition: @MainActor () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < deadline {
            let ready = try await condition()
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            if ready { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw URLError(.timedOut)
    }

    private func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap { descendants($0) }
    }

    private func control(_ url: URL, _ path: String, session: URLSession, body: [String: Any]? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: url.appendingPathComponent(path))
        request.timeoutInterval = 3
        request.setValue("Bearer gui-fixture-token", forHTTPHeaderField: "Authorization")
        if let body { request.httpMethod = "POST"
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testPhonePairingKeepsFullRosterAndErrorsScrollableWithPinnedActions() async throws {
        var completed = 0
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            for width in [CGFloat(860), CGFloat(720)] {
                for scenario in ["initial", "active", "many", "error"] {
                    try await exercise(scenario, appearance: appearance, parentWidth: width)
                    completed += 1
                }
            }
        }
        XCTAssertEqual(completed, 16)
    }

    private func exercise(_ scenario: String, appearance: NSAppearance.Name, parentWidth: CGFloat) async throws {
        let fixture = try await ScriptedAgentFixture.start(scriptName: "api-context-fixture.mjs")
        defer { fixture.stop() }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let many = scenario == "many" || scenario == "error"
        let phones: [[String: Any]] = (0 ..< (many ? 20 : 0)).map { index in
            [
                "id": "fictional-phone-\(index)",
                "kind": "ios",
                "online": true,
                "name": "Fictional phone \(index) — " + String(repeating: "invented device name ", count: 4),
            ]
        }
        let message = String(
            repeating: "This fictional pairing request could not finish. Existing devices remain connected; review the connection and try again. ",
            count: 14
        )
        let expiry = Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)
        let pairBody: [String: Any] = scenario == "error" ? ["error": message] : [
            "pairingCode": "fictional-owned-code",
            "expiresAt": expiry,
        ]
        let routes: [String: Any] = [
            "GET /admin/cloud-relay": ["body": ["enabled": true, "publicMcp": ["ready": true, "url": "https://library.example.com/mcp"]]],
            "GET /admin/access": ["body": [
                "principals": [],
                "sources": [],
                "policyFamilies": [],
                "oauth": ["resource": "https://library.example.com/mcp"],
            ]],
            "GET /admin/devices": ["body": ["items": phones]],
            "POST /admin/devices/pair": [
                "status": scenario == "error" ? 500 : 200,
                "body": pairBody,
            ],
            "POST /admin/devices/pair-addresses": ["body": [
                "platform": "ios",
                "addresses": [[
                    "gatewayUrl": "https://library.example.com",
                    "host": "library.example.com",
                    "label": "Fictional library",
                    "usable": true,
                    "systemTrust": true,
                    "kind": "relay",
                ]],
            ]],
            "POST /admin/devices/pair-qr": ["body": ["qrPayload": "fictional-server-encoded-qr"]],
            "DELETE /admin/devices/pair": ["body": ["revoked": true]],
        ]
        _ = try await control(fixture.url, "fixture-config", session: session, body: ["routes": routes])
        let connection = try JSONDecoder().decode(
            DesktopConnection.self,
            from: JSONSerialization.data(withJSONObject: ["url": fixture.url.absoluteString, "token": "gui-fixture-token"])
        )
        let context = try DesktopAPIContext(api: DesktopAPI(connection: connection), id: 1)
        let bridge = RuntimeBridge()
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, monitorPrerequisites: false)
        let suite = "dev.omnesis.phone-layout." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let hosting = NSHostingView(rootView: PhonePairingSheetFixture(store: store, context: context).omnesisTheme()
            .defaultAppStorage(defaults).environment(\.desktopAppearanceOverride, appearance == .aqua ? .light : .dark))
        hosting.sizingOptions = []
        hosting.autoresizingMask = [.width, .height]
        hosting.frame = NSRect(x: 0, y: 0, width: parentWidth, height: 600)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.setContentSize(NSSize(width: parentWidth, height: 600))
        window.center()
        window.makeKeyAndOrderFront(nil)
        do {
            try await DesktopAccessibilityDriver.materializeOwnedApplication()
            try await wait { window.attachedSheet != nil }
            let sheet = try XCTUnwrap(window.attachedSheet)
            let content = try XCTUnwrap(sheet.contentView)
            XCTAssertTrue(sheet.sheetParent === window)
            try await wait {
                let status = try await self.control(fixture.url, "fixture-context-status", session: session)
                let requests = try XCTUnwrap(status["requests"] as? [[String: Any]])
                let enabled = try DesktopAccessibilityDriver.element("phone-pairing-create", in: content).isAccessibilityEnabled()
                return requests.contains { $0["path"] as? String == "/admin/cloud-relay" } &&
                    requests.contains { $0["path"] as? String == "/admin/access" } &&
                    enabled
            }
            if scenario != "initial" {
                try DesktopAccessibilityDriver.press("phone-pairing-create", in: content)
                try await wait {
                    if scenario == "error" { return (try? DesktopAccessibilityDriver.element("phone-pairing-error", in: content)) != nil }
                    return (try? DesktopAccessibilityDriver.element("phone-pairing-qr", in: content)) != nil
                }
            }
            let area = try DesktopAccessibilityDriver.element("phone-pairing-content", in: content)
            let pixel = 1 / sheet.backingScaleFactor
            let areaFrame = area.accessibilityFrame()
            let scrolls = descendants(content).compactMap { $0 as? NSScrollView }.filter {
                let frame = sheet.convertToScreen($0.convert($0.bounds, to: nil))
                return $0
                    .window === sheet && abs(frame.minX - areaFrame.minX) <= pixel && abs(frame.minY - areaFrame.minY) <= pixel &&
                    abs(frame.width - areaFrame.width) <= pixel && abs(frame.height - areaFrame.height) <= pixel
            }
            XCTAssertEqual(scrolls.count, 1)
            let scroll = try XCTUnwrap(scrolls.first)
            var previous: NSRect?, stable = 0
            try await wait {
                guard let document = scroll.documentView, scroll.contentView.bounds.height > 0 else { return false }
                let height = scroll.contentView.bounds.height
                let fits = scenario == "initial" ? document.bounds.height <= height + pixel && height < 320 : document.bounds
                    .height > height + 44
                guard fits else { stable = 0
                    return false
                }
                if previous == sheet.frame { stable += 1 } else { stable = 0 }
                previous = sheet.frame
                return stable >= 3
            }
            XCTAssertEqual(hosting.bounds.size, NSSize(width: parentWidth, height: 600))
            XCTAssertGreaterThanOrEqual(window.contentLayoutRect.width, parentWidth)
            XCTAssertGreaterThanOrEqual(window.contentLayoutRect.height, 600)
            let screen = try XCTUnwrap(sheet.screen)
            XCTAssertTrue(screen.visibleFrame.contains(window.frame))
            XCTAssertTrue(screen.visibleFrame.contains(sheet.frame))
            XCTAssertLessThanOrEqual(sheet.frame.height, 600)
            XCTAssertEqual(sheet.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]), appearance)
            let controls = try ["phone-pairing-title", "phone-pairing-done", "phone-pairing-create"]
                .map { try DesktopAccessibilityDriver.element(
                    $0,
                    in: content
                ) }
            let frames = controls.map { $0.accessibilityFrame() }
            let viewport = sheet.convertToScreen(content.convert(content.bounds, to: nil))
            for frame in frames {
                XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
                XCTAssertGreaterThan(frame.width, 0)
                XCTAssertGreaterThan(frame.height, 0)
                XCTAssertTrue(viewport.contains(frame))
            }
            XCTAssertTrue(controls[1].isAccessibilityEnabled())
            XCTAssertTrue(controls[2].isAccessibilityEnabled())
            XCTAssertEqual(
                controls[2].accessibilityLabel(),
                scenario == "active" || scenario == "many" ? "Create a new code" : "Create a scan code"
            )
            if scenario == "error" {
                let error = try DesktopAccessibilityDriver.element("phone-pairing-error", in: content)
                let expected = GatewayClient.Error.serverError(status: 500, body: "{\"error\":\"" + message + "\"}").localizedDescription
                XCTAssertEqual(error.accessibilityTextValue() ?? error.accessibilityLabel(), expected)
                XCTAssertFalse(try DesktopAccessibilityDriver.elements(in: content)
                    .contains { $0.accessibilityIdentifier() == "phone-pairing-qr" })
            }
            if many { XCTAssertTrue(try DesktopAccessibilityDriver.contains(XCTUnwrap(phones.last?["name"] as? String), in: content)) }
            if scenario != "initial" {
                let document = try XCTUnwrap(scroll.documentView)
                let origin = scroll.contentView.bounds.origin
                scroll.contentView.scroll(to: NSPoint(
                    x: origin.x,
                    y: document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.height : document.bounds.minY
                ))
                scroll.reflectScrolledClipView(scroll.contentView)
                try await Task.sleep(for: .milliseconds(100))
                XCTAssertNotEqual(scroll.contentView.bounds.origin.y, origin.y)
                let gap = document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.maxY : scroll.contentView.bounds
                    .minY - document.bounds.minY
                XCTAssertEqual(gap, 0, accuracy: pixel)
                XCTAssertEqual(controls.map { $0.accessibilityFrame() }, frames)
                let terminal: DesktopAccessibilityDriver.Element
                if scenario == "error" {
                    terminal = try DesktopAccessibilityDriver.element("phone-pairing-error", in: content)
                } else if many {
                    let lastName = try XCTUnwrap(phones.last?["name"] as? String)
                    terminal = try XCTUnwrap(DesktopAccessibilityDriver.elements(in: content).first {
                        $0.accessibilityLabel() == lastName || $0.accessibilityTextValue() == lastName
                    })
                } else {
                    terminal = try DesktopAccessibilityDriver.element("phone-pairing-completion", in: content)
                }
                let visibleBody = sheet.convertToScreen(scroll.contentView.convert(scroll.contentView.bounds, to: nil))
                let terminalFrame = terminal.accessibilityFrame()
                XCTAssertGreaterThan(terminalFrame.width, 0)
                XCTAssertGreaterThan(terminalFrame.height, 0)
                XCTAssertTrue(visibleBody.intersects(terminalFrame), "The final content must be physically reachable at the document end")
                scroll.contentView.scroll(to: origin)
                scroll.reflectScrolledClipView(scroll.contentView)
            }
            let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            try await DesktopSnapshotRenderer.captureOwnedWindow(
                sheet,
                output: output,
                name: "phone-pairing-wrapper-" + scenario + "-" + String(Int(parentWidth)),
                appearance: appearance,
                requireActive: true
            )
            XCTAssertNil(bridge.selectedRuntime)
            let beforeClose = try await control(fixture.url, "fixture-context-status", session: session)
            let beforeRequests = try XCTUnwrap(beforeClose["requests"] as? [[String: Any]])
            XCTAssertFalse(
                beforeRequests.contains { $0["method"] as? String == "DELETE" },
                "An unrelated roster never consumes or withdraws our code"
            )
            try DesktopAccessibilityDriver.press("phone-pairing-done", in: content)
            try await wait { window.attachedSheet == nil }
            if scenario == "active" || scenario == "many" {
                try await wait {
                    let status = try await self.control(fixture.url, "fixture-context-status", session: session)
                    let requests = try XCTUnwrap(status["requests"] as? [[String: Any]])
                    return requests.contains { $0["method"] as? String == "DELETE" && $0["path"] as? String == "/admin/devices/pair" }
                }
            }
            let status = try await control(fixture.url, "fixture-context-status", session: session)
            let requests = try XCTUnwrap(status["requests"] as? [[String: Any]])
            let writes = requests.filter { $0["method"] as? String != "GET" }
            XCTAssertEqual(
                writes.compactMap { $0["method"] as? String },
                scenario == "initial" ? [] : scenario == "error" ? ["POST"] : ["POST", "POST", "POST", "DELETE"]
            )
            XCTAssertEqual(
                writes.compactMap { $0["path"] as? String },
                scenario == "initial" ? [] : scenario == "error" ? ["/admin/devices/pair"] : [
                    "/admin/devices/pair",
                    "/admin/devices/pair-addresses",
                    "/admin/devices/pair-qr",
                    "/admin/devices/pair",
                ]
            )
            if scenario != "initial" {
                XCTAssertEqual((writes.first?["body"] as? [String: Any])?["kind"] as? String, "ios")
            }
            if scenario == "active" || scenario == "many" {
                let qr = try XCTUnwrap(writes.first { $0["path"] as? String == "/admin/devices/pair-qr" })
                let body = try XCTUnwrap(qr["body"] as? [String: Any])
                XCTAssertEqual(body["pairingCode"] as? String, "fictional-owned-code")
                XCTAssertEqual(body["gatewayUrl"] as? String, "https://library.example.com")
            }
            if let deletion = writes.last, deletion["method"] as? String == "DELETE" {
                XCTAssertEqual((deletion["body"] as? [String: Any])?["pairingCode"] as? String, "fictional-owned-code")
            }
        } catch {
            window.close()
            context.invalidate()
            await context.drain()
            throw error
        }
        window.close()
        context.invalidate()
        await context.drain()
    }
}
