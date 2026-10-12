// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The Tasks screen over `TasksDemoGateway`, for the UI tests that drive it
/// on the simulator (`DEMO_MENU_REVEAL=tasks`): the circle, the long-press
/// fan, Done + note, Undo, suggestions, details and the tabs, each checked by
/// what the screen shows afterwards. It sits inside the same
/// `MenuRevealContainer` as the real app, because a long press negotiates
/// with that container and with the list's scrolling. No gateway is needed.
@available(iOS 17.0, *)
struct TasksFanDemoSurface: View {
    @Binding var menuOpen: Bool
    @State private var model = TasksModel(
        service: TasksDemoGateway(tasks: Self.tasks, now: PreviewMocks.tasksNow),
        now: { PreviewMocks.tasksNow }
    )

    /// Today's page, a Month long enough to scroll, and two suggestions.
    static let tasks: [TaskRecord] = PreviewMocks.tasksToday + PreviewMocks.tasksMonth + PreviewMocks.tasksSuggested
        + (1 ... 12).map { index in
            TaskRecord(id: "loop_demo_\(index)", title: "Fixture task \(index)", scheduledFor: "2026-10")
        }

    init(menuOpen: Binding<Bool>) {
        self._menuOpen = menuOpen
        // Done + note opens the capture screen, which would otherwise ask
        // for the microphone over the test.
        SpeechRecognizer.permissionRequestsDisabledForSnapshots = true
    }

    var body: some View {
        TasksScreen(model: model, experimental: true, menuOpen: $menuOpen)
    }
}
#endif
