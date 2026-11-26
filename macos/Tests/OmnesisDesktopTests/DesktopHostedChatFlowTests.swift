// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import CryptoKit
import Darwin
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

/// Drives the mounted production controls in their own process against an isolated HTTP/SSE fixture.
/// This qualifies the conversation UI and transport; it does not simulate successful runtime setup.
@MainActor
final class DesktopHostedChatFlowTests: XCTestCase {
    private var stage = "starting the owned fixture"
    private weak var ownedWindow: NSWindow?
    private weak var ownedFixture: ScriptedAgentFixture?
    private weak var ownedStore: DesktopStore?
    func testActualAskControlsStreamCompleteAndCancelThroughHTTP() async throws {
        let fixture = try await ScriptedAgentFixture.start()
        ownedFixture = fixture
        defer { fixture.writeEvidence()
            fixture.stop()
            ownedFixture = nil
        }
        let connectionData = try JSONSerialization.data(withJSONObject: [
            "url": fixture.url.absoluteString, "token": "gui-fixture-token",
        ])
        let connection = try JSONDecoder().decode(DesktopConnection.self, from: connectionData)
        DesktopActionRouter.shared.question = nil
        let store = DesktopStore(startRuntime: false)
        ownedStore = store
        defer { ownedStore = nil }
        store.state = try JSONDecoder().decode(DesktopState.self, from: JSONSerialization.data(withJSONObject: [
            "phase": "ready", "mode": "home", "encrypted": true,
            "connection": ["url": fixture.url.absoluteString, "token": "gui-fixture-token"],
        ]))
        store.api = try DesktopAPI(connection: connection)
        let hosting = NSHostingView(rootView: DesktopRootView().environment(store))
        hosting.frame = NSRect(x: 0, y: 0, width: 1080, height: 740)
        let window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = hosting
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
        ownedWindow = window
        defer { window.close()
            ownedWindow = nil
        }

        stage = "opening the event stream"
        try await wait { try await fixture.status().streams == 1 }
        try await capture(window, name: "hosted-chat-initial")
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        stage = "finding the actual input control"
        try await wait { (try? DesktopAccessibilityDriver.element("chat-input", in: hosting)) != nil }
        try DesktopAccessibilityDriver.type("Summarize the fictional fixture", into: "chat-input", in: hosting)
        stage = "enabling Send after actual input"
        try await wait { try DesktopAccessibilityDriver.element("chat-send", in: hosting).isAccessibilityEnabled() }
        try await capture(window, name: "hosted-chat-ready-to-send")
        try DesktopAccessibilityDriver.press("chat-send", in: hosting)
        stage = "rendering an answer received over HTTP and SSE"
        try await wait {
            let status = try await fixture.status()
            return try status.sends == 1 && (DesktopAccessibilityDriver.contains("The fictional", in: hosting))
        }
        XCTAssertTrue(try DesktopAccessibilityDriver.element("chat-stop", in: hosting).isAccessibilityEnabled())
        try await capture(window, name: "hosted-chat-streaming")

        try await fixture.complete()
        stage = "rendering the completed transcript"
        try await wait { try DesktopAccessibilityDriver.contains(
            "Example reference: PROJECT-42",
            in: hosting
        ) }
        let exactAnswer = "Example reference: PROJECT-42"
        let matchTypes = try DesktopAccessibilityDriver.elements(in: hosting).compactMap { element -> String? in
            guard element.accessibilityTextValue()?.contains(exactAnswer) == true,
                  let value = element.accessibilityValue() else { return nil }
            return String(reflecting: Swift.type(of: value))
        }
        try matchTypes.joined(separator: "\n").write(
            to: URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots/completed-answer-accessibility-value-types.txt"),
            atomically: true, encoding: .utf8
        )
        stage = "finishing the visible streaming controls"
        try await wait { (try? DesktopAccessibilityDriver.element("chat-stop", in: hosting)) == nil }
        let historyRequests = try await fixture.status().historyRequests
        stage = "opening conversation history"
        try DesktopAccessibilityDriver.press("chat-history", in: hosting)
        stage = "showing history fetched after opening it"
        try await wait {
            let status = try await fixture.status()
            return try status.historyRequests > historyRequests && DesktopAccessibilityDriver.contains(
                "Fictional conversation",
                in: hosting
            )
        }
        XCTAssertTrue(
            try DesktopAccessibilityDriver.contains("Fictional conversation", in: hosting),
            "A newly saved answer must appear in actual conversation history"
        )
        XCTAssertTrue(try DesktopAccessibilityDriver.contains("Conversations", in: hosting))
        XCTAssertEqual(
            try DesktopAccessibilityDriver.element("chat-history-refresh", in: hosting).accessibilityLabel(), "Refresh history"
        )
        stage = "checking setup banner reserves space above the brand and history controls"
        DesktopSnapshotRenderer.assertOwnedWindowChrome(window)
        try DesktopSnapshotRenderer.writeOwnedLayoutFacts(window, name: "hosted-history-banner")
        try DesktopSnapshotRenderer.assertRequiredBannerLayout(hosting, below: ["library-brand-title", "chat-history-refresh"])
        try await capture(window, name: "hosted-chat-history")
        stage = "closing conversation history"
        try DesktopAccessibilityDriver.press("chat-history", in: hosting)
        try await capture(window, name: "hosted-chat-complete")
        stage = "opening a genuinely cited document"
        try await wait { (try? DesktopAccessibilityDriver.element("chat-evidence", in: hosting)) != nil }
        try DesktopAccessibilityDriver.press("chat-evidence", in: hosting)
        stage = "listing the cited document"
        try await wait { (try? DesktopAccessibilityDriver.element("chat-document-fictional-document", in: hosting)) != nil }
        try DesktopAccessibilityDriver.press("chat-document-fictional-document", in: hosting)
        stage = "reading the chosen cited document"
        try await wait { try DesktopAccessibilityDriver.contains("Original project note", in: hosting) }
        let readStatus = try await fixture.status()
        XCTAssertEqual(readStatus.documentReads, 1)
        try DesktopAccessibilityDriver.press("chat-document-done", in: hosting)
        // Collapse the optional inspector before qualifying the reading column at minimum size.
        try DesktopAccessibilityDriver.press("chat-evidence", in: hosting)
        window.appearance = NSAppearance(named: .darkAqua)
        try await Task.sleep(for: .milliseconds(100))
        try await DesktopSnapshotRenderer.captureOwnedWindow(
            window,
            output: URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots"),
            name: "hosted-chat-complete",
            appearance: .darkAqua
        )
        hosting.frame = NSRect(x: 0, y: 0, width: 860, height: 600)
        window.setContentSize(hosting.frame.size)
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        stage = "reading earlier messages without a floating jump control"
        func scrollViews(_ view: NSView) -> [NSScrollView] {
            (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap { scrollViews($0) }
        }
        let transcriptScroll = try XCTUnwrap(scrollViews(hosting).filter {
            $0.documentView?.bounds.height ?? 0 > $0.contentView.bounds.height + 40
        }.max { $0.contentView.bounds.width < $1.contentView.bounds.width })
        let document = try XCTUnwrap(transcriptScroll.documentView)
        let viewportBeforeJumpVisibility = transcriptScroll.contentView.bounds.height
        try await DesktopScrollInput.scrollUp(transcriptScroll, in: window, evidence: "hosted-chat-local-scroll")
        try await wait {
            let pixel = 1 / window.backingScaleFactor
            let atTop = document.isFlipped
                ? abs(document.visibleRect.minY - document.bounds.minY) <= pixel
                : abs(document.visibleRect.maxY - document.bounds.maxY) <= pixel
            return atTop && (try? DesktopAccessibilityDriver.element("chat-jump-latest", in: hosting)) != nil
        }
        XCTAssertEqual(
            transcriptScroll.contentView.bounds.height,
            viewportBeforeJumpVisibility,
            accuracy: 1 / window.backingScaleFactor,
            "Showing Jump must not resize the transcript viewport"
        )
        let jumpFrame = try DesktopAccessibilityDriver.element("chat-jump-latest", in: hosting).accessibilityFrame()
        let transcriptFrame = transcriptScroll.convert(transcriptScroll.bounds, to: nil)
        let transcriptScreen = window.convertToScreen(transcriptFrame)
        let composerFrame = try DesktopAccessibilityDriver.element("chat-input", in: hosting).accessibilityFrame()
        XCTAssertLessThanOrEqual(jumpFrame.maxY, transcriptScreen.minY + 1, "Jump must not overlap readable transcript")
        XCTAssertGreaterThanOrEqual(jumpFrame.minY, composerFrame.maxY, "Jump must stay above the composer")
        let sendsBeforeJump = try await fixture.status().sends
        try await DesktopSnapshotRenderer.captureOwnedWindow(
            window,
            output: URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots"),
            name: "hosted-chat-minimum",
            appearance: .darkAqua
        )
        try DesktopAccessibilityDriver.press("chat-jump-latest", in: hosting)
        try await wait { (try? DesktopAccessibilityDriver.element("chat-jump-latest", in: hosting)) == nil }
        XCTAssertEqual(
            transcriptScroll.contentView.bounds.height,
            viewportBeforeJumpVisibility,
            accuracy: 1 / window.backingScaleFactor,
            "Hiding Jump must not resize the transcript viewport"
        )
        let sendsAfterJump = try await fixture.status().sends
        XCTAssertEqual(sendsAfterJump, sendsBeforeJump, "Scrolling must not send another question")
        let remaining = document.isFlipped
            ? document.bounds.maxY - transcriptScroll.contentView.bounds.maxY
            : transcriptScroll.contentView.bounds.minY
        XCTAssertLessThanOrEqual(remaining, 44, "Jump must return the real scroll view to the latest message")
        window.setContentSize(NSSize(width: 1080, height: 740))

        try DesktopAccessibilityDriver.type("Start another fictional answer", into: "chat-input", in: hosting)
        stage = "enabling Send after actual input"
        try await wait { try DesktopAccessibilityDriver.element("chat-send", in: hosting).isAccessibilityEnabled() }
        try DesktopAccessibilityDriver.press("chat-send", in: hosting)
        stage = "rendering an answer received over HTTP and SSE"
        try await wait {
            let status = try await fixture.status()
            return try status.sends == 2 && (DesktopAccessibilityDriver.contains("Another fictional", in: hosting))
        }
        try DesktopAccessibilityDriver.press("chat-stop", in: hosting)
        stage = "cancelling the actual gateway request"
        try await wait { try await fixture.status().cancels == 1 }
        stage = "finishing the cancelled streaming controls"
        try await wait { (try? DesktopAccessibilityDriver.element("chat-stop", in: hosting)) == nil }
        stage = "labelling the interrupted answer"
        try await wait { try DesktopAccessibilityDriver.contains("Response stopped", in: hosting) }
        let status = try await fixture.status()
        XCTAssertGreaterThanOrEqual(status.creates, 2, "Completed answers must reload the persisted conversation")
        XCTAssertEqual(status.sends, 2, "No automatic resend may duplicate a user's message")
        XCTAssertEqual(status.cancels, 1)
        XCTAssertEqual(status.unauthorized, 0)
        XCTAssertTrue(status.messages
            .contains { $0.role == "user" && $0.parts.contains { $0.text == "Summarize the fictional fixture" } })
        try await capture(window, name: "hosted-chat-cancelled")
    }

    private func wait(_ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(8)
        while ContinuousClock.now < deadline {
            if try await condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        writeNativeEvidence()
        if let fixture = ownedFixture {
            _ = try? await fixture.status()
            fixture.writeEvidence(name: "hosted-chat-timeout-before-display")
        }
        if let window = ownedWindow { try? await capture(window, name: "hosted-chat-failure") }
        if let fixture = ownedFixture {
            _ = try? await fixture.status()
            fixture.writeEvidence(name: "hosted-chat-timeout-after-display")
        }
        throw ScriptedAgentFixture.Failure("The actual user flow did not reach: \(stage)")
    }

    private func writeNativeEvidence() {
        guard let store = ownedStore else { return }
        let fields: [String: Any] = [
            "stage": stage,
            "historyCount": store.conversations.count,
            "historyFailure": store.conversationHistoryFailure as Any? ?? NSNull(),
            "applicationActive": NSApp.isActive,
            "ownedWindowKey": ownedWindow?.isKeyWindow ?? false,
            "ownedWindowVisible": ownedWindow?.isVisible ?? false,
            "ownedWindowChildCount": ownedWindow?.childWindows?.count ?? 0,
        ]
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        if let bytes = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) {
            try? bytes.write(to: output.appendingPathComponent("hosted-chat-native-state.txt"))
        }
    }

    private func capture(_ window: NSWindow, name: String) async throws {
        writeNativeEvidence()
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try await DesktopSnapshotRenderer.captureOwnedWindow(window, output: output, name: name, appearance: .aqua)
    }
}

@MainActor
final class ScriptedAgentFixture {
    struct Status: Codable {
        let sends: Int
        let creates: Int
        let documentReads: Int
        let historyRequests: Int
        let cancels: Int
        let unauthorized: Int
        let streams: Int
        let messages: [Message]
        struct Message: Codable {
            let role: String
            let parts: [Part]
            struct Part: Codable { let text: String? }
        }
    }

