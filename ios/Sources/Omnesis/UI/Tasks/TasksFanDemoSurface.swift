// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The Tasks screen over `TasksDemoGateway`, for the UI tests that drive it
/// on the simulator (`DEMO_MENU_REVEAL=tasks`): the circle, the long-press
/// fan, Done + note, Undo, suggestions and their fan, the review banner,
/// details, the tabs, the bar's Tell Omnesis button and Chat about this, each
/// checked by what the screen shows afterwards. It sits inside the same
/// `MenuRevealContainer` as the real app, because a long press negotiates
/// with that container and with the list's scrolling. No gateway is needed.
@available(iOS 17.0, *)
struct TasksFanDemoSurface: View {
    @Binding var menuOpen: Bool
    @State private var gateway: TasksDemoGateway
    @State private var model: TasksModel
    /// Holds the chat a task's Chat about this opened.
    @State private var store = AppStore.preview()
    /// Whether the chat is on screen in place of Tasks, as the app shell
    /// switches to the Agent section.
    @State private var chatting = false
    @State private var focus: TaskFocusRequest?
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
        let gateway = TasksDemoGateway(tasks: Self.tasks, now: PreviewMocks.tasksNow)
        self._gateway = State(initialValue: gateway)
        self._model = State(initialValue: TasksModel(service: gateway, now: { PreviewMocks.tasksNow }))
        // Done + note and Tell Omnesis open the capture screen, which would
        // otherwise ask for the microphone over the test.
        SpeechRecognizer.permissionRequestsDisabledForSnapshots = true
    }

    var body: some View {
        ZStack {
            if chatting {
                AgentView(menuOpen: $menuOpen)
            } else {
                TasksScreen(
                    model: model,
                    experimental: true,
                    menuOpen: $menuOpen,
                    focus: focus,
                    openConversation: { id in Task { await openConversation(id) } }
                )
                .consumingTaskTargets(store.notificationRouter, into: $focus)
            }
            if capturing {
                CaptureView(surface: .app, onClose: { capturing = false })
                    .transition(.move(edge: .bottom))
            }
        }
        .animation(.easeInOut(duration: 0.28), value: capturing)
        .environment(store)
        .environment(store.notificationRouter)
        .environment(\.openCapture) { capturing = true }
        // The chat's task card asks for its task; Tasks takes it, as the
        // app shell's section switch does.
        .onChange(of: store.notificationRouter.pendingTarget) { _, target in
            if case .task = target { chatting = false }
        }
    }

    /// Shows the chat the gateway just started. The app shell resumes it from
    /// the gateway; here the conversation the demo gateway answered is put on
    /// screen as the coordinator would hold it once resumed.
    private func openConversation(_ id: String) async {
        guard let summary = await gateway.conversation(id: id) else { return }
        var seed = AppStore.AgentPreviewSeed()
        seed.sessionId = summary.sessionId
        seed.title = summary.title
        seed.origin = summary.origin
        seed.connected = true
        store.installAgentPreview(seed)
        chatting = true
    }
}
#endif
