// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// The documents an answer cites, listed under that answer.
//
// Each row carries the document's title, source and date, then every link in
// full as text: a link is the most identifying thing a citation carries, so the
// operator reads the URL itself, never a label standing in for it. Only a
// released link is tappable. Against the draft, a citation the privacy check
// withheld keeps its row, dimmed and chipped "Withheld", and a field withheld
// from a kept citation is printed from the draft, struck through and tagged —
// so every mark reads without colour, and nothing withheld can be opened.

@available(iOS 17.0, *)
struct PrivacyCitationListView: View {
    let list: PrivacyCitationList

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(list.heading)
                .font(.system(size: 11, weight: .bold))
                .textCase(.uppercase)
                .kerning(0.7)
                .foregroundStyle(Theme.textMuted)
                .accessibilityAddTraits(.isHeader)
            ForEach([list.note, list.withheldNote].compactMap { $0 }, id: \.self) { note in
                Text(note)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(list.rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 {
                        Divider().overlay(Theme.borderLight)
                    }
                    PrivacyCitationRowView(row: row)
                }
            }
            .privacyQuoteSurface()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

@available(iOS 17.0, *)
private struct PrivacyCitationRowView: View {
    let row: PrivacyCitationRow

    /// Optional so the list renders wherever it is placed; without a store the
    /// source falls back to its type and a generic glyph.
    @Environment(AppStore.self) private var store: AppStore?
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            icon
                .opacity(row.removed ? 0.5 : 1)
            VStack(alignment: .leading, spacing: 3) {
                if row.removed {
                    PrivacyChip(text: "Withheld", tone: .kept)
                }
                titleText
                    .fixedSize(horizontal: false, vertical: true)
                metaText
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(row.links, id: \.label) { link in
                    linkLine(link)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, Theme.Spacing.sm)
        .accessibilityElement(children: .contain)
    }

    private var titleText: Text {
        let muted = row.removed || row.title == nil
        let title = Text(row.title ?? "Untitled")
            .font(.system(size: 13, weight: .semibold))
            .italic(row.title == nil)
            .strikethrough(row.titleWithheld)
            .foregroundStyle(muted || row.titleWithheld ? Theme.textMuted : Theme.textPrimary)
        return row.titleWithheld ? title + Text(" ") + withheldTag : title
    }

    private var metaText: Text {
        let source = Text(store?.sourceLabel(forSourceId: row.sourceType) ?? row.sourceType)
        let meta = { (text: Text) in text.font(.system(size: 11)).foregroundStyle(Theme.textMuted) }
        guard let date = row.date else { return meta(source) }
        let line = meta(source + Text(" · ") + Text(date).strikethrough(row.dateWithheld))
        return row.dateWithheld ? line + Text(" ") + withheldTag : line
    }

    private var withheldTag: Text {
        Text("withheld")
            .font(.system(size: 11, weight: .semibold))
            .italic()
            .foregroundStyle(PrivacyTone.kept.foreground)
    }

    @ViewBuilder
    private var icon: some View {
        if let store {
            SourceIconView(sourceId: row.sourceType, store: store, size: 16)
        } else {
            Image(systemName: "doc.text")
                .font(.system(size: 11))
                .frame(width: 16, height: 16)
                .foregroundStyle(Theme.textMuted)
                .accessibilityHidden(true)
        }
    }

    /// The label sits beside the URL; a tagged label is too wide for that on
    /// a phone, so it takes its own line and the URL keeps the full width.
    @ViewBuilder
    private func linkLine(_ link: PrivacyCitationLink) -> some View {
        if link.withheld {
            VStack(alignment: .leading, spacing: 1) {
                linkLabel(link)
                linkURL(link)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                linkLabel(link)
                    .fixedSize()
                linkURL(link)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func linkLabel(_ link: PrivacyCitationLink) -> Text {
        let label = Text(link.label.uppercased())
            .font(.system(size: 10, weight: .bold))
            .kerning(0.6)
            .foregroundStyle(Theme.textMuted)
        return link.withheld ? label + Text(" ") + withheldTag : label
    }

    @ViewBuilder
    private func linkURL(_ link: PrivacyCitationLink) -> some View {
        if link.struck {
            urlText(Text(link.text).strikethrough())
                .foregroundStyle(Theme.textMuted)
                .accessibilityLabel("\(link.label), withheld: \(link.text)")
        } else if link.openURLs.isEmpty {
            urlText(Text(link.text))
                .foregroundStyle(Theme.textSecondary)
        } else {
            Button {
                openFirst(link.openURLs[...])
            } label: {
                // The arrow rides at the end of the text, so a wrapped link
                // ends in it rather than carrying it beside its first line.
                urlText(Text(link.text) + Text(" ") + Text(Image(systemName: "arrow.up.right")))
                    .foregroundStyle(Theme.accent)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open \(link.text)")
        }
    }

    private func urlText(_ text: Text) -> some View {
        text
            .font(Theme.monospace(size: 11))
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Open the first of `urls` the system accepts, so an app link for an app
    /// this phone lacks falls through to the web link.
    private func openFirst(_ urls: ArraySlice<URL>) {
        guard let url = urls.first else { return }
        openURL(url) { accepted in
            if !accepted { openFirst(urls.dropFirst()) }
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
struct PrivacyCitationListGallery: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                ForEach(Array(PreviewMocks.privacyCitationLists.enumerated()), id: \.offset) { _, list in
                    PrivacyCitationListView(list: list)
                }
            }
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary)
    }
}

#Preview("Citations — draft, pending, shared, all withheld, edge cases") {
    PrivacyCitationListGallery()
        .environment(AppStore.preview())
        .omnesisColorScheme()
}

#Preview("Citations — without a store") {
    PrivacyCitationListGallery()
        .omnesisColorScheme()
}
#endif

#endif
