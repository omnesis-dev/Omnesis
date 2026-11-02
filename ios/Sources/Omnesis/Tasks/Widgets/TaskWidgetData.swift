// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum TaskWidgetIdentity {
    public static let kind = "dev.omnesis.ios.widgets.tasks"
}

public enum TaskWidgetPeriod: String, Codable, CaseIterable, Sendable {
    case day, week, month
}

/// The widget keeps only the fields it renders, never task evidence or history.
public struct TaskWidgetTask: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let state: String
    public let scheduledFor: String?
    public let dueDay: String?
    public let carried: Bool
    public let origin: String?
    public let accepted: Bool
    public let ignored: Bool
    public let createdAt: String?

    public init(
        id: String,
        title: String,
        state: String = "open",
        scheduledFor: String? = nil,
        dueDay: String? = nil,
        carried: Bool = false,
        origin: String? = nil,
        accepted: Bool = false,
        ignored: Bool = false,
        createdAt: String? = nil
    ) {
        self.id = id
        self.title = title
        self.state = state
        self.scheduledFor = scheduledFor
        self.dueDay = dueDay
        self.carried = carried
        self.origin = origin
        self.accepted = accepted
        self.ignored = ignored
        self.createdAt = createdAt
    }

    public var isResolved: Bool {
        state == "done" || state == "dismissed"
    }

    public var isOwned: Bool {
        origin != "brain" || accepted
    }
}

public struct TaskWidgetSnapshot: Codable, Equatable, Sendable {
    public let tasks: [TaskWidgetTask]
    public let updatedAt: Date

    public init(tasks: [TaskWidgetTask], updatedAt: Date = Date()) {
        self.tasks = tasks
        self.updatedAt = updatedAt
    }
}

/// Future pages show their actual plans, rather than projecting today's backlog
/// onto every future day. Today retains the journal's carried/deadline behavior.
public struct TaskWidgetSchedule: Sendable {
    public let period: TaskWidgetPeriod
    public let date: Date
    public let now: Date
    public let calendar: Calendar

    public init(period: TaskWidgetPeriod, date: Date, now: Date = Date(), calendar: Calendar = .current) {
        self.period = period
        self.date = date
        self.now = now
        self.calendar = calendar
    }

    public var day: String {
        Self.dayString(date, calendar: calendar)
    }

    public var month: String {
        String(day.prefix(7))
    }

    public static func dayString(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 2000, parts.month ?? 1, parts.day ?? 1)
    }

    public func tasks(from all: [TaskWidgetTask]) -> [TaskWidgetTask] {
        let today = Self.dayString(now, calendar: calendar)
        let bounds: (String, String)
        switch period {
        case .day: bounds = (day, day)
        case .week:
            let start = calendar.dateInterval(of: .weekOfYear, for: date)?.start ?? date
            let end = calendar.date(byAdding: .day, value: 6, to: start) ?? start
            bounds = (Self.dayString(start, calendar: calendar), Self.dayString(end, calendar: calendar))
        case .month:
            let start = calendar.dateInterval(of: .month, for: date)?.start ?? date
            let next = calendar.date(byAdding: .month, value: 1, to: start) ?? start
            let end = calendar.date(byAdding: .day, value: -1, to: next) ?? start
            bounds = (Self.dayString(start, calendar: calendar), Self.dayString(end, calendar: calendar))
        }
        return all.filter { task in
            guard !task.isResolved, task.isOwned, !task.ignored else { return false }
            let plan = task.scheduledFor == "someday" ? nil : task.scheduledFor
            // A deadline brings an otherwise future plan forward once it is due.
            let dueToday = task.dueDay.map { $0 <= today } ?? false
            let planToday = plan.map { $0.count == 10 ? $0 <= today : $0 < String(today.prefix(7)) } ?? false
            if bounds.0 <= today, today <= bounds.1, dueToday || planToday { return true }
            if let plan {
                if plan.count == 7 {
                    if let due = task.dueDay, due < plan + "-01" {
                        return due >= bounds.0 && due <= bounds.1
                    }
                    if period == .month { return plan == month }
                    return task.dueDay.map { $0 >= bounds.0 && $0 <= bounds.1 } ?? false
                }
                let effective = task.dueDay.map { min(plan, $0) } ?? plan
                return effective >= bounds.0 && effective <= bounds.1
            }
            guard let due = task.dueDay else { return false }
            return due >= bounds.0 && due <= bounds.1
        }
        .sorted { lhs, rhs in
            if period == .day, bounds.0 == today {
                let left = lhs.createdAt ?? ""
                let right = rhs.createdAt ?? ""
                return left == right ? lhs.id < rhs.id : left > right
            }
            let left = Self.sortDate(lhs)
            let right = Self.sortDate(rhs)
            if left != right { return left < right }
            let leftCreated = lhs.createdAt ?? ""
            let rightCreated = rhs.createdAt ?? ""
            return leftCreated == rightCreated ? lhs.id < rhs.id : leftCreated < rightCreated
        }
    }

    private static func sortDate(_ task: TaskWidgetTask) -> String {
        let plan = task.scheduledFor == "someday" ? nil : task.scheduledFor
        if let plan, let due = task.dueDay { return min(plan, due) }
        return plan ?? task.dueDay ?? "9999"
    }
}
