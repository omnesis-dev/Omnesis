// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(WidgetKit) && canImport(UIKit)
import Foundation
import SwiftUI
import WidgetKit

/// Invented gallery content; never populated from the owner's gateway.
enum TaskWidgetFixtures {
    static func entry(period: TaskWidgetPeriod, offset: Int = 0) -> TaskWidgetEntry {
        var configuration = TaskWidgetConfigurationIntent()
        configuration.period = period
        configuration.initialOffset = offset
        return entry(configuration: configuration)
    }

    static func entry(
        configuration: TaskWidgetConfigurationIntent = TaskWidgetConfigurationIntent(),
        empty: Bool = false
    )
        -> TaskWidgetEntry {
        let now = Calendar.current.date(from: DateComponents(year: 2026, month: 6, day: 15, hour: 10)) ?? Date()
        let titles = [
            "Plan the weekend",
            "Read a chapter",
            "Water the plants",
            "Review the project outline",
            "Book a library visit",
            "Sketch a new idea",
            "Organise the desk",
            "Take a quiet walk",
            "Choose a recipe",
            "Write a postcard",
            "Practise piano",
            "Sort the bookshelf",
            "Print the draft",
            "Back up the photos",
            "Check the garden",
            "Finish the reading list",
        ]
        var tasks = empty ? [] : titles.enumerated().map { index, title in
            TaskWidgetTask(id: "widget-preview-\(index)", title: title, scheduledFor: "2026-06-15", origin: "user")
        }
        if !empty {
            tasks += [
                TaskWidgetTask(id: "widget-tomorrow-1", title: "Choose a new book", scheduledFor: "2026-06-16", origin: "user"),
                TaskWidgetTask(id: "widget-tomorrow-2", title: "Refill the sketchbook", scheduledFor: "2026-06-16", origin: "user"),
                TaskWidgetTask(id: "widget-next-week-1", title: "Visit the botanical garden", scheduledFor: "2026-06-22", origin: "user"),
                TaskWidgetTask(id: "widget-next-week-2", title: "Plan a picnic", scheduledFor: "2026-06-24", origin: "user"),
                TaskWidgetTask(id: "widget-next-month-1", title: "Start a new sketchbook", scheduledFor: "2026-07-02", origin: "user"),
                TaskWidgetTask(id: "widget-next-month-2", title: "Organise the reading shelf", scheduledFor: "2026-07-20", origin: "user"),
                TaskWidgetTask(
                    id: "widget-deadline",
                    title: "Review the trail map",
                    scheduledFor: "2026-07-20",
                    dueDay: "2026-07-03",
                    origin: "user"
                ),
                TaskWidgetTask(id: "widget-month-only", title: "Make a summer playlist", scheduledFor: "2026-07", origin: "user"),
            ]
        }
        return TaskWidgetEntry(
            date: now,
            configuration: configuration,
            navigation: TaskWidgetNavigation(),
            snapshot: TaskWidgetSnapshot(tasks: tasks, updatedAt: now),
            status: .ready
        )
    }
}

#if DEBUG
#Preview("Tasks · small", as: .systemSmall) { TaskWidget() } timeline: { TaskWidgetFixtures.entry() }
#Preview("Tasks · medium", as: .systemMedium) { TaskWidget() } timeline: { TaskWidgetFixtures.entry() }
#Preview("Tasks · large", as: .systemLarge) { TaskWidget() } timeline: { TaskWidgetFixtures.entry() }
#Preview("Tasks · extra large", as: .systemExtraLarge) { TaskWidget() } timeline: { TaskWidgetFixtures.entry() }
#Preview("Tasks · next week", as: .systemLarge) { TaskWidget() } timeline: { TaskWidgetFixtures.entry(period: .week, offset: 1) }
#Preview("Tasks · next month", as: .systemLarge) { TaskWidget() } timeline: { TaskWidgetFixtures.entry(period: .month, offset: 1) }
#Preview("Tasks · empty", as: .systemMedium) { TaskWidget() } timeline: { TaskWidgetFixtures.entry(empty: true) }
#Preview("Tasks · Lock Screen", as: .accessoryRectangular) { TaskWidget() } timeline: { TaskWidgetFixtures.entry() }
#Preview("Tasks · circular", as: .accessoryCircular) { TaskWidget() } timeline: { TaskWidgetFixtures.entry() }
#Preview("Tasks · inline", as: .accessoryInline) { TaskWidget() } timeline: { TaskWidgetFixtures.entry() }
#endif
#endif
