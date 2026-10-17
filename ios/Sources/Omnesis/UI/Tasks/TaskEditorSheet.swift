// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// A task's details, opened by tapping its text: its title, details, plan
/// and deadline to edit, then the documents it refers to and its history.
/// Only the fields the person changed are sent, so an edit never overwrites
/// a value it did not show differently.
@available(iOS 17.0, *)
struct TaskEditorSheet: View {
    /// Where the details sheet pushes.
    private enum Route: Hashable {
        case history
        case document(id: String, title: String)
    }

    let task: TaskRecord
    let today: String
    /// Reads the history; without one (a preview) the sheet has no History.
    var model: TasksModel?
    /// Sends the edit; returns whether the gateway accepted it.
    let onSave: (TaskAction) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @Environment(AppStore.self) private var store: AppStore?
    @State private var draft: TaskEditDraft
    @State private var saving = false

    init(
        task: TaskRecord,
        today: String,
        model: TasksModel? = nil,
        onSave: @escaping (TaskAction) async -> Bool
    ) {
        self.task = task
        self.today = today
        self.model = model
        self.onSave = onSave
        self._draft = State(initialValue: TaskEditDraft(task: task, schedule: TaskSchedule(), today: today))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    VStack(alignment: .leading, spacing: 0) {
                        TextField("Title", text: $draft.title, axis: .vertical)
                            .lineLimit(1 ... 4)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                            .padding(.vertical, Theme.Spacing.md)
                        rule
                        TextField("Details", text: $draft.description, axis: .vertical)
                            .lineLimit(2 ... 8)
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.vertical, Theme.Spacing.md)
                    }
                    FlatSection("Plan") {
                        VStack(spacing: 0) {
                            field("When") {
                                Picker("When", selection: $draft.plan) {
                                    ForEach(TaskEditDraft.Plan.allCases, id: \.self) { plan in
                                        Text(plan.label).tag(plan)
                                    }
                                }
                            }
                            if draft.plan == .day {
                                rule
                                field("Day") {
                                    DatePicker("Day", selection: $draft.planDate, displayedComponents: .date)
                                }
                            } else if draft.plan == .month {
                                rule
                                field("Month") {
                                    DatePicker("Month", selection: $draft.planDate, displayedComponents: .date)
                                }
                                Text("Planned for \(draft.planDate.formatted(.dateTime.month(.wide).year()))")
                                    .font(.footnote)
                                    .foregroundStyle(Theme.textSecondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.bottom, Theme.Spacing.sm)
                            }
                        }
                    }
                    FlatSection("Deadline") {
                        VStack(spacing: 0) {
                            Toggle("Has a deadline", isOn: $draft.hasDeadline)
                                .foregroundStyle(Theme.textPrimary)
                                .frame(minHeight: Theme.tapTarget)
                            if draft.hasDeadline {
                                rule
                                field("Kind") {
                                    Picker("Kind", selection: $draft.deadlineKind) {
                                        Text("Due by").tag(TaskDeadline.Kind.by)
                                        Text("Around").tag(TaskDeadline.Kind.approximate)
                                        Text("On the day").tag(TaskDeadline.Kind.onDay)
                                    }
                                }
                                rule
                                field("Date") {
                                    DatePicker("Date", selection: $draft.deadlineDate, displayedComponents: .date)
                                }
                            }
                        }
                    }
                    if !task.documents.isEmpty {
                        FlatSection("Documents", trailing: "\(task.documents.count)") {
                            VStack(spacing: 0) {
                                ForEach(Array(task.documents.enumerated()), id: \.element.id) { index, document in
                                    if index > 0 { rule }
                                    NavigationLink(value: Route.document(id: document.id, title: document.title)) {
                                        documentRow(document)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("tasks.editor.document")
                                }
                            }
                        }
                    }
                    if model != nil {
                        VStack(spacing: 0) {
                            rule
                            NavigationLink(value: Route.history) {
                                linkRow {
                                    Image(systemName: "clock.arrow.circlepath")
                                        .font(.system(size: 15))
                                        .foregroundStyle(Theme.textSecondary)
                                        .frame(width: 22)
                                    Text("History")
                                        .foregroundStyle(Theme.textPrimary)
                                }
                            }
                            .buttonStyle(.plain)
                            rule
                        }
                    }
                }
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.bottom, Theme.Spacing.xl)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .accessibilityIdentifier("tasks.editor")
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .history:
                    if let model { TaskHistoryView(model: model, taskId: task.id) }
                case .document(let id, let title):
                    DocumentDetailView(documentId: id, presetTitle: title)
                }
            }
            .navigationTitle("Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(saving || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    /// The hairline between rows, the flat layout's only separator.
    private var rule: some View {
        Rectangle().fill(Theme.borderLight).frame(height: 1)
    }

    /// A labelled control on one line: the label leading, the control trailing.
    private func field<Control: View>(_ label: String, @ViewBuilder control: () -> Control) -> some View {
        HStack {
            Text(label).foregroundStyle(Theme.textPrimary)
            Spacer(minLength: Theme.Spacing.md)
            control().labelsHidden()
        }
        .frame(minHeight: Theme.tapTarget)
    }

    /// A row that opens something: its content leading, a chevron trailing.
    private func linkRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            content()
            Spacer(minLength: Theme.Spacing.sm)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.textMuted)
        }
        .frame(minHeight: Theme.tapTarget)
        .contentShape(Rectangle())
    }

    /// A document the task refers to, under the same source icon the task's
    /// row in the list shows for it. Without a store (a bare preview) there
    /// is no icon to look up, and the title alone names the document.
    private func documentRow(_ document: TaskDocument) -> some View {
        linkRow {
            Group {
                if let store {
                    SourceIconView(sourceId: document.sourceId, store: store, size: 22)
                } else {
                    Color.clear
                }
            }
            .frame(width: 22, height: 22)
            Text(document.title.isEmpty ? "Untitled document" : document.title)
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.leading)
                .lineLimit(2)
        }
    }

    private func save() {
        guard let action = draft.action(comparedTo: task, schedule: TaskSchedule()) else {
            dismiss()
            return
        }
        saving = true
        Task {
            let ok = await onSave(action)
            saving = false
            if ok { dismiss() }
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("TaskEditorSheet") {
    TaskEditorSheet(task: PreviewMocks.taskProposal, today: "2026-10-14") { _ in true }
        .environment(AppStore.preview(sourceIconByType: ["gmail": PreviewMocks.agentSourceLayoutIcon]))
}

@available(iOS 17.0, *)
#Preview("TaskEditorSheet — with history") {
    TaskEditorSheet(
        task: PreviewMocks.taskWithPerson,
        today: "2026-10-14",
        model: .fixture(tasks: [PreviewMocks.taskWithPerson])
    ) { _ in true }
        .environment(AppStore.preview())
}
#endif
#endif
