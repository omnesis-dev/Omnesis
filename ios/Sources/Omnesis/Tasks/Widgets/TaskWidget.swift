// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(WidgetKit) && canImport(UIKit)
import AppIntents
import SwiftUI
import WidgetKit

struct TaskWidgetEntry: TimelineEntry {
    enum Status { case ready, unpaired, offline, completionFailed }
    var date: Date
    var configuration: TaskWidgetConfigurationIntent
    var navigation: TaskWidgetNavigation
    var snapshot: TaskWidgetSnapshot?
    var status: Status
    var authority: String?

    static func authority(for credential: TaskWidgetCredential) -> String {
        credential.authorityID
    }

    var anchor: Date {
        let component: Calendar.Component = switch configuration.period {
        case .day: .day
        case .week: .weekOfYear
        case .month: .month
        }
        return Calendar.current.date(byAdding: component, value: configuration.initialOffset + navigation.offset, to: date) ?? date
    }

    var schedule: TaskWidgetSchedule {
        TaskWidgetSchedule(period: configuration.period, date: anchor, now: date)
    }

    var tasks: [TaskWidgetTask] {
        schedule.tasks(from: snapshot?.tasks ?? [])
    }

    var listURL: URL {
        TaskWidgetDeepLink(view: configuration.period == .month ? .month : .today, day: schedule.day).url
    }

    func taskURL(_ id: String) -> URL {
        TaskWidgetDeepLink(view: configuration.period == .month ? .month : .today, day: schedule.day, taskId: id).url
    }
}

struct TaskWidgetProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TaskWidgetEntry {
        TaskWidgetFixtures.entry()
    }

    func snapshot(for configuration: TaskWidgetConfigurationIntent, in context: Context) async -> TaskWidgetEntry {
        if context.isPreview { return TaskWidgetFixtures.entry(configuration: configuration) }
        return await load(configuration)
    }

    func timeline(for configuration: TaskWidgetConfigurationIntent, in context: Context) async -> Timeline<TaskWidgetEntry> {
        let entry = await load(configuration)
        let nextMidnight = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: entry.date)) ?? entry.date
            .addingTimeInterval(15 * 60)
        let refresh = min(entry.date.addingTimeInterval(15 * 60), nextMidnight)
        return Timeline(entries: [entry], policy: .after(refresh))
    }

    private func load(_ configuration: TaskWidgetConfigurationIntent) async -> TaskWidgetEntry {
        var entry = TaskWidgetEntry(
            date: Date(),
            configuration: configuration,
            navigation: TaskWidgetNavigation.read(key: configuration.navigationKey),
            snapshot: nil,
            status: .unpaired
        )
        do {
            guard let credential = try TaskWidgetStorage.credential() else { return entry }
            entry.authority = TaskWidgetEntry.authority(for: credential)
            entry.snapshot = try? TaskWidgetStorage.snapshot()
            do {
                let snapshot = try await TaskWidgetClient(credential: credential).fetch()
                guard try TaskWidgetStorage.credential() == credential else {
                    entry.snapshot = nil
                    entry.status = .unpaired
                    return entry
                }
                try TaskWidgetStorage.save(snapshot: snapshot, credential: credential)
                entry.snapshot = try TaskWidgetStorage.snapshot()
                entry.status = .ready
            } catch {
                if (try? TaskWidgetStorage.credential()) != credential || error as? TaskWidgetClientError == .unauthorized {
                    entry.snapshot = nil
                    entry.status = .unpaired
                } else { entry.status = .offline }
            }
            if entry.status != .unpaired, (try? TaskWidgetStorage.keychain().get("task-widget.action-error")) != nil {
                entry.status = .completionFailed
            }
        } catch { entry.status = .offline }
        return entry
    }
}

struct TaskWidget: Widget {
    static let kind = TaskWidgetIdentity.kind
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: TaskWidgetConfigurationIntent.self, provider: TaskWidgetProvider()) { entry in
            TaskWidgetView(entry: entry)
                .containerBackground(for: .widget) { TaskWidgetBackground() }
        }
        .configurationDisplayName("Tasks")
        .description("Your day, at a glance. Browse ahead and check things off without opening Omnesis.")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .systemLarge,
            .systemExtraLarge,
            .accessoryInline,
            .accessoryCircular,
            .accessoryRectangular,
        ])
    }
}
#endif
