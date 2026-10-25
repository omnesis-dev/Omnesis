// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The calendar arithmetic and wording behind the Tasks screen.
///
/// Every day here is the device's local day: the phone tells the gateway what
/// "today" is, and the quick moves (Tomorrow, Next week, Next month) are
/// computed on the same calendar so a task moved at 23:50 lands where the
/// person meant. Pure and Foundation-only so the logic lane covers it.
public struct TaskSchedule: Sendable {
    public let calendar: Calendar
    public let locale: Locale

    public init(calendar: Calendar = .current, locale: Locale = .current) {
        var calendar = calendar
        calendar.locale = locale
        self.calendar = calendar
        self.locale = locale
    }

    // MARK: - Wire values

    /// `YYYY-MM-DD` for the local day containing `date`.
    public func day(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// `YYYY-MM` for the local month containing `date`.
    public func month(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", parts.year ?? 0, parts.month ?? 0)
    }

    public func tomorrow(from date: Date) -> String {
        day(calendar.date(byAdding: .day, value: 1, to: date) ?? date)
    }

    /// The Monday of next week: always after today, so on a Monday it is a
    /// week away rather than today.
    public func nextWeek(from date: Date) -> String {
        let weekday = calendar.component(.weekday, from: date) // Sunday = 1 … Saturday = 7
        let daysToMonday = (9 - weekday) % 7
        let offset = daysToMonday == 0 ? 7 : daysToMonday
        return day(calendar.date(byAdding: .day, value: offset, to: date) ?? date)
    }

    public func nextMonth(from date: Date) -> String {
        month(calendar.date(byAdding: .month, value: 1, to: calendar.startOfDay(for: date)) ?? date)
    }

    /// The local midnight a `YYYY-MM-DD` string names, or nil when it is not one.
    public func date(fromDay day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, day.count == 10 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    /// The first local day of a `YYYY-MM` month, or nil when it is not one.
    public func date(fromMonth month: String) -> Date? {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2, month.count == 7 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: 1))
    }

    // MARK: - Wording

    /// How a planned day or month reads beside a task, relative to `today`
    /// (`YYYY-MM-DD`): "Today", "Tomorrow", "Yesterday", "Thu 15 Oct",
    /// "October", "Someday". Nil when there is no plan or it cannot be read.
    public func scheduleLabel(_ scheduledFor: String?, today: String) -> String? {
        guard let scheduledFor else { return nil }
        if scheduledFor == "someday" { return "Someday" }
        if scheduledFor.count == 10 { return dayLabel(scheduledFor, today: today) }
        guard let start = date(fromMonth: scheduledFor), let todayDate = date(fromDay: today) else {
            return nil
        }
        let sameYear = calendar.component(.year, from: start) == calendar.component(.year, from: todayDate)
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        return sameYear
            ? start.formatted(style.month(.wide))
            : start.formatted(style.month(.wide).year())
    }

    /// A day relative to `today`: "Today", "Tomorrow", "Yesterday", else a
    /// short weekday and date ("Thu 15 Oct"), with the year when it differs.
    public func dayLabel(_ day: String, today: String) -> String? {
        guard let target = date(fromDay: day), let todayDate = date(fromDay: today) else { return nil }
        let delta = calendar.dateComponents([.day], from: todayDate, to: target).day ?? 0
        switch delta {
        case 0: return "Today"
        case 1: return "Tomorrow"
        case -1: return "Yesterday"
        default: break
        }
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        let sameYear = calendar.component(.year, from: target) == calendar.component(.year, from: todayDate)
        let base = style.weekday(.abbreviated).day().month(.abbreviated)
        return target.formatted(sameYear ? base : base.year())
    }

    /// How a deadline reads: "Due Fri 16 Oct", "Around 16 Oct", "On Fri 16
    /// Oct". Nil for a deadline with no day.
    public func deadlineLabel(_ deadline: TaskDeadline?, dueDay: String?, today: String) -> String? {
        guard let day = dueDay ?? deadline?.date, let when = dayLabel(day, today: today) else {
            return nil
        }
        let relative = ["Today", "Tomorrow", "Yesterday"].contains(when)
        switch deadline?.type ?? .by {
        case .approximate: return "Around \(relative ? when.lowercased() : when)"
        case .onDay: return relative ? when : "On \(when)"
        case .by, .anyTime: return "Due \(relative ? when.lowercased() : when)"
        }
    }

    /// Whether a deadline day has passed.
    public func isOverdue(dueDay: String?, today: String) -> Bool {
        guard let dueDay else { return false }
        return dueDay < today
    }
}
