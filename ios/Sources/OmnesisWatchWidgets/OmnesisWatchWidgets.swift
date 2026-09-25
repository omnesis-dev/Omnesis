// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(watchOS)
import SwiftUI
import WidgetKit

/// The watch-face complications: Ask Omnesis and Omnesis note.
///
/// A widget can only open its own app, so each complication is a plain
/// link — tapping it opens the watch app at its `WatchComplication` URL, and
/// the app presents dictation for that flow straight away. The extension
/// holds no pairing, keychain or relay access, so it needs no entitlements
/// and has nothing to leak (the same posture as the iPhone's Control Center
/// control).
@main
struct OmnesisWatchWidgetsBundle: WidgetBundle {
    var body: some Widget {
        AskComplication()
        NoteComplication()
    }
}

struct AskComplication: Widget {
    var body: some WidgetConfiguration {
        ComplicationSpec.ask.configuration
    }
}

struct NoteComplication: Widget {
    var body: some WidgetConfiguration {
        ComplicationSpec.note.configuration
    }
}

/// What distinguishes the two complications. Everything else — families,
/// timeline, layout — is shared, so the two cannot drift apart.
struct ComplicationSpec {
    let complication: WatchComplication
    /// Stable WidgetKit kind. Renaming it drops the complication from every
    /// face it is on.
    let kind: String
    let title: LocalizedStringResource
    /// The one word that fits the inline slot beside the glyph.
    let shortTitle: LocalizedStringResource
    /// The second line of the rectangular slot.
    let prompt: LocalizedStringResource
    let description: LocalizedStringResource
    let systemImage: String

    static let ask = ComplicationSpec(
        complication: .ask,
        kind: "dev.omnesis.watch.complication.ask",
        title: "Ask Omnesis",
        shortTitle: "Ask",
        prompt: "Tap to ask",
        description: "Tap to ask a question by voice.",
        // Matches the watch App Shortcut, so Siri and the face agree.
        systemImage: "questionmark.bubble"
    )

    static let note = ComplicationSpec(
        complication: .note,
        kind: "dev.omnesis.watch.complication.note",
        title: "Omnesis note",
        shortTitle: "Note",
        prompt: "Tap to dictate",
        description: "Tap to dictate a note.",
        systemImage: "mic.badge.plus"
    )

    var configuration: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: StaticProvider()) { _ in
            ComplicationView(spec: self)
        }
        .configurationDisplayName(Text(title))
        .description(Text(description))
        .supportedFamilies([
            .accessoryCircular,
            .accessoryCorner,
            .accessoryInline,
            .accessoryRectangular,
        ])
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

struct ComplicationView: View {
    let spec: ComplicationSpec
    @Environment(\.widgetFamily) private var family

    var body: some View {
        content
            .widgetURL(spec.complication.url)
            // The circular and corner slots are a bare glyph; without this,
            // VoiceOver reads the symbol's name.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(spec.title))
            .containerBackground(for: .widget) { Color.clear }
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryInline:
            Label {
                Text(spec.shortTitle)
            } icon: {
                Image(systemName: spec.systemImage)
            }
        case .accessoryRectangular:
            HStack(spacing: 8) {
                Image(systemName: spec.systemImage)
                    .font(.title3)
                    .widgetAccentable()
                VStack(alignment: .leading, spacing: 0) {
                    Text(spec.title)
                        .font(.headline)
                    Text(spec.prompt)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .accessoryCorner:
            Image(systemName: spec.systemImage)
                .font(.title3)
                .widgetAccentable()
                .widgetLabel {
                    Text(spec.shortTitle)
                }
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: spec.systemImage)
                    .font(.title3)
                    .widgetAccentable()
            }
        default:
            // Only the families listed in `supportedFamilies` are ever
            // requested.
            EmptyView()
        }
    }
}

#Preview("Ask — circular", as: .accessoryCircular) {
    AskComplication()
} timeline: {
    StaticEntry(date: .now)
}

#Preview("Ask — corner", as: .accessoryCorner) {
    AskComplication()
} timeline: {
    StaticEntry(date: .now)
}

#Preview("Ask — inline", as: .accessoryInline) {
    AskComplication()
} timeline: {
    StaticEntry(date: .now)
}

#Preview("Ask — rectangular", as: .accessoryRectangular) {
    AskComplication()
} timeline: {
    StaticEntry(date: .now)
}

#Preview("Note — circular", as: .accessoryCircular) {
    NoteComplication()
} timeline: {
    StaticEntry(date: .now)
}

#Preview("Note — corner", as: .accessoryCorner) {
    NoteComplication()
} timeline: {
    StaticEntry(date: .now)
}

#Preview("Note — inline", as: .accessoryInline) {
    NoteComplication()
} timeline: {
    StaticEntry(date: .now)
}

#Preview("Note — rectangular", as: .accessoryRectangular) {
    NoteComplication()
} timeline: {
    StaticEntry(date: .now)
}
#endif
