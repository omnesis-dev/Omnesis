// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(WidgetKit) && canImport(UIKit)
import SwiftUI
import UIKit
import WidgetKit

/// The same palette as the app, kept independent of the app-only view helpers.
enum TaskWidgetPalette {
    static let accent = adaptive(0x0969DA, 0x58A6FF)
    static let ink = adaptive(0x1F2328, 0xE6EDF3)
    static let secondary = adaptive(0x59636E, 0x8B949E)
    static let surface = adaptive(0xFFFFFF, 0x0D1117)
    static let divider = adaptive(0xE4E8EC, 0x21262D)
    static let danger = adaptive(0xCF222E, 0xF85149)

    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((value >> 16) & 255) / 255,
                green: CGFloat((value >> 8) & 255) / 255,
                blue: CGFloat(value & 255) / 255,
                alpha: 1
            )
        })
    }
}

struct TaskWidgetBackground: View {
    var body: some View {
        LinearGradient(
            colors: [TaskWidgetPalette.accent.opacity(0.09), TaskWidgetPalette.surface],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

struct TaskWidgetView: View {
    let entry: TaskWidgetEntry
    /// WidgetKit owns its read-only environment value; snapshots pass a family
    /// explicitly to render the same layout outside a widget host.
    var familyOverride: WidgetFamily?
    @Environment(\.widgetFamily) private var widgetFamily
    private var family: WidgetFamily {
        familyOverride ?? widgetFamily
    }

    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .caption) private var rowFont: CGFloat = 13
    @ScaledMetric(relativeTo: .caption) private var rowHeight: CGFloat = 29

    private var isSmall: Bool {
        family == .systemSmall
    }

    private var isWide: Bool {
        family == .systemExtraLarge
    }

    private var capacity: Int {
        let regular = switch family {
        case .systemSmall: 2
        case .systemMedium: 3
        case .systemExtraLarge: 14
        default: 7
        }
        return typeSize.isAccessibilitySize ? max(1, regular / 2) : regular
    }

    private var pageCount: Int {
        max(1, (entry.tasks.count + capacity - 1) / capacity)
    }

    private var page: Int {
        min(entry.navigation.page, pageCount - 1)
    }

    private var visible: [TaskWidgetTask] {
        Array(entry.tasks.dropFirst(page * capacity).prefix(capacity))
    }

    var body: some View {
        Group {
            switch family {
            case .accessoryInline: inline
            case .accessoryCircular: circular
            case .accessoryRectangular: rectangular
            default: home
            }
        }
        .widgetURL(entry.listURL)
        .privacySensitive()
    }

    @ViewBuilder
    private var home: some View {
        if family == .systemMedium, !entry.tasks.isEmpty, entry.status != .unpaired {
            medium
        } else {
            fullHeight
        }
    }

    private var medium: some View {
        VStack(spacing: 5) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("OMNESIS")
                        .font(.system(size: 9, weight: .bold))
                        .tracking(1.5)
                        .foregroundStyle(TaskWidgetPalette.accent)
                    Text(title)
                        .font(.system(size: 21, weight: .bold, design: .rounded))
                        .lineLimit(2)
                        .minimumScaleFactor(0.75)
                    Text("\(entry.tasks.count) to do").font(.system(size: 11, weight: .medium))
                        .foregroundStyle(TaskWidgetPalette.secondary)
                }
                .frame(width: 100, alignment: .leading)
                Rectangle().fill(TaskWidgetPalette.divider).frame(width: 1)
                rows(visible)
            }
            .frame(maxHeight: .infinity, alignment: .top)
            footer
        }
        .foregroundStyle(TaskWidgetPalette.ink)
    }

    private var fullHeight: some View {
        VStack(alignment: .leading, spacing: isSmall ? 7 : 9) {
            header
            if entry.status == .unpaired {
                message("Open Omnesis", detail: "Pair your gateway to see your tasks.", symbol: "link")
            } else if entry.snapshot == nil {
                message("Gateway unavailable", detail: "Open Omnesis to reconnect.", symbol: "wifi.slash")
            } else if entry.tasks.isEmpty {
                message(
                    "Room to breathe",
                    detail: "No tasks planned for this \(entry.configuration.period.rawValue).",
                    symbol: "checkmark.circle"
                )
            } else {
                if isWide {
                    HStack(alignment: .top, spacing: 26) {
                        rows(Array(visible.prefix((capacity + 1) / 2)))
                        rows(Array(visible.dropFirst((capacity + 1) / 2)))
                    }
                } else {
                    rows(visible)
                }
                Spacer(minLength: 0)
            }
            footer
        }
        .foregroundStyle(TaskWidgetPalette.ink)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Image("OmnesisMark")
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 12, height: 12)
                        .accessibilityHidden(true)
                    Text("OMNESIS")
                        .font(.system(size: 9, weight: .bold))
                        .tracking(1.5)
                }
                .foregroundStyle(TaskWidgetPalette.accent)
                Text(title)
                    .font(.system(size: isSmall ? 21 : 23, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .accessibilityAddTraits(.isHeader)
            }
            Spacer(minLength: 0)
            if !isSmall, entry.status != .unpaired {
                VStack(alignment: .trailing, spacing: 0) {
                    Text("\(entry.tasks.count)")
                        .font(.system(size: 25, weight: .light, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(TaskWidgetPalette.accent)
                    Text("TO DO")
                        .font(.system(size: 8, weight: .semibold))
                        .tracking(1)
                        .foregroundStyle(TaskWidgetPalette.secondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(entry.tasks.count) tasks to do")
            }
        }
    }

    private func rows(_ tasks: [TaskWidgetTask]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(tasks) { task in
                HStack(alignment: .center, spacing: 7) {
                    Button(intent: CompleteWidgetTaskIntent(taskId: task.id, authority: entry.authority ?? "")) {
                        Image(systemName: "circle")
                            .font(.system(size: 20, weight: .light))
                            .foregroundStyle(TaskWidgetPalette.accent.opacity(0.8))
                            .frame(width: 27, height: min(52, isSmall ? rowHeight - 2 : rowHeight))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Complete \(task.title)")
                    Link(destination: entry.taskURL(task.id)) {
                        HStack(spacing: 4) {
                            Text(task.title)
                                .font(.system(size: min(23, isSmall ? rowFont - 1 : rowFont), weight: .medium))
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if entry.configuration.period != .day, let label = scheduleLabel(task) {
                                Text(label)
                                    .font(.system(size: 9, weight: .medium))
                                    .foregroundStyle(TaskWidgetPalette.secondary)
                                    .lineLimit(1)
                                    .fixedSize(horizontal: true, vertical: false)
                            }
                            if let due = task.dueDay, due < TaskWidgetSchedule.dayString(entry.date) {
                                Image(systemName: "exclamationmark.circle.fill")
                                    .font(.system(size: 10))
                                    .foregroundStyle(TaskWidgetPalette.danger)
                                    .accessibilityLabel("Overdue")
                            }
                        }
                    }
                    .foregroundStyle(TaskWidgetPalette.ink)
                }
                if task.id != tasks.last?.id {
                    Rectangle().fill(TaskWidgetPalette.divider).frame(height: 0.5).padding(.leading, 34)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// Match the planner's earlier deadline when it brings a plan forward.
    private func scheduleLabel(_ task: TaskWidgetTask) -> String? {
        let plan = task.scheduledFor == "someday" ? nil : task.scheduledFor
        if let plan, plan.count == 7, entry.configuration.period == .month,
           task.dueDay.map({ $0 >= plan + "-01" }) ?? true {
            return plan == entry.schedule.month ? "This month" : "Carried"
        }
        let day: String? = if let plan, plan.count == 10, let due = task.dueDay {
            min(plan, due)
        } else if let plan, plan.count == 10 {
            plan
        } else {
            task.dueDay
        }
        guard let day else { return nil }
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let date = Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        else { return nil }
        if isSmall { return date.formatted(.dateTime.day()) }
        return date.formatted(.dateTime.weekday(.abbreviated).day())
    }

    private var footer: some View {
        HStack(spacing: 3) {
            browseButton("chevron.left", label: "Previous \(entry.configuration.period.rawValue)", offset: entry.navigation.offset - 1)
            Button(intent: BrowseTaskWidgetIntent(key: entry.configuration.navigationKey, offset: -entry.configuration.initialOffset)) {
                Text(footerLabel)
                    .font(.system(size: 9, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Return to current \(entry.configuration.period.rawValue)")
            browseButton("chevron.right", label: "Next \(entry.configuration.period.rawValue)", offset: entry.navigation.offset + 1)
            if pageCount > 1 {
                Button(intent: BrowseTaskWidgetIntent(
                    key: entry.configuration.navigationKey,
                    offset: entry.navigation.offset,
                    page: (page + 1) % pageCount
                )) {
                    Text("\(page + 1)/\(pageCount)")
                        .font(.system(size: 9, weight: .semibold))
                        .monospacedDigit()
                        .padding(.horizontal, 5)
                        .frame(minHeight: 24)
                        .background(TaskWidgetPalette.accent.opacity(0.1), in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("More tasks, page \(page + 1) of \(pageCount)")
            }
        }
        .foregroundStyle(entry.status == .completionFailed ? TaskWidgetPalette.danger : TaskWidgetPalette.secondary)
    }

    private func browseButton(_ symbol: String, label: String, offset: Int) -> some View {
        Button(intent: BrowseTaskWidgetIntent(key: entry.configuration.navigationKey, offset: offset)) {
            Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
                .frame(width: 23, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func message(_ title: String, detail: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Image(systemName: symbol).font(.system(size: isSmall ? 18 : 23, weight: .light))
                .foregroundStyle(TaskWidgetPalette.accent)
                .accessibilityHidden(true)
            Text(title).font(.system(size: isSmall ? 12 : 15, weight: .semibold))
            if !isSmall {
                Text(detail).font(.system(size: 11)).foregroundStyle(TaskWidgetPalette.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var title: String {
        let calendar = Calendar.current
        switch entry.configuration.period {
        case .day:
            if calendar.isDate(entry.anchor, inSameDayAs: entry.date) { return "Today" }
            if let tomorrow = calendar.date(byAdding: .day, value: 1, to: entry.date),
               calendar.isDate(entry.anchor, inSameDayAs: tomorrow) { return "Tomorrow" }
            return entry.anchor.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
        case .week:
            if calendar.isDate(entry.anchor, equalTo: entry.date, toGranularity: .weekOfYear) { return "This week" }
            return "Week of " + (calendar.dateInterval(of: .weekOfYear, for: entry.anchor)?.start ?? entry.anchor)
                .formatted(.dateTime.day().month(.abbreviated))
        case .month:
            if calendar.isDate(entry.anchor, equalTo: entry.date, toGranularity: .year) {
                return entry.anchor.formatted(.dateTime.month(.wide))
            }
            return entry.anchor.formatted(.dateTime.month(.abbreviated).year())
        }
    }

    private var footerLabel: String {
        switch entry.status {
        case .completionFailed: "Couldn't complete"
        case .offline: "Offline · cached"
        case .unpaired: "Your tasks, close by"
        case .ready: entry.anchor.formatted(.dateTime.day().month(.abbreviated))
        }
    }

    private var inline: some View {
        Label(accessoryLabel, systemImage: accessorySymbol)
    }

    private var accessorySymbol: String {
        if entry.status == .unpaired { return "link" }
        if entry.snapshot == nil || entry.status == .offline { return "wifi.slash" }
        if entry.status == .completionFailed { return "exclamationmark.circle" }
        return "checklist"
    }

    private var accessoryLabel: String {
        if entry.status == .unpaired { return "Open Omnesis to pair" }
        if entry.snapshot == nil { return "Gateway unavailable" }
        let summary = "\(title) · \(entry.tasks.count) tasks"
        if entry.status == .offline { return summary + " · Offline" }
        if entry.status == .completionFailed { return summary + " · Couldn't complete" }
        return summary
    }

    private var circular: some View {
        VStack(spacing: 1) {
            Image(systemName: accessorySymbol).font(.system(size: 12)).widgetAccentable()
            if entry.status == .unpaired {
                Image(systemName: "link")
            } else if entry.snapshot == nil {
                Image(systemName: "wifi.slash")
            } else {
                Text("\(entry.tasks.count)").font(.system(.title2, design: .rounded).weight(.semibold))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(in: Circle())
        .accessibilityLabel(accessoryLabel)
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Text(entry.snapshot == nil ? title : "\(title) · \(entry.tasks.count)").font(.headline)
                if entry.status == .offline || entry.status == .completionFailed {
                    Image(systemName: accessorySymbol).font(.caption2)
                }
            }
            .widgetAccentable()
            if entry.status == .completionFailed {
                Text("Couldn't complete · tap to retry").font(.system(size: 9)).lineLimit(1)
            } else if entry.status == .offline, entry.snapshot != nil {
                Text("Offline · saved tasks").font(.system(size: 9)).lineLimit(1)
            }
            if entry.status == .unpaired {
                Text("Open Omnesis to pair").font(.caption)
            } else if let task = entry.tasks.first {
                HStack(spacing: 5) {
                    Button(intent: CompleteWidgetTaskIntent(taskId: task.id, authority: entry.authority ?? "")) {
                        Image(systemName: "circle").frame(width: 24, height: 26)
                    }
                    .buttonStyle(.plain).accessibilityLabel("Complete \(task.title)")
                    Link(task.title, destination: entry.taskURL(task.id)).font(.caption).lineLimit(2)
                }
            } else {
                Text(entry.snapshot == nil ? "Gateway unavailable" : "Nothing planned").font(.caption)
            }
        }
    }
}
#endif
