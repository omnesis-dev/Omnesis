// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The Tasks screen over `TasksDemoGateway`, for the UI tests that drive it
/// on the simulator (`DEMO_MENU_REVEAL=tasks`): the circle, the long-press
/// fan, Done + note, Undo, suggestions and their fan, the review banner,
/// details, the tabs and the bar's Tell Omnesis button, each checked by what
/// the screen shows afterwards. It sits inside the same
/// `MenuRevealContainer` as the real app, because a long press negotiates
/// with that container and with the list's scrolling. No gateway is needed.
@available(iOS 17.0, *)
struct TasksFanDemoSurface: View {
    @Binding var menuOpen: Bool
    @State private var model = TasksModel(
        service: TasksDemoGateway(tasks: Self.tasks, now: PreviewMocks.tasksNow),
        now: { PreviewMocks.tasksNow }
    )
    /// Whether Tell Omnesis is up. The app shell presents it the same way:
    /// the capture rises over the section from `openCapture`.
    @State private var capturing = false

    /// Today's page, a Month long enough to scroll, and enough suggestions
    /// that the lowest has room for its fan above it.
    static let tasks: [TaskRecord] = PreviewMocks.tasksToday + PreviewMocks.tasksMonth + PreviewMocks.tasksSuggestedLong
        + (1 ... 12).map { index in
            TaskRecord(id: "loop_demo_\(index)", title: "Fixture task \(index)", scheduledFor: "2026-10")
        }

    init(menuOpen: Binding<Bool>) {
        self._menuOpen = menuOpen
        // Done + note and Tell Omnesis open the capture screen, which would
        // otherwise ask for the microphone over the test.
        SpeechRecognizer.permissionRequestsDisabledForSnapshots = true
    }

    var body: some View {
        ZStack {
            TasksScreen(model: model, experimental: true, menuOpen: $menuOpen)
            if capturing {
                CaptureView(surface: .app, onClose: { capturing = false })
                    .transition(.move(edge: .bottom))
            }
        }
        .animation(.easeInOut(duration: 0.28), value: capturing)
        .environment(\.openCapture) { capturing = true }
    }
}
#endif
