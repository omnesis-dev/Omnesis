// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// One task in full, with everything that happened to it, newest first. A
/// change made in a conversation links back to that conversation.
@available(iOS 17.0, *)
struct TaskHistoryView: View {
    let model: TasksModel
    let taskId: String

    @Environment(\.openAgentConversation) private var openAgentConversation
    @State private var detail: TaskDetail?
    @State private var loadError: Error?

    var body: some View {
        Group {
            if let detail {
                TaskHistoryContent(
                    detail: detail,
                    today: model.today,
                    onOpenConversation: openAgentConversation,
                    onUndo: { seq in
                        Task {
                            await model.undo(seq: seq)
                            await load()
                        }
                    }
                )
            } else if let loadError {
                GatewayErrorView(context: "load this task", error: loadError, onRetry: { Task { await load() } })
            } else {
                ProgressView()
                    .tint(Theme.accent)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.inline)
        .devTarget(.openLoop(taskId, label: detail?.task.title))
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            detail = try await model.detail(id: taskId)
            loadError = nil
        } catch {
            loadError = error
        }
    }
}

/// The history page's body, separated from the fetch so a preview renders
/// it from fixtures. A change Omnesis applied on its own offers Undo on its
/// line while it is still the newest change.
@available(iOS 17.0, *)
struct TaskHistoryContent: View {
    let detail: TaskDetail
    let today: String
    var onOpenConversation: ((String) -> Void)?
    var onUndo: ((Int) -> Void)?

    private var schedule: TaskSchedule {
        TaskSchedule()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                header
                FlatSection("History", trailing: "\(detail.history.count)") {
                    if detail.history.isEmpty {
                        Text("Nothing recorded yet.")
                            .font(.subheadline)
                            .foregroundStyle(Theme.textSecondary)
                    } else {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(detail.history) { event in
                                eventRow(event)
                                if event.id != detail.history.last?.id {
                                    Divider().overlay(Theme.borderLight)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md)
        }
        .background(Theme.bgPrimary)
    }

    private var header: some View {
        let task = detail.task
        return VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(task.title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
                .strikethrough(task.isResolved, color: Theme.textMuted)
            if !task.description.isEmpty {
                Text(task.description)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
            }
            VStack(alignment: .leading, spacing: 4) {
                fact("State", stateLabel(task))
                if let planned = schedule.scheduleLabel(task.scheduledFor, today: today) {
                    fact("Planned", planned)
                }
                if let due = schedule.deadlineLabel(task.deadline, dueDay: task.dueDay, today: today) {
                    fact("Deadline", due)
                }
                let people = TaskJournal.people(task)
                if !people.isEmpty { fact("With", people.joined(separator: ", ")) }
                if !task.blockedBy.isEmpty {
                    fact("Waiting on", task.blockedBy.map(\.title).joined(separator: ", "))
                }
                if let note = task.completionNote, !note.isEmpty { fact("Note", note) }
            }
            .padding(.top, Theme.Spacing.xs)
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
            Text(label)
                .font(.footnote)
                .foregroundStyle(Theme.textMuted)
                .frame(minWidth: 72, alignment: .leading)
            Text(value)
                .font(.footnote)
                .foregroundStyle(Theme.textPrimary)
        }
        .accessibilityElement(children: .combine)
    }

    private func stateLabel(_ task: TaskRecord) -> String {
        switch task.state {
        case .done: "Done"
        case .dismissed: "Struck"
        case .snoozed: "Snoozed"
        default: task.isSuggestion ? "Suggested by Omnesis" : "Open"
        }
    }

    private func eventRow(_ event: TaskEvent) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(TaskJournal.eventTitle(event))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                Spacer(minLength: Theme.Spacing.sm)
                if let onUndo, event.seq == TaskJournal.autoAppliedUndoSeq(detail) {
                    Button("Undo") { onUndo(event.seq) }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.accent)
                        .accessibilityHint("Reverts this change by Omnesis")
                }
                if let when = eventTime(event) {
                    Text(when)
                        .font(.caption)
                        .foregroundStyle(Theme.textMuted)
                }
            }
            if !event.note.isEmpty {
                Text(event.note)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let source = TaskJournal.eventSource(event) {
                if let conversationId = event.conversationId, let onOpenConversation {
                    Button {
                        onOpenConversation(conversationId)
                    } label: {
                        Label(source, systemImage: "bubble.left")
                            .font(.caption.weight(.medium))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.accent)
                    .accessibilityHint("Opens the conversation")
                } else {
                    Text(source)
                        .font(.caption)
                        .foregroundStyle(Theme.textMuted)
                }
            }
        }
        .padding(.vertical, Theme.Spacing.sm)
    }

    private func eventTime(_ event: TaskEvent) -> String? {
        guard let at = event.at,
              let date = ISO8601DateFormatter.tasksFractional.date(from: at) ?? ISO8601DateFormatter().date(from: at)
        else { return nil }
        let day = schedule.dayLabel(schedule.day(date), today: today) ?? ""
        return "\(day), \(date.formatted(date: .omitted, time: .shortened))"
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("TaskHistoryContent") {
    NavigationStack {
        TaskHistoryContent(
            detail: TaskDetail(task: PreviewMocks.taskCarried, history: PreviewMocks.taskHistory, undoSeq: 41),
            today: "2026-10-14",
            onOpenConversation: { _ in }
        )
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.inline)
    }
    .background(Theme.bgPrimary)
}

@available(iOS 17.0, *)
#Preview("TaskHistoryContent – applied by Omnesis") {
    NavigationStack {
        TaskHistoryContent(
            detail: TaskDetail(task: PreviewMocks.taskCarried, history: PreviewMocks.taskHistoryAutoApplied, undoSeq: 52),
            today: "2026-10-14",
            onOpenConversation: { _ in },
            onUndo: { _ in }
        )
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.inline)
    }
    .background(Theme.bgPrimary)
}
#endif
#endif
