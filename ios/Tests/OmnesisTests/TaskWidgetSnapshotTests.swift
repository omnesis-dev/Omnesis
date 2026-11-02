// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import SwiftUI
import UIKit
import WidgetKit
import XCTest

@MainActor
final class TaskWidgetSnapshotTests: XCTestCase {
    func testTodayNewestTasksLeadCompactWidgets() throws {
        var entry = TaskWidgetFixtures.entry()
        entry.snapshot = TaskWidgetSnapshot(
            tasks: [
                TaskWidgetTask(
                    id: "older",
                    title: "Inspect the storage shelves",
                    scheduledFor: "2026-06-15",
                    createdAt: "2026-06-15T08:00:00Z"
                ),
                TaskWidgetTask(
                    id: "new-carried",
                    title: "Review the exhibit plan",
                    scheduledFor: "2026-06-14",
                    createdAt: "2026-06-15T11:00:00Z"
                ),
                TaskWidgetTask(
                    id: "current",
                    title: "Prepare display labels",
                    scheduledFor: "2026-06-15",
                    createdAt: "2026-06-15T10:00:00Z"
                ),
            ],
            updatedAt: entry.date
        )
        XCTAssertEqual(entry.tasks.map(\.id), ["new-carried", "current", "older"])
        try render(entry, family: .systemSmall, size: CGSize(width: 170, height: 170), name: "today-newest")
        try render(entry, family: .systemMedium, size: CGSize(width: 360, height: 170), name: "today-newest")
    }

    func testTaskWidgetFamilies() throws {
        let families: [(WidgetFamily, CGSize)] = [
            (.systemSmall, CGSize(width: 170, height: 170)),
            (.systemMedium, CGSize(width: 360, height: 170)),
            (.systemLarge, CGSize(width: 360, height: 380)),
            (.systemExtraLarge, CGSize(width: 740, height: 380)),
            (.accessoryRectangular, CGSize(width: 160, height: 76)),
            (.accessoryCircular, CGSize(width: 76, height: 76)),
            (.accessoryInline, CGSize(width: 320, height: 30)),
        ]
        for (family, size) in families {
            try render(TaskWidgetFixtures.entry(), family: family, size: size, name: "populated")
        }
    }

    func testTaskWidgetEmptyOfflineAndUnpaired() throws {
        for status in [TaskWidgetEntry.Status.ready, .offline, .unpaired, .completionFailed] {
            var entry = TaskWidgetFixtures.entry(empty: status == .ready)
            entry.status = status
            if status == .unpaired { entry.snapshot = nil }
            try render(entry, family: .accessoryRectangular, size: CGSize(width: 160, height: 76), name: "\(status)-rectangular")
            try render(entry, family: .accessoryCircular, size: CGSize(width: 76, height: 76), name: "\(status)-circular")
            try render(entry, family: .accessoryInline, size: CGSize(width: 320, height: 30), name: "\(status)-inline")
            try render(entry, family: .systemSmall, size: CGSize(width: 170, height: 170), name: "\(status)-small")
            try render(entry, family: .systemMedium, size: CGSize(width: 360, height: 170), name: "\(status)-medium")
        }
        var entry = TaskWidgetFixtures.entry()
        entry.snapshot = nil
        entry.status = .offline
        try render(entry, family: .systemMedium, size: CGSize(width: 360, height: 170), name: "offline-no-cache")
    }

    func testTaskWidgetLongTitlesAndAccessibility() throws {
        var entry = TaskWidgetFixtures.entry()
        entry.snapshot = TaskWidgetSnapshot(tasks: [
            TaskWidgetTask(
                id: "long-preview",
                title: "Prepare a detailed outline for the next community workshop and review the printed draft",
                scheduledFor: "2026-06-15"
            ),
            TaskWidgetTask(id: "short-preview", title: "Read", scheduledFor: "2026-06-15"),
        ], updatedAt: entry.date)
        try render(entry, family: .systemSmall, size: CGSize(width: 170, height: 170), name: "long-titles")
        try render(entry, family: .systemLarge, size: CGSize(width: 360, height: 380), name: "accessibility", typeSize: .accessibility3)
    }

    func testTaskWidgetFutureDates() throws {
        for period in TaskWidgetPeriod.allCases {
            var entry = TaskWidgetFixtures.entry()
            entry.configuration.period = period
            entry.navigation.offset = 1
            XCTAssertFalse(entry.tasks.isEmpty, "Future fixtures must prove populated date views")
            try render(entry, family: .systemMedium, size: CGSize(width: 360, height: 170), name: "next-\(period)")
            try render(entry, family: .systemLarge, size: CGSize(width: 360, height: 380), name: "next-\(period)-large")
        }
    }

    private func render(
        _ entry: TaskWidgetEntry,
        family: WidgetFamily,
        size: CGSize,
        name: String,
        typeSize: DynamicTypeSize = .large
    ) throws {
        let directory = URL(fileURLWithPath: "/tmp/omnesis-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for scheme in [ColorScheme.light, .dark] {
            let renderer = ImageRenderer(content:
                TaskWidgetView(entry: entry, familyOverride: family)
                    .environment(\.dynamicTypeSize, typeSize)
                    .environment(\.colorScheme, scheme)
                    .padding([WidgetFamily.accessoryInline, .accessoryCircular, .accessoryRectangular].contains(family) ? 0 : 16)
                    .frame(width: size.width, height: size.height)
                    .background(TaskWidgetBackground().environment(\.colorScheme, scheme))
                    .clipShape(RoundedRectangle(cornerRadius: 22))
            )
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            let data = try XCTUnwrap(image.pngData())
            XCTAssertGreaterThan(data.count, 1000)
            try data.write(to: directory.appendingPathComponent("task-widget-\(family)-\(name)-\(scheme).png"))
        }
    }
}
