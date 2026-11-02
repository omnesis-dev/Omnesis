// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(WidgetKit) && canImport(UIKit)
import AppIntents
import Foundation
import WidgetKit

extension TaskWidgetPeriod: AppEnum {
    public static var typeDisplayRepresentation: TypeDisplayRepresentation {
        "Date range"
    }

    public static var caseDisplayRepresentations: [TaskWidgetPeriod: DisplayRepresentation] {
        [.day: "Day", .week: "Week", .month: "Month"]
    }
}

enum TaskWidgetBoard: String, AppEnum {
    case first, second, third, fourth
    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        "Widget panel"
    }

    static var caseDisplayRepresentations: [Self: DisplayRepresentation] {
        [.first: "1", .second: "2", .third: "3", .fourth: "4"]
    }
}

struct TaskWidgetConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Tasks"
    static var description =
        IntentDescription("Choose a day, week or month. Give matching widgets different panels to browse them independently.")
    @Parameter(title: "Date range", default: .day) var period: TaskWidgetPeriod
    @Parameter(title: "Start offset", default: 0, inclusiveRange: (0, 24)) var initialOffset: Int
    @Parameter(title: "Panel", default: .first) var board: TaskWidgetBoard

    static var parameterSummary: some ParameterSummary {
        Summary("\(\.$period), \(\.$initialOffset) ahead") { \.$board }
    }

    var navigationKey: String {
        "task-widget.navigation.\(period.rawValue).\(initialOffset).\(board.rawValue)"
    }
}

struct TaskWidgetNavigation: Codable {
    var offset = 0
    var page = 0

    static func read(key: String) -> Self {
        guard let raw = try? TaskWidgetStorage.keychain().get(key),
              let data = raw.data(using: .utf8), let state = try? JSONDecoder().decode(Self.self, from: data)
        else { return Self() }
        return state
    }

    func save(key: String) throws {
        let data = try JSONEncoder().encode(self)
        guard let raw = String(data: data, encoding: .utf8) else { throw Keychain.Error.unexpectedData }
        try TaskWidgetStorage.keychain().set(raw, forKey: key)
    }
}

struct BrowseTaskWidgetIntent: AppIntent {
    static var title: LocalizedStringResource = "Browse tasks"
    static var isDiscoverable: Bool {
        false
    }

    @Parameter(title: "Panel") var navigationKey: String
    @Parameter(title: "Offset") var offset: Int
    @Parameter(title: "Page") var page: Int

    init() {}
    init(key: String, offset: Int, page: Int = 0) {
        navigationKey = key
        self.offset = offset
        self.page = page
    }

    func perform() async throws -> some IntentResult {
        guard navigationKey.hasPrefix("task-widget.navigation.") else { return .result() }
        try TaskWidgetNavigation(offset: max(-120, min(120, offset)), page: max(0, page)).save(key: navigationKey)
        WidgetCenter.shared.reloadTimelines(ofKind: TaskWidget.kind)
        return .result()
    }
}

struct CompleteWidgetTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Complete task"
    static var isDiscoverable: Bool {
        false
    }

    static var authenticationPolicy: IntentAuthenticationPolicy {
        .requiresLocalDeviceAuthentication
    }

    @Parameter(title: "Task") var taskId: String
    @Parameter(title: "Pairing") var authority: String

    init() {}
    init(taskId: String, authority: String) {
        self.taskId = taskId
        self.authority = authority
    }

    func perform() async throws -> some IntentResult {
        do {
            try await TaskWidgetCompletion.perform(id: taskId, expectedAuthorityID: authority)
            if (try? TaskWidgetStorage.credential())?.authorityID == authority {
                try? TaskWidgetStorage.keychain().delete("task-widget.action-error")
            }
        } catch {
            if (try? TaskWidgetStorage.credential())?.authorityID == authority {
                try? TaskWidgetStorage.keychain().set("completion", forKey: "task-widget.action-error")
            }
            WidgetCenter.shared.reloadTimelines(ofKind: TaskWidget.kind)
            throw error
        }
        WidgetCenter.shared.reloadTimelines(ofKind: TaskWidget.kind)
        return .result()
    }
}
#endif
