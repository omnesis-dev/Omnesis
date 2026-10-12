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
            Form {
                Section {
                    TextField("Title", text: $draft.title, axis: .vertical)
                        .lineLimit(1 ... 4)
                    TextField("Details", text: $draft.description, axis: .vertical)
                        .lineLimit(2 ... 8)
                }
                Section("Plan") {
                    Picker("When", selection: $draft.plan) {
                        ForEach(TaskEditDraft.Plan.allCases, id: \.self) { plan in
                            Text(plan.label).tag(plan)
                        }
                    }
                    if draft.plan == .day {
                        DatePicker("Day", selection: $draft.planDate, displayedComponents: .date)
                    } else if draft.plan == .month {
                        DatePicker("Month", selection: $draft.planDate, displayedComponents: .date)
                        Text("Planned for \(draft.planDate.formatted(.dateTime.month(.wide).year()))")
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                Section("Deadline") {
                    Toggle("Has a deadline", isOn: $draft.hasDeadline)
                    if draft.hasDeadline {
                        Picker("Kind", selection: $draft.deadlineKind) {
                            Text("Due by").tag(TaskDeadline.Kind.by)
                            Text("Around").tag(TaskDeadline.Kind.approximate)
                            Text("On the day").tag(TaskDeadline.Kind.onDay)
                        }
                        DatePicker("Date", selection: $draft.deadlineDate, displayedComponents: .date)
                    }
                }
                if !task.documents.isEmpty {
                    Section("Documents") {
                        ForEach(task.documents) { document in
                            NavigationLink(value: Route.document(id: document.id, title: document.title)) {
                                Label(
                                    document.title.isEmpty ? "Untitled document" : document.title,
                                    systemImage: "doc.text"
                                )
                            }
                        }
                    }
                }
                if model != nil {
                    Section {
                        NavigationLink(value: Route.history) {
                            Label("History", systemImage: "clock.arrow.circlepath")
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bgPrimary)
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
