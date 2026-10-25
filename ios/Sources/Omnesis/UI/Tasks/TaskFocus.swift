// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// A request to show one task in Tasks with its details open. Each request
/// is distinct, so asking for the same task twice opens it twice.
@available(iOS 17.0, *)
struct TaskFocusRequest: Equatable {
    let taskId: String
    private let token = UUID()

    init(taskId: String) {
        self.taskId = taskId
    }
}

@available(iOS 17.0, *)
extension View {
    /// Takes a `.task` target off the router — set by a task chip elsewhere
    /// in the app — and hands it on as a focus request. Other targets stay
    /// pending for their own sections.
    func consumingTaskTargets(
        _ router: NotificationRouter?,
        into request: Binding<TaskFocusRequest?>
    )
        -> some View {
        modifier(TaskTargetConsumer(router: router, request: request))
    }
}

@available(iOS 17.0, *)
private struct TaskTargetConsumer: ViewModifier {
    let router: NotificationRouter?
    @Binding var request: TaskFocusRequest?

    func body(content: Content) -> some View {
        content
            .onAppear { consume(router?.pendingTarget) }
            .onChange(of: router?.pendingTarget) { _, target in consume(target) }
    }

    private func consume(_ target: PushTarget?) {
        guard let router, case .task(let taskId) = target else { return }
        router.consume()
        request = TaskFocusRequest(taskId: taskId)
    }
}
#endif
