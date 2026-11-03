// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import CoreGraphics
@testable import Omnesis
import SwiftUI
import UIKit
import XCTest

/// The fan a finger drove always closes when the finger lifts — the device
/// bug was a fan left open after a press slid off its targets, which kept the
/// list from scrolling.
@available(iOS 17.0, *)
@MainActor
final class TaskFanControllerTests: XCTestCase {
    private let task = TaskRecord(id: "loop_1", title: "Book the venue tour", scheduledFor: "2026-10-20")
    private let press = CGPoint(x: 290, y: 420)

    private actor PreviewService: TasksService {
        let task: TaskRecord

        init(task: TaskRecord) { self.task = task }

        func view(_ view: TaskViewKind, day: String, limit: Int?, before: String?) async throws -> TaskViewPage {
            TaskViewPage(view: view, day: day, tasks: [task])
        }

        func detail(id: String) async throws -> TaskDetail { throw GatewayClient.Error.notFound }
        func perform(_ action: TaskAction, on id: String) async throws -> TaskMutation { throw GatewayClient.Error.notFound }
        func undo(seq: Int) async throws -> TaskMutation { throw GatewayClient.Error.notFound }
        func startConversation(about id: String) async throws -> ConversationSummary { throw GatewayClient.Error.notFound }
    }

    private final class PreviewObservation {
        let emptyLayout = XCTestExpectation(description: "An empty journal has a viewport")
        let opened = XCTestExpectation(description: "The arriving row opens its chat fan")
        var initialViewport: CGRect?
        var openedLayout: (TaskFanSession, CGRect)?
        private var sawEmptyLayout = false

        func observe(_ session: TaskFanSession?, viewport: CGRect, rowsReady: Bool) {
            guard viewport.width > 0, viewport.height > 0 else { return }
            if !rowsReady {
                initialViewport = viewport
                if !sawEmptyLayout {
                    sawEmptyLayout = true
                    emptyLayout.fulfill()
                }
            } else if let session, openedLayout == nil {
                openedLayout = (session, viewport)
                opened.fulfill()
            }
        }
    }

    func testPreviewOpensWhenRowsArriveAfterTheViewport() async throws {
        for scheme in [ColorScheme.dark, .light] {
            try await assertLatePreview(scheme: scheme)
        }
    }