    struct Metadata: Decodable {
        let format: Int
        let owner: String
        let nodeVersion: String
        let executableSha256: String
    }

    struct Failure: Error { let message: String
        init(_ message: String) {
            self.message = message
        }
    }

    let root: URL
    let process: Process
    let closed: DispatchSemaphore
    let url: URL
    private let session = URLSession(configuration: .ephemeral)
    private var latestStatus: Status?
    private init(root: URL, process: Process, closed: DispatchSemaphore, url: URL) {
        self.root = root
        self.process = process
        self.closed = closed
        self.url = url
    }

    static func start() async throws -> ScriptedAgentFixture {
        let macos = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixture = macos.appendingPathComponent(".node-fixture", isDirectory: true)
        let node = fixture.appendingPathComponent("node")
        let metadata = try JSONDecoder().decode(Metadata.self, from: Data(contentsOf: fixture.appendingPathComponent("node-fixture.json")))
        guard metadata.format == 1, metadata.owner == "omnesis-desktop-node-test-fixture", metadata.nodeVersion.hasPrefix("24.") else {
            throw Failure("The pinned Node test fixture is unavailable")
        }
        let handle = try FileHandle(forReadingFrom: node)
        defer { try? handle.close() }
        var hash = SHA256()
        while let bytes = try handle.read(upToCount: 1024 * 1024), !bytes.isEmpty {
            hash.update(data: bytes)
        }
        guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == metadata.executableSha256 else {
            throw Failure("The pinned Node test fixture failed integrity verification")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-gui-fixture-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let process = Process(), closed = DispatchSemaphore(value: 0)
        process.executableURL = node
        process.arguments = [macos.appendingPathComponent("Tests/Support/scripted-agent.mjs").path]
        process.currentDirectoryURL = root
        process.environment = ["PATH": "/usr/bin:/bin", "HOME": root.path, "TMPDIR": root.path, "OMNESIS_GUI_FIXTURE_ROOT": root.path]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in closed.signal() }
        try process.run()
        do {
            let deadline = ContinuousClock.now + .seconds(5)
            while ContinuousClock.now < deadline {
                if let bytes = try? Data(contentsOf: root.appendingPathComponent("endpoint.json")),
                   let endpoint = try JSONSerialization.jsonObject(with: bytes) as? [String: Int],
                   let port = endpoint["port"], (1024 ... 65535).contains(port) {
                    return ScriptedAgentFixture(root: root, process: process, closed: closed, url: URL(string: "http://127.0.0.1:\(port)")!)
                }
                guard process.isRunning else { throw Failure("The owned HTTP fixture exited before listening") }
                try await Task.sleep(for: .milliseconds(25))
            }
            throw Failure("The owned HTTP fixture did not listen within its startup bound")
        } catch {
            let owned = ScriptedAgentFixture(root: root, process: process, closed: closed, url: URL(string: "http://127.0.0.1:1")!)
            owned.stop()
            throw error
        }
    }

