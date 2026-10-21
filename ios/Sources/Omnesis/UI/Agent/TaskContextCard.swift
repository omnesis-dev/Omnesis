// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The task a chat is about, rendered as a card pinned above the
/// conversation.
///
/// The chat starts empty — the operator asked to talk about this task and
/// writes the first message — so the card is what says what the
/// conversation is about, from the first screen and whenever it is reopened
/// from the conversation list. Omnesis reads the task as it now stands with
/// every reply; the card is a snapshot taken when the chat was started, so it
/// still renders after the task is renamed, completed or deleted. A tap
/// opens the task in Tasks.
@available(iOS 17.0, *)
struct TaskContextCard: View {
    @Environment(NotificationRouter.self) private var router: NotificationRouter?
    let snapshot: TaskConversationOriginSnapshot
    let taskId: String?
    /// The device's local day, against which the due day is read.
    var today: String = TaskSchedule().day(Date())

    var body: some View {
        if let taskId, !taskId.isEmpty, let router {
            Button {
                router.pendingTarget = .task(taskId: taskId)
            } label: {
                cardBody(showsOpenAffordance: true)
            }
            .buttonStyle(.plain)
            .accessibilityHint(Text("Opens the task"))
            .accessibilityIdentifier("agent.taskContextCard")
        } else {
            cardBody(showsOpenAffordance: false)
                .accessibilityIdentifier("agent.taskContextCard")
        }
    }

    private func cardBody(showsOpenAffordance: Bool) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "checklist")
                    .font(.system(size: 12, weight: .semibold))
                Text("Task")
                    .font(.system(size: 12, weight: .semibold))
                    .textCase(.uppercase)
                    .kerning(0.6)
                Spacer(minLength: 0)
                if showsOpenAffordance {
                    Text("View task")
                        .font(.system(size: 11, weight: .semibold))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                }
            }
            .foregroundStyle(Theme.accent)
            .accessibilityHidden(true)
            Text(snapshot.title)
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            TaskFlowLayout(spacing: 12, lineSpacing: 4) {
                ForEach(snapshot.cardFacts(today: today), id: \.self) { fact in
                    Label(fact.text, systemImage: fact.icon)
                        .labelStyle(TaskCardFactLabelStyle())
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(fact.tone == .danger ? Theme.danger : Theme.textSecondary)
                }
            }
            Text("Omnesis reads this task's notes, history and sources with each reply.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Theme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .fill(Theme.bgSecondary)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .strokeBorder(Theme.border, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        let facts = snapshot.cardFacts(today: today).map(\.text).joined(separator: ", ")
        return "Chat about the task \(snapshot.title). \(facts)"
    }
}

/// An icon tight against its text, smaller than the text.
@available(iOS 17.0, *)
private struct TaskCardFactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("TaskContextCard") {
    TaskContextCard(
        snapshot: PreviewMocks.taskConversationSnapshot,
        taskId: PreviewMocks.taskConversationTaskId,
        today: "2026-10-14"
    )
    .padding()
    .background(Theme.bgPrimary)
    .environment(NotificationRouter())
}

@available(iOS 17.0, *)
#Preview("TaskContextCard — overdue, long title, dark") {
    TaskContextCard(
        snapshot: PreviewMocks.taskConversationSnapshotLong,
        taskId: PreviewMocks.taskConversationTaskId,
        today: "2026-10-14"
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
    .environment(NotificationRouter())
}

@available(iOS 17.0, *)
#Preview("TaskContextCard — done, no due day or sources") {
    TaskContextCard(
        snapshot: PreviewMocks.taskConversationSnapshotDone,
        taskId: PreviewMocks.taskConversationTaskId,
        today: "2026-10-14"
    )
    .padding()
    .background(Theme.bgPrimary)
    .environment(NotificationRouter())
}

@available(iOS 17.0, *)
#Preview("Agent — chat about a task, just started") {
    let store = AppStore.preview(agentPreview: PreviewMocks.taskConversationSeed)
    return AgentView(menuOpen: .constant(false))
        .environment(store)
        .environment(store.notificationRouter)
}

@available(iOS 17.0, *)
#Preview("Agent — chat about a task, answered") {
    let store = AppStore.preview(agentPreview: PreviewMocks.taskConversationAnsweredSeed)
    return AgentView(menuOpen: .constant(false))
        .environment(store)
        .environment(store.notificationRouter)
}

@available(iOS 17.0, *)
#Preview("TaskContextCard — no task id") {
    TaskContextCard(snapshot: PreviewMocks.taskConversationSnapshot, taskId: nil, today: "2026-10-14")
        .padding()
        .background(Theme.bgPrimary)
}
#endif
#endif
