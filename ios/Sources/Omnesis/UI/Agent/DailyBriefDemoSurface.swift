// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The Morning brief conversation over `DailyBriefDemoGateway`, for the UI
/// tests that drive it on the simulator (`DEMO_MENU_REVEAL=briefs`): folding
/// and opening days, the "Based on" list, the Retry line, a source chip
/// opening its document and a task chip opening Tasks on that task. A task
/// chip goes through the same router target and the same `homeTab(for:)`
/// mapping as in the app, and Tasks takes it with the same consumer, over
/// `TasksDemoGateway`. No gateway is needed.
@available(iOS 17.0, *)
struct DailyBriefDemoSurface: View {
    @Binding var menuOpen: Bool
    @State private var store = AppStore.preview(agentPreview: PreviewMocks.dailyBriefSeed)
    @State private var section: HomeTab = .agent
    @State private var focus: TaskFocusRequest?
    @State private var tasks = TasksModel(
        service: TasksDemoGateway(tasks: PreviewMocks.dailyBriefTasks, now: PreviewMocks.tasksNow),
        now: { PreviewMocks.tasksNow }
    )
    /// Monday's items fail on the first read, so its Retry line can be driven.
    @State private var context = DailyBriefContext(
        loader: DailyBriefDemoGateway(pages: PreviewMocks.dailyBriefPages, failingOnce: ["2026-10-12"]),
        now: { PreviewMocks.tasksNow }
    )

    init(menuOpen: Binding<Bool>) {
        self._menuOpen = menuOpen
        // The composer's microphone would otherwise ask for permission over the test.
        SpeechRecognizer.permissionRequestsDisabledForSnapshots = true
    }

    var body: some View {
        Group {
            if section == .tasks {
                TasksScreen(model: tasks, experimental: false, menuOpen: $menuOpen, focus: focus)
                    .consumingTaskTargets(store.notificationRouter, into: $focus)
            } else {
                AgentView(menuOpen: $menuOpen)
            }
        }
        .environment(store)
        .environment(store.notificationRouter)
        .environment(\.dailyBriefContext, context)
        .onChange(of: store.notificationRouter.pendingTarget) { _, target in
            if let target { section = homeTab(for: target) }
        }
    }
}
#endif
