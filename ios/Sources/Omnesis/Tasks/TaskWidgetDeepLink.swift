// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// A widget's destination in the task journal. Links carry identifiers and
/// calendar days only; titles and gateway credentials never enter the URL.
public struct TaskWidgetDeepLink: Equatable, Sendable {
    public enum JournalView: String, Sendable { case today, month }

    public let view: JournalView
    public let day: String
    public let taskId: String?

    public init(view: JournalView, day: String, taskId: String? = nil) {
        self.view = view
        self.day = day
        self.taskId = taskId
    }

    public init?(url: URL) {
        guard url.scheme == "omnesis", url.host == "tasks", url.path.isEmpty,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil, components.password == nil, components.port == nil,
              components.fragment == nil
        else { return nil }
        let items = components.queryItems ?? []
        guard items.allSatisfy({ ["view", "date", "task"].contains($0.name) }),
              Set(items.map(\.name)).count == items.count,
              let rawView = items.first(where: { $0.name == "view" })?.value,
              let view = JournalView(rawValue: rawView),
              let day = items.first(where: { $0.name == "date" })?.value,
              Self.validDay(day)
        else { return nil }
        let taskItem = items.first(where: { $0.name == "task" })
        if let taskItem {
            guard let id = taskItem.value, (1 ... 200).contains(id.count),
                  id.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
            else { return nil }
        }
        self.init(view: view, day: day, taskId: taskItem?.value)
    }

    public var url: URL {
        var components = URLComponents()
        components.scheme = "omnesis"
        components.host = "tasks"
        components.queryItems = [
            URLQueryItem(name: "view", value: view.rawValue),
            URLQueryItem(name: "date", value: day),
        ]
        if let taskId { components.queryItems?.append(URLQueryItem(name: "task", value: taskId)) }
        // The scheme, host and query-item names are constants; URLComponents
        // percent-encodes every supplied value.
        return components.url!
    }

    public static func validDay(_ day: String) -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard day.count == 10, parts.count == 3,
              day.unicodeScalars.allSatisfy({ (48 ... 57).contains($0.value) || $0.value == 45 }),
              let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        else { return false }
        let result = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", result.year ?? 0, result.month ?? 0, result.day ?? 0) == day
    }
}