    private func assertLatePreview(scheme: ColorScheme) async throws {
        let task = TaskRecord(id: "preview-late-row", title: "Fold the paper glider")
        let model = TasksModel(service: PreviewService(task: task))
        let observation = PreviewObservation()
        var preview = TaskFanPreview(taskId: task.id, highlight: .chat)
        preview.onLayout = { session, viewport in
            observation.observe(session, viewport: viewport, rowsReady: !model.tasks.isEmpty)
        }
        let window = previewWindow(model: model, preview: preview, scheme: scheme)
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        await fulfillment(of: [observation.emptyLayout], timeout: 5)
        XCTAssertTrue(model.tasks.isEmpty)
        await model.load()
        await fulfillment(of: [observation.opened], timeout: 5)

        let image = renderPreview(window)
        let directory = URL(fileURLWithPath: "/tmp/omnesis-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("task-fan-late-row-\(scheme).png"))
        let (session, viewport) = try XCTUnwrap(observation.openedLayout)
        XCTAssertEqual(viewport, observation.initialViewport, "The row must open the fan without a viewport resize")
        XCTAssertEqual(session.highlighted, .chat)
        XCTAssertTrue(session.targets.contains { $0.action == .chat })
        for target in session.targets {
            XCTAssertTrue(viewport.contains(target.frame), "\(target.label) is clipped by the visible viewport")
        }
    }

    private func previewWindow(model: TasksModel, preview: TaskFanPreview, scheme: ColorScheme) -> UIWindow {
        let view = NavigationStack {
            TaskJournalPage(model: model, view: .today, offersTell: true, onChat: { _ in }, initialFan: preview)
                .navigationTitle("Tasks")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { TasksToolbar(menuOpen: .constant(false)) }
        }
        .environment(AppStore.preview())
        .preferredColorScheme(scheme)
        .transaction { $0.animation = nil }
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        _ = renderPreview(window)
        return window
    }

    private func renderPreview(_ window: UIWindow) -> UIImage {
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        return UIGraphicsImageRenderer(size: window.bounds.size).image { _ in
            window.rootViewController?.view.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
    }

    private func controller() -> (TaskFanController, () -> [TaskFanAction]) {
        let fan = TaskFanController()
        fan.bounds = CGRect(x: 0, y: 0, width: 393, height: 700)
        var performed: [TaskFanAction] = []
        fan.perform = { action, _ in performed.append(action) }
        return (fan, { performed })
    }

    func testLiftingOffTheTargetsAfterSlidingCloses() throws {
        let (fan, performed) = controller()
        fan.open(task, at: press, today: "2026-10-14")
        let done = try XCTUnwrap(fan.session?.targets.first { $0.action == .done })
        fan.move(done.center)
        fan.move(CGPoint(x: 380, y: 690))
        fan.end(CGPoint(x: 380, y: 690))
        XCTAssertNil(fan.session)
        XCTAssertNil(fan.task)
        XCTAssertEqual(performed(), [])
    }

    func testLiftingOnATargetActsAndCloses() throws {
        let (fan, performed) = controller()
        fan.open(task, at: press, today: "2026-10-14")
        let tomorrow = try XCTUnwrap(fan.session?.targets.first { $0.action == .tomorrow })
        fan.move(tomorrow.center)
        fan.end(tomorrow.center)
        XCTAssertNil(fan.session)
        XCTAssertEqual(performed(), [.tomorrow])
    }

    func testATouchTakenAwayClosesWithoutActing() throws {
        let (fan, performed) = controller()
        fan.open(task, at: press, today: "2026-10-14")
        let done = try XCTUnwrap(fan.session?.targets.first { $0.action == .done })
        fan.move(done.center)
        fan.end(nil)
        XCTAssertNil(fan.session)
        XCTAssertEqual(performed(), [])
    }

    func testARepeatedEndIsHarmless() {
        let (fan, performed) = controller()
        fan.open(task, at: press, today: "2026-10-14")
        fan.end(press)
        fan.end(press)
        fan.end(nil)
        XCTAssertNil(fan.session)
        XCTAssertEqual(performed(), [])
    }

    func testShrinkingViewportDismissesClippedFanWithoutActing() throws {
        let (fan, performed) = controller()
        fan.offersChat = true
        fan.offersTell = true
        fan.updateBounds(CGRect(x: 0, y: 0, width: 402, height: 716))
        fan.open(task, at: CGPoint(x: 289, y: 349), today: "2026-10-14")
        let chat = try XCTUnwrap(fan.session?.targets.first { $0.action == .chat })
        XCTAssertGreaterThan(chat.frame.maxY, 674)
        fan.move(chat.center)
        fan.updateBounds(CGRect(x: 0, y: 0, width: 402, height: 674))
        fan.end(chat.center)
        XCTAssertNil(fan.session)
        XCTAssertNil(fan.task)
        XCTAssertEqual(performed(), [])
    }

    func testViewportChangeKeepsTargetsStillWhenTheyRemainVisible() throws {
        let (fan, performed) = controller()
        fan.open(task, at: press, today: "2026-10-14")
        let original = try XCTUnwrap(fan.session)
        fan.updateBounds(CGRect(x: 0, y: 0, width: 393, height: 690))
        XCTAssertEqual(fan.session?.targets, original.targets)
        XCTAssertEqual(performed(), [])
    }

    /// A fan VoiceOver opened is not the finger's to close.
    func testAFanOpenedForVoiceOverIgnoresAFingerLifting() {
        let (fan, _) = controller()
        fan.rowFrames = [task.id: CGRect(x: 0, y: 380, width: 393, height: 80)]
        fan.openForAccessibility(task, today: "2026-10-14", mode: .main)
        fan.end(press)
        XCTAssertNotNil(fan.session)
        fan.dismiss()
        XCTAssertNil(fan.session)
    }
}
#endif