    func status() async throws -> Status {
        let bytes = try await request("fixture-status", method: "GET")
        let status = try JSONDecoder().decode(Status.self, from: bytes)
        latestStatus = status
        return status
    }

    func complete() async throws {
        _ = try await request("fixture-complete", method: "POST")
        // Retain the observed terminal HTTP state even if a later accessibility check fails.
        _ = try await status()
    }

    private func request(_ path: String, method: String) async throws -> Data {
        var request = URLRequest(url: url.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 3
        request.setValue("Bearer gui-fixture-token", forHTTPHeaderField: "Authorization")
        let (bytes, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Failure("The isolated HTTP fixture refused the request") }
        return bytes
    }

    func writeEvidence(name: String = "hosted-chat-http-status") {
        guard let latestStatus else { return }
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        if let bytes = try? JSONEncoder().encode(latestStatus) {
            try? bytes.write(to: output.appendingPathComponent(name + ".txt"))
        }
    }

    func stop() {
        session.invalidateAndCancel()
        if process.isRunning { process.terminate() }
        if closed.wait(timeout: .now() + 2) == .timedOut {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            guard closed.wait(timeout: .now() + 2) == .success else {
                XCTFail("The owned HTTP fixture did not exit; its directory was retained")
                return
            }
        }
        try? FileManager.default.removeItem(at: root)
    }
}
