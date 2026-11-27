// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation
@testable import OmnesisDesktop
import SwiftUI
import XCTest

private final class AskModelFixtureProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var available = false, status = 200, postCount = 0, getCount = 0
    static var modelAvailable: Bool {
        get { lock.withLock { available } } set { lock.withLock { available = newValue } }
    }

    static var modelStatus: Int {
        get { lock.withLock { status } } set { lock.withLock { status = newValue } }
    }

    static var posts: Int {
        get { lock.withLock { postCount } } set { lock.withLock { postCount = newValue } }
    }

    static var modelGets: Int {
        lock.withLock { getCount }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard request.url?.host == "localhost", request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token" else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        if request.httpMethod == "POST" { Self.lock.withLock { Self.postCount += 1 } }
        guard request.url?.path == "/agent/model" || request.url?.path == "/admin/models" else {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        Self.lock.withLock { Self.getCount += 1 }
        let available = Self.modelAvailable
        let display: [String: Any] = [
            "providerId": "fixture",
            "providerLabel": "Scripted provider",
            "modelName": available ? "Fictional model" : "",
            "available": available,
            "configured": available,
        ]
        let object: [String: Any] = request.url?.path == "/agent/model" ? display : [
            "assignmentDisplays": ["agent": display], "capabilities": [], "inference": [
                "backends": [:],
                "assignments": ["agent": ["kind": available ? "local" : "unresolved", "available": available]],
            ], "catalog": [], "installed": [],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { client?.urlProtocol(
            self,
            didFailWithError: URLError(.cannotParseResponse)
        )
        return
        }
        client?.urlProtocol(
            self,
            didReceive: HTTPURLResponse(
                url: request.url!,
                statusCode: Self.modelStatus,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!,
            cacheStoragePolicy: .notAllowed
        )
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class AskViewportFrameChanges: @unchecked Sendable {
    private let lock = NSLock()
    private var heights: [CGFloat] = []
    func reset(_ height: CGFloat) {
        lock.withLock { heights = [height] }
    }

    func record(_ height: CGFloat) {
        lock.withLock { if heights.last != height { heights.append(height) } }
    }

    var observedHeights: [CGFloat] {
        lock.withLock { heights }
    }
}

private final class DesktopChatScrollObservationCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var observations: [DesktopChatScrollObservation] = []
    private var dropped = 0
    func observe(_ value: DesktopChatScrollObservation) {
        lock.withLock {
            if observations.count < 4096 { observations.append(value) } else { dropped += 1 }
        }
    }

    var value: (observations: [DesktopChatScrollObservation], dropped: Int) {
        lock.withLock { (observations, dropped) }
    }
}

@MainActor
final class DesktopAskStateTests: XCTestCase {
    func testJumpVisibilityKeepsActualViewportStableThroughScrollAndResize() async throws {
        try await runJumpViewportScenario(instrumented: false)
    }

    func testJumpVisibilityWithConsumerObservationKeepsActualViewportStableThroughScrollAndResize() async throws {
        try await runJumpViewportScenario(instrumented: true)
    }

    private func runJumpViewportScenario(instrumented: Bool) async throws {
        let variant = instrumented ? "instrumented" : "plain"
        let chat = DesktopChat()
        chat.rows = (0 ..< 30).map { index in
            DesktopChat.Row(
                id: "fixture-row-\(index)",
                role: "assistant",
                text: "Fictional project note \(index). This invented paragraph describes a draft, its review, and the next planning step. It contains enough text to exercise real wrapping and scrolling."
            )
        }
        let observation = DesktopChatScrollObservationCapture()
        let sink: (@Sendable (DesktopChatScrollObservation) -> Void)? = if instrumented {
            { @Sendable (value: DesktopChatScrollObservation) in observation.observe(value) }
        } else {
            nil
        }
        let hosting = NSHostingView(rootView: DesktopAskView(initialChat: chat, scrollObservation: sink)
            .environment(DesktopStore.preview()))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 860, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        defer { chat.detach()
            window.close()
        }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        func views(_ view: NSView) -> [NSScrollView] {
            (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap { views($0) }
        }
        var facts: [[String: Any]] = []
        var mappedScroll: NSScrollView?
        var reachedAtDeadline: Bool?
        func rectangle(_ rect: NSRect) -> [String: Double] {
            ["x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)]
        }
        func screenFrame(_ view: NSView) -> NSRect {
            window.convertToScreen(view.convert(view.bounds, to: nil))
        }
        func writeFacts(_ stage: String) throws {
            let captured = observation.value
            let elements = try? DesktopAccessibilityDriver.elements(in: hosting)
            let transcript = elements?.first { $0.accessibilityIdentifier() == "chat-transcript" }
            let jump = elements?.first { $0.accessibilityIdentifier() == "chat-jump-latest" }
            let latestGeometry = captured.observations.last { $0.kind == .geometry }
            let raw = latestGeometry?.raw
            let normalized = raw?.normalized(displayScale: window.backingScaleFactor)
            func geometry(_ value: DesktopChatScrollGeometry?) -> Any {
                guard let value else { return NSNull() }
                return ["contentEnd": value.contentEnd as Any? ?? NSNull(), "viewportHeight": value.viewportHeight as Any? ?? NSNull()]
            }
            let trace: [[String: Any]] = captured.observations.enumerated().map { index, event in
                [
                    "sequence": index,
                    "kind": event.kind.rawValue,
                    "raw": geometry(event.raw),
                    "prior": geometry(event.prior),
                    "candidate": geometry(event.candidate),
                    "decision": event.decision?.rawValue as Any? ?? NSNull(),
                    "displayScale": event.displayScale as Any? ?? NSNull(),
                    "evaluatedGeometry": geometry(event.prior),
                    "evaluatedFollowsLatest": event.followsLatest as Any? ?? NSNull(),
                    "evaluatedSelectsJump": event.followsLatest.map { !$0 } as Any? ?? NSNull(),
                ]
            }
            let candidates: [[String: Any]] = views(hosting).map { scroll in
                [
                    "nativeIdentifier": DesktopAccessibilityDriver.Element(object: scroll).accessibilityIdentifier() as Any? ?? NSNull(),
                    "windowMatches": scroll.window === window,
                    "mappedTarget": scroll === mappedScroll,
                    "frameInScreen": rectangle(screenFrame(scroll)),
                    "clipBounds": rectangle(scroll.contentView.bounds),
                    "documentBounds": scroll.documentView.map { rectangle($0.bounds) } as Any? ?? NSNull(),
                    "documentVisibleRect": scroll.documentView.map { rectangle($0.visibleRect) } as Any? ?? NSNull(),
                    "documentIsFlipped": scroll.documentView.map(\.isFlipped) as Any? ?? NSNull(),
                    "nativeEndGap": scroll.documentView.map {
                        $0.isFlipped ? $0.bounds.maxY - scroll.contentView.bounds.maxY : scroll.contentView.bounds.minY - $0.bounds.minY
                    } as Any? ?? NSNull(),
                ]
            }
            facts.append([
                "stage": stage,
                "variant": variant,
                "consumerObservationCount": captured.observations.count,
                "consumerObservationDropped": captured.dropped,
                "waitReachedBeforeDiagnostics": reachedAtDeadline as Any? ?? NSNull(),
                "rawContentEnd": raw?.contentEnd as Any? ?? NSNull(),
                "rawViewportHeight": raw?.viewportHeight as Any? ?? NSNull(),
                "windowDisplayScale": window.backingScaleFactor,
                "nearLatestAtWindowScale": normalized?.nearLatest as Any? ?? NSNull(),
                "jumpFrameInScreen": jump.map { rectangle($0.accessibilityFrame()) } as Any? ?? NSNull(),
                "nativeCandidates": candidates,
                "axTranscriptIdentifier": transcript?.accessibilityIdentifier() as Any? ?? NSNull(),
                "axFrameInScreen": transcript.map { rectangle($0.accessibilityFrame()) } as Any? ?? NSNull(),
                "axEnumerationSucceeded": elements != nil,
                "jumpPresent": elements
                    .map { $0.contains { $0.accessibilityIdentifier() == "chat-jump-latest" } } as Any? ?? NSNull(),
            ])
            let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: facts, options: [.sortedKeys])
                .write(to: output.appendingPathComponent("chat-viewport-\(variant)-regression-state.txt"))
            if instrumented {
                try JSONSerialization.data(withJSONObject: ["observations": trace, "dropped": captured.dropped], options: [.sortedKeys])
                    .write(to: output.appendingPathComponent("chat-viewport-\(variant)-consumer-observations.txt"))
            }
        }
        func wait(_ stage: String, _ predicate: () -> Bool) async throws {
            reachedAtDeadline = nil
            try writeFacts("before-" + stage)
            let deadline = ContinuousClock.now + .seconds(3)
            while !predicate(), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            let reached = predicate()
            reachedAtDeadline = reached
            try writeFacts("after-" + stage)
            if !reached {
                hosting.layoutSubtreeIfNeeded()
                hosting.displayIfNeeded()
                let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
                hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
                let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
                try png.write(to: output.appendingPathComponent("chat-viewport-\(variant)-failure-\(facts.count).png"))
            }
            XCTAssertTrue(reached, "The actual viewport did not reach: " + stage)
        }
        hosting.layoutSubtreeIfNeeded()
        try await wait("initial-overflow") {
            views(hosting).contains { ($0.documentView?.bounds.height ?? 0) > $0.contentView.bounds.height + 40 }
        }
        let transcriptAX = try DesktopAccessibilityDriver.element("chat-transcript", in: hosting)
        let pixel = 1 / window.backingScaleFactor
        func matches(_ first: NSRect, _ second: NSRect) -> Bool {
            abs(first.minX - second.minX) <= pixel && abs(first.minY - second.minY) <= pixel &&
                abs(first.width - second.width) <= pixel && abs(first.height - second.height) <= pixel
        }
        XCTAssertGreaterThan(transcriptAX.accessibilityFrame().width, 0)
        XCTAssertGreaterThan(transcriptAX.accessibilityFrame().height, 0)
        try writeFacts("mapping-owned-transcript")
        let candidates = views(hosting).filter { $0.window === window && matches(screenFrame($0), transcriptAX.accessibilityFrame()) }
        XCTAssertEqual(candidates.count, 1, "The owned AX transcript must map to one native scroll view by actual bounds")
        let scroll = try XCTUnwrap(candidates.first)
        let clip = scroll.contentView
        mappedScroll = scroll
        try writeFacts("mapped-owned-transcript")
        let originalNotifications = clip.postsFrameChangedNotifications
        clip.postsFrameChangedNotifications = true
        let changes = AskViewportFrameChanges()
        let observer = NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: clip, queue: .main) { _ in
            MainActor.assumeIsolated { changes.record(clip.bounds.height) }
        }
        defer { NotificationCenter.default.removeObserver(observer)
            clip.postsFrameChangedNotifications = originalNotifications
        }
        var heartbeats = 0
        var growthSerial = 0
        var gestureSerial = 0
        for size in [NSSize(width: 860, height: 600), NSSize(width: 940, height: 680), NSSize(width: 860, height: 600)] {
            window.setContentSize(size)
            hosting.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
            let document = try XCTUnwrap(scroll.documentView)
            func remainingToEnd() -> CGFloat {
                document.isFlipped ? document.bounds.maxY - clip.bounds.maxY : clip.bounds.minY - document.bounds.minY
            }
            func isAtEnd() -> Bool {
                remainingToEnd() <= 44 && (try? DesktopAccessibilityDriver.element("chat-jump-latest", in: hosting)) == nil
            }
            try await wait("native-end-after-initial-layout-or-resize", isAtEnd)
            let height = clip.bounds.height
            changes.reset(height)
            for cycle in 0 ..< 2 {
                gestureSerial += 1
                try writeFacts("before-local-wheel-cycle-\(cycle)")
                try await DesktopScrollInput.scrollUp(scroll, in: window, evidence: "ask-state-\(variant)-scroll-\(gestureSerial)")
                try await wait("physical-top-and-jump-after-local-wheel-cycle-\(cycle)") {
                    let atTop = document.isFlipped
                        ? abs(document.visibleRect.minY - document.bounds.minY) <= pixel
                        : abs(document.visibleRect.maxY - document.bounds.maxY) <= pixel
                    return atTop && (try? DesktopAccessibilityDriver.element("chat-jump-latest", in: hosting)) != nil
                }
                try writeFacts("scrolled-top-cycle-\(cycle)")
                if document.isFlipped {
                    XCTAssertEqual(
                        document.visibleRect.minY,
                        document.bounds.minY,
                        accuracy: pixel,
                        "The real transcript must be at its top"
                    )
                } else {
                    XCTAssertEqual(
                        document.visibleRect.maxY,
                        document.bounds.maxY,
                        accuracy: pixel,
                        "The real transcript must be at its top"
                    )
                }
                XCTAssertNotNil(try DesktopAccessibilityDriver.element("chat-jump-latest", in: hosting))
                XCTAssertEqual(clip.bounds.height, height, accuracy: 1 / window.backingScaleFactor)
                let tail = try XCTUnwrap(chat.rows.indices.last)
                chat.rows[tail].text += " Additional fictional draft text arrives while an earlier note is being read. It must not move the reader away from that note."
                try await Task.sleep(for: .milliseconds(100))
                try writeFacts("stream-growth-while-up-cycle-\(cycle)")
                if document.isFlipped {
                    XCTAssertEqual(document.visibleRect.minY, document.bounds.minY, accuracy: pixel)
                } else {
                    XCTAssertEqual(document.visibleRect.maxY, document.bounds.maxY, accuracy: pixel)
                }
                XCTAssertNotNil(try DesktopAccessibilityDriver.element("chat-jump-latest", in: hosting))
                try DesktopAccessibilityDriver.press("chat-jump-latest", in: hosting)
                try await wait("physical-end-after-jump-cycle-\(cycle)", isAtEnd)
                XCTAssertLessThanOrEqual(remainingToEnd(), 44)
                growthSerial += 1
                let fragment = "Fictional stream fragment \(growthSerial)"
                chat.rows[tail].text += " \(fragment). More response text follows the latest note. The native end target must remain visible as the paragraph grows and wraps across additional lines."
                try await Task.sleep(for: .milliseconds(100))
                try await wait("visible-stream-growth-cycle-\(cycle)") {
                    (try? DesktopAccessibilityDriver.contains(fragment, in: hosting)) == true
                }
                try await wait("physical-end-after-stream-growth-cycle-\(cycle)", isAtEnd)
                XCTAssertLessThanOrEqual(remainingToEnd(), 44)
                for _ in 0 ..< 3 {
                    try await Task.sleep(for: .milliseconds(20))
                    heartbeats += 1
                    XCTAssertEqual(clip.bounds.height, height, accuracy: 1 / window.backingScaleFactor)
                    XCTAssertTrue(isAtEnd(), "Streaming must retain the physical end after layout settles")
                }
            }
            XCTAssertEqual(changes.observedHeights, [height], "Jump visibility must not cause native viewport frame changes")
        }
        XCTAssertEqual(heartbeats, 18, "The mounted main actor must continue processing while scrolling and resizing")
    }

    func testValidatedSettingsUpdateRefreshesMountedAskAndDisablingTheModelBlocksSendAgain() async throws {
        AskModelFixtureProtocol.modelAvailable = false
        AskModelFixtureProtocol.modelStatus = 200
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AskModelFixtureProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let connection = try JSONDecoder().decode(
            DesktopConnection.self,
            from: Data(#"{"url":"http://localhost","token":"fixture-token"}"#.utf8)
        )
        let api = try DesktopAPI(connection: connection, sessionOverride: session)
        let store = DesktopStore(startRuntime: false)
        store.api = api
        let chat = DesktopChat()
        let hosting = NSHostingView(rootView: DesktopAskView(initialChat: chat).environment(store))
        hosting.frame = NSRect(x: 0, y: 0, width: 860, height: 600)
        let window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        defer { chat.detach()
            window.close()
        }
        func wait(_ predicate: () -> Bool) async throws {
            let deadline = ContinuousClock.now + .seconds(3)
            while !predicate(), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertTrue(predicate())
        }
        try await wait { chat.needsModel && !chat.checkingModel }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try DesktopAccessibilityDriver.type("A fictional question", into: "chat-input", in: hosting)
        XCTAssertFalse(try DesktopAccessibilityDriver.element("chat-send", in: hosting).isAccessibilityEnabled())
        let before = AskModelFixtureProtocol.modelGets
        // The Settings path publishes this same validated HTTP overview after saving a model choice.
        AskModelFixtureProtocol.modelAvailable = true
        try await store.observeModelOverview(api.admin.modelOverview())
        try await wait { !chat.needsModel && !chat.checkingModel && chat.model?.available == true }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(try DesktopAccessibilityDriver.element("chat-send", in: hosting).isAccessibilityEnabled())
        XCTAssertTrue(hosting.window === window, "Settings changes must update the existing Ask view")
        AskModelFixtureProtocol.modelAvailable = false
        try await store.observeModelOverview(api.admin.modelOverview())
        try await wait { chat.needsModel && !chat.checkingModel }
        XCTAssertGreaterThan(
            AskModelFixtureProtocol.modelGets,
            before + 2,
            "Ask must independently refresh current API state after each Settings change"
        )
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(try DesktopAccessibilityDriver.element("chat-send", in: hosting).isAccessibilityEnabled())
    }

    func testObservedUnconfiguredModelBlocksSendingAndOffersNativeSetup() async throws {
        AskModelFixtureProtocol.modelAvailable = false
        AskModelFixtureProtocol.modelStatus = 200
        AskModelFixtureProtocol.posts = 0
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AskModelFixtureProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let connection = try JSONDecoder().decode(
            DesktopConnection.self,
            from: Data(#"{"url":"http://localhost","token":"fixture-token"}"#.utf8)
        )
        let api = try DesktopAPI(connection: connection, sessionOverride: session)
        let chat = DesktopChat()
        chat.attach(api)
        defer { chat.detach() }
        await chat.checkModel(api)
        XCTAssertTrue(chat.needsModel)
        chat.input = "A fictional question"
        await chat.send()
        XCTAssertEqual(AskModelFixtureProtocol.posts, 0, "Known missing models must lead to setup before a doomed send")
        try await DesktopSnapshotRenderer.render(
            DesktopAskView(initialChat: chat).environment(DesktopStore(startRuntime: false)), name: "ask-needs-model", size: CGSize(
                width: 860,
                height: 600
            )
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Choose how Omnesis answers", in: view))
            XCTAssertTrue(try DesktopAccessibilityDriver.element("chat-setup-model", in: view).isAccessibilityEnabled())
            XCTAssertFalse(try DesktopAccessibilityDriver.element("chat-send", in: view).isAccessibilityEnabled())
        }
    }

    func testFailedModelCheckDoesNotInventAnUnconfiguredModelOrSendAQuestion() async throws {
        AskModelFixtureProtocol.modelStatus = 503
        AskModelFixtureProtocol.posts = 0
        defer { AskModelFixtureProtocol.modelStatus = 200 }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AskModelFixtureProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let connection = try JSONDecoder().decode(
            DesktopConnection.self,
            from: Data(#"{"url":"http://localhost","token":"fixture-token"}"#.utf8)
        )
        let chat = DesktopChat()
        let api = try DesktopAPI(connection: connection, sessionOverride: session)
        chat.attach(api)
        defer { chat.detach() }
        await chat.checkModel(api)
        XCTAssertNil(chat.model)
        XCTAssertFalse(chat.needsModel, "An outage cannot be treated as proof that no model is configured")
        XCTAssertNotNil(chat.modelCheckFailure)
        chat.input = "A fictional question"
        await chat.send()
        XCTAssertEqual(AskModelFixtureProtocol.posts, 0)
    }

    func testNetworkFailureUsesConversationRepairInsteadOfModelSetup() async throws {
        let chat = DesktopChat()
        chat.failure = "Your connection was interrupted. Reconnecting…"
        try await DesktopSnapshotRenderer.render(
            DesktopAskView(initialChat: chat).environment(DesktopStore(startRuntime: false)),
            name: "ask-network-repair",
            size: CGSize(width: 860, height: 600)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Check connection", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Reopen conversation", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Choose a model", in: view))
        }
        chat.sessionId = "fictional-existing-session"
        try await DesktopSnapshotRenderer.render(
            DesktopAskView(initialChat: chat).environment(DesktopStore(startRuntime: false)),
            name: "ask-existing-conversation-repair",
            size: CGSize(width: 860, height: 600)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Reopen conversation", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Check connection", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Choose a model", in: view))
        }
    }

    func testSearchZeroHitsNamesTheCompletedQueryInsteadOfRepeatingIntroduction() async throws {
        try await DesktopSnapshotRenderer.render(
            DesktopSearchView(initialQuery: "fictional launch", initialCompletedQuery: "fictional launch")
                .environment(DesktopStore(startRuntime: false)),
            name: "search-no-results",
            size: CGSize(width: 860, height: 600)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("No results for", in: view))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("fictional launch", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Search your information", in: view))
        }
    }
}
