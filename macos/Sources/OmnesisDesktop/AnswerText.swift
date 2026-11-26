// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import SwiftUI

struct DesktopAnswerText: View {
    let text: String
    @State private var blocks: [DesktopAnswerBlock] = []
    @State private var inlineText: [String: AttributedString] = [:]
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let raw): inline(raw)
                case .heading(let raw): inline(raw).font(.system(size: 19, weight: .semibold)).padding(.top, 4)
                case .bullet(let raw): HStack(alignment: .top, spacing: 10) { Text("•").foregroundStyle(DesktopTheme.secondary)
                        inline(raw)
                    }
                case .numbered(let number, let raw): HStack(alignment: .top, spacing: 10) {
                        Text(number + ".").foregroundStyle(DesktopTheme.secondary)
                        inline(raw)
                    }
                case .quote(let raw): inline(raw).foregroundStyle(DesktopTheme.secondary).padding(.leading, 14)
                    .overlay(alignment: .leading) { Rectangle().fill(DesktopTheme.border).frame(width: 2) }
                case .code(let raw): ScrollView(.horizontal) {
                        Text(raw).font(.system(size: 13, design: .monospaced)).textSelection(.enabled).padding(14)
                    }.background(DesktopTheme.panel, in: RoundedRectangle(cornerRadius: 10))
                }
            }
        }.font(.system(size: 15)).lineSpacing(4).frame(maxWidth: .infinity, alignment: .leading)
            .tint(DesktopTheme.primary)
            .environment(\.openURL, OpenURLAction { url in DesktopAnswerBlock.allowsLink(url) ? .systemAction : .handled })
            .task(id: text) {
                let value = text
                // Streaming updates must not parse a long answer on the main actor.
                let worker = Task.detached(priority: .userInitiated) { DesktopPreparedAnswer(value) }
                let parsed = await withTaskCancellationHandler(operation: { await worker.value }, onCancel: { worker.cancel() })
                guard !Task.isCancelled else { return }
                inlineText = parsed.inline
                blocks = parsed.blocks
            }
    }

    private func inline(_ raw: String) -> Text {
        Text(inlineText[raw] ?? AttributedString(raw))
    }
}

private struct DesktopPreparedAnswer: Sendable {
    let blocks: [DesktopAnswerBlock]
    var inline: [String: AttributedString] = [:]
    init(_ text: String) {
        blocks = DesktopAnswerBlock.parse(text)
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        for block in blocks {
            guard !Task.isCancelled else { return }
            let raw: String
            switch block {
            case .paragraph(let value), .heading(let value), .bullet(let value), .quote(let value), .numbered(_, let value): raw = value
            case .code: continue
            }
            inline[raw] = (try? AttributedString(markdown: raw, options: options)) ?? AttributedString(raw)
        }
    }
}
