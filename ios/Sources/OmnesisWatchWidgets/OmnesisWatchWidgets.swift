// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import SwiftUI
import WidgetKit

/// One logo complication. The Ask kind is retained for installed watch faces.
@main
struct OmnesisWatchWidgetsBundle: WidgetBundle {
    var body: some Widget {
        OmnesisComplication()
    }
}

struct OmnesisComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "dev.omnesis.watch.complication.ask", provider: StaticProvider()) { _ in
            Image("OmnesisMark")
                .resizable()
                .scaledToFit()
                .padding(8)
                .widgetAccentable()
                .widgetURL(WatchComplication.ask.url)
                .accessibilityLabel("Omnesis")
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Omnesis")
        .description("Speak, then ask or tell Omnesis.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular])
    }
}

struct StaticEntry: TimelineEntry {
    let date: Date
}

/// The complications never change, so one entry that is never reloaded.
struct StaticProvider: TimelineProvider {
    func placeholder(in context: Context) -> StaticEntry {
        StaticEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (StaticEntry) -> Void) {
        completion(StaticEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StaticEntry>) -> Void) {
        completion(Timeline(entries: [StaticEntry(date: Date())], policy: .never))
    }
}

#Preview("Omnesis", as: .accessoryCircular) {
    OmnesisComplication()
} timeline: {
    StaticEntry(date: .now)
}
#endif
