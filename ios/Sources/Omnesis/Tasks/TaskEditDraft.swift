// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The editor's working copy, and the edit it amounts to. Pure so the
/// "send only what changed" rule is covered by the logic lane.
public struct TaskEditDraft: Equatable, Sendable {
    public enum Plan: String, CaseIterable, Sendable {
        case none, day, month, someday

        public var label: String {
            switch self {
            case .none: "No plan"
            case .day: "A day"
            case .month: "A month"
            case .someday: "Someday"
            }
        }
    }

    public var title: String
    public var description: String
    public var plan: Plan
    public var planDate: Date
    public var hasDeadline: Bool
    public var deadlineKind: TaskDeadline.Kind
    public var deadlineDate: Date

    public init(task: TaskRecord, schedule: TaskSchedule, today: String) {
        let todayDate = schedule.date(fromDay: today) ?? Date()
        title = task.title
        description = task.description
        switch task.scheduledFor {
        case nil:
            plan = .none
            planDate = todayDate
        case "someday":
            plan = .someday
            planDate = todayDate
        case let value? where value.count == 7:
            plan = .month
            planDate = schedule.date(fromMonth: value) ?? todayDate
        case let value?:
            plan = .day
            planDate = schedule.date(fromDay: value) ?? todayDate
        }
        let deadlineDay = task.deadline?.date ?? task.dueDay
        hasDeadline = deadlineDay != nil
        deadlineKind = task.deadline?.type == .anyTime ? .by : (task.deadline?.type ?? .by)
        deadlineDate = deadlineDay.flatMap(schedule.date(fromDay:)) ?? todayDate
    }

    /// The schedule string the draft's plan names.
    public func scheduledFor(_ schedule: TaskSchedule) -> String? {
        switch plan {
        case .none: nil
        case .someday: "someday"
        case .month: schedule.month(planDate)
        case .day: schedule.day(planDate)
        }
    }

    /// The edit to send, or nil when nothing changed.
    public func action(comparedTo task: TaskRecord, schedule: TaskSchedule) -> TaskAction? {
        let newTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let titleChange = newTitle != task.title && !newTitle.isEmpty ? newTitle : nil
        let descriptionChange = description != task.description ? description : nil
        let newSchedule = scheduledFor(schedule)
        let scheduleChange: TaskFieldChange<String> = newSchedule == task.scheduledFor ? .unchanged : .set(newSchedule)
        let newDeadline = hasDeadline
            ? TaskDeadline(type: deadlineKind, date: schedule.day(deadlineDate), note: task.deadline?.note)
            : nil
        let oldDeadlineDay = task.deadline?.date ?? task.dueDay
        let deadlineUnchanged = newDeadline?.date == oldDeadlineDay
            && (newDeadline == nil || newDeadline?.type == (task.deadline?.type ?? .by))
        let deadlineChange: TaskFieldChange<TaskDeadline> = deadlineUnchanged ? .unchanged : .set(newDeadline)
        if titleChange == nil, descriptionChange == nil, scheduleChange == .unchanged, deadlineChange == .unchanged {
            return nil
        }
        return .edit(
            title: titleChange,
            description: descriptionChange,
            scheduledFor: scheduleChange,
            deadline: deadlineChange
        )
    }
}
