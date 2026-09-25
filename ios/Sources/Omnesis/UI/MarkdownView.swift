// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Lightweight, dependency-free Markdown renderer used wherever the
/// gateway hands us markdown body content (document detail body,
/// search snippet preview, etc.). Mirrors what the portal does with
/// `marked.js`: inline emphasis / links / inline code via SwiftUI's
/// built-in `AttributedString(markdown:)`, plus block-level handling
/// for headings, bullet / numbered lists, fenced code, and
/// blockquotes.
///
/// Intentionally limited — anything more elaborate (tables, nested
/// lists, image embeds) belongs in a real markdown library if we ever
/// need it. For now this matches what document bodies actually carry.
@available(iOS 17.0, *)
struct MarkdownView: View {
    let text: String
    var bodyFont: Font = .system(size: 14)
    /// The face headings are set in. Headings size themselves off their level
    /// rather than off `bodyFont`, so a caller setting the body in a
    /// non-default face passes the face here too and the block reads as one.
    var headingDesign: Font.Design = .default

    @State private var cache = MarkdownCache()

    var body: some View {
        let blocks = cache.blocks(for: text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let raw):
            Text(cache.inline(raw))
                .font(headingFont(level))
                .foregroundStyle(Theme.textPrimary)
        case .paragraph(let raw):
            Text(cache.inline(raw))
                .font(bodyFont)
                .foregroundStyle(Theme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        case .bulletList(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Text(cache.inline(item))
                        .font(bodyFont)
                        .foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 18)
                        .overlay(alignment: .topLeading) {
                            Text("•").font(bodyFont).foregroundStyle(Theme.textMuted)
                        }
                }
            }
        case .orderedList(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                    Text(cache.inline(item))
                        .font(bodyFont)
                        .foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 26)
                        .overlay(alignment: .topLeading) {
                            Text("\(idx + 1).")
                                .font(bodyFont)
                                .foregroundStyle(Theme.textMuted)
                                .monospacedDigit()
                        }
                }
            }
        case .quote(let raw):
            Text(cache.inline(raw))
                .font(bodyFont)
                .italic()
                .foregroundStyle(Theme.textSecondary)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(Theme.borderLight)
                        .frame(width: 3)
                }
        case .code(let raw):
            Text(raw)
                .font(Theme.monospace(size: 13))
                .foregroundStyle(Theme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Theme.bgTertiary)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .textSelection(.enabled)
        case .table(let headers, let rows):
            MarkdownTable(headers: headers, rows: rows, bodyFont: bodyFont, cache: cache)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .system(size: 22, weight: .bold, design: headingDesign)
        case 2: .system(size: 19, weight: .bold, design: headingDesign)
        case 3: .system(size: 17, weight: .semibold, design: headingDesign)
        default: .system(size: 15, weight: .semibold, design: headingDesign)
        }
    }
}

/// Render a GFM table as a flat, borderless grid: no background, no rules
/// between rows, the header set apart by a muted semibold face and one
/// hairline beneath it. Columns line up across rows, a long cell wraps
/// instead of stretching its column to a single line, and a table still wider
/// than the container scrolls horizontally inside its own bounds.
@available(iOS 17.0, *)
struct MarkdownTable: View {
    let headers: [String]
    let rows: [[String]]
    var bodyFont: Font = .system(size: 13)
    let cache: MarkdownCache

    /// The widest a cell may grow before its text wraps. A single sentence in
    /// one cell must not push every other column off the screen, and this is
    /// about the width the phone has left for the other columns.
    static let maxCellWidth: CGFloat = 220

    private var columnCount: Int {
        max(headers.count, rows.map(\.count).max() ?? 0)
    }

    var body: some View {
        if columnCount > 0 {
            ScrollView(.horizontal, showsIndicators: false) {
                MarkdownTableLayout(
                    columns: columnCount,
                    maxCellWidth: Self.maxCellWidth,
                    spacing: MarkdownTableSpacing(horizontal: 20, vertical: 7)
                ) {
                    ForEach(0 ..< columnCount, id: \.self) { column in
                        cellText(cell(headers, column))
                            .font(bodyFont.weight(.semibold))
                            .foregroundStyle(Theme.textSecondary)
                    }
                    Rectangle()
                        .fill(Theme.borderLight)
                        .frame(height: 1)
                        .layoutValue(key: MarkdownTableRole.self, value: .headerRule)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, cells in
                        ForEach(0 ..< columnCount, id: \.self) { column in
                            cellText(cell(cells, column))
                                .font(bodyFont)
                                .foregroundStyle(Theme.textPrimary)
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            .menuRevealExcluded()
            .accessibilityRepresentation { accessibilityRows }
        }
    }

    /// What VoiceOver reads: the header as one element, then each row as one
    /// element that pairs every cell with its column heading. The cells are
    /// laid out flat so the columns can line up, which leaves no row view to
    /// group, so the rows are described here instead.
    private var accessibilityRows: some View {
        VStack(alignment: .leading) {
            Text((0 ..< columnCount).map { plain(cell(headers, $0)) }.joined(separator: ", "))
            ForEach(Array(rows.enumerated()), id: \.offset) { _, cells in
                Text(
                    (0 ..< columnCount)
                        .map { "\(plain(cell(headers, $0))): \(plain(cell(cells, $0)))" }
                        .joined(separator: ", ")
                )
            }
        }
    }

    private func cell(_ cells: [String], _ column: Int) -> String {
        column < cells.count ? cells[column] : ""
    }

    private func cellText(_ raw: String) -> Text {
        Text(cache.inline(raw))
    }

    private func plain(_ raw: String) -> String {
        String(cache.inline(raw).characters)
    }
}

/// What a subview of `MarkdownTableLayout` is: a cell, filling the grid in
/// reading order, or the one rule drawn beneath the header row.
private enum MarkdownTableRole: LayoutValueKey {
    case cell
    case headerRule

    static let defaultValue = MarkdownTableRole.cell
}

/// Lays cells out as a grid whose columns line up across rows, with the
/// arithmetic in `MarkdownTableMetrics` and only the measuring here.
///
/// A horizontal `ScrollView` proposes an unbounded width to its content, and
/// `Grid` hands that proposal on to every cell, so one long cell becomes a
/// single line wider than the screen and the other columns land out of view.
/// This layout measures the cells itself and never passes a proposal through:
/// a cell is offered its column's width, capped, whatever the container
/// proposed. The metrics therefore depend on the cells alone, and are cached
/// per subview set — a streamed reply lays this out on every token, and the
/// cells are measured once rather than twice per pass.
@available(iOS 17.0, *)
private struct MarkdownTableLayout: Layout {
    let columns: Int
    let maxCellWidth: CGFloat
    let spacing: MarkdownTableSpacing

    func makeCache(subviews: Subviews) -> MarkdownTableMetrics {
        let cells = subviews.filter { $0[MarkdownTableRole.self] == .cell }
        return MarkdownTableMetrics.measure(
            columns: columns,
            cellCount: cells.count,
            maxCellWidth: maxCellWidth,
            spacing: spacing,
            cells: MarkdownTableCellMeasure(
                naturalWidth: { cells[$0].sizeThatFits(.unspecified).width },
                height: { cells[$0].sizeThatFits(ProposedViewSize(width: $1, height: nil)).height }
            )
        )
    }

    func updateCache(_ cache: inout MarkdownTableMetrics, subviews: Subviews) {
        cache = makeCache(subviews: subviews)
    }

    func sizeThatFits(
        proposal _: ProposedViewSize,
        subviews _: Subviews,
        cache: inout MarkdownTableMetrics
    )
        -> CGSize {
        CGSize(width: cache.width, height: cache.height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal _: ProposedViewSize,
        subviews: Subviews,
        cache: inout MarkdownTableMetrics
    ) {
        let rightToLeft = subviews.layoutDirection == .rightToLeft
        var cellIndex = 0
        for subview in subviews {
            switch subview[MarkdownTableRole.self] {
            case .headerRule:
                // Centred in the gap after the header row, which is the first
                // row by construction, spanning every column.
                let ruleY = bounds.minY + (cache.rowHeights.first ?? 0) + spacing.vertical / 2
                subview.place(
                    at: CGPoint(x: bounds.minX, y: ruleY),
                    anchor: .leading,
                    proposal: ProposedViewSize(width: cache.width, height: nil)
                )
            case .cell:
                let (row, column) = cache.position(ofCell: cellIndex)
                subview.place(
                    at: CGPoint(
                        x: bounds.minX + cache.columnMinX(column, rightToLeft: rightToLeft),
                        y: bounds.minY + cache.rowMinY(row)
                    ),
                    anchor: .topLeading,
                    proposal: ProposedViewSize(
                        width: cache.columnWidths[column],
                        height: cache.rowHeights[row]
                    )
                )
                cellIndex += 1
            }
        }
    }
}

/// Per-`MarkdownView` memoization for streaming markdown. Two
/// optimizations live here:
///
/// 1. **Incremental block parse.** When `text` grows by appending
///    (the streaming case), only the suffix after the last `\n\n`
///    boundary in the previous text is re-parsed; the prefix
///    parses to identical blocks every time so we keep them
///    verbatim. Without this, a 1800-char streamed response with
///    ~460 deltas does ~460 full parses (O(n²) total work).
///
/// 2. **Inline-attribute cache.** `AttributedString(markdown:)` is
///    the Foundation parser and is the actual hot path inside each
///    block render. Cells / paragraphs that already rendered once
///    return from the cache.
///
/// Owned by `MarkdownView` via `@State`, so its lifetime matches
/// the message bubble. SwiftUI doesn't observe internal mutation
/// (we don't want it to — the cache is transparent to the view's
/// identity, and re-renders are driven by `text` changing).
///
/// Single-threaded: SwiftUI body always runs on the main actor.
@available(iOS 17.0, *)
@MainActor
final class MarkdownCache {
    private var lastText: String = ""
    private var lastBlocks: [MarkdownBlock] = []

    /// Prefix of `lastText` that ends at a definitive block
    /// boundary (the last `\n\n` in the source). Blocks parsed
    /// from this prefix are stable across future appends.
    private var stableText: String = ""
    private var stableBlocks: [MarkdownBlock] = []

    private var inlineCache: [String: AttributedString] = [:]
    private let inlineCacheCap = 512

    func blocks(for text: String) -> [MarkdownBlock] {
        if text == lastText { return lastBlocks }

        if text.hasPrefix(stableText), text.count >= stableText.count {
            extendStablePrefix(from: text)
            let suffixStart = text.index(text.startIndex, offsetBy: stableText.count)
            let suffix = String(text[suffixStart...])
            let suffixBlocks = MarkdownParser.parse(suffix)
            lastText = text
            lastBlocks = stableBlocks + suffixBlocks
            return lastBlocks
        }

        // Non-append divergence (edit / reset) — full re-parse and reset prefix.
        let blocks = MarkdownParser.parse(text)
        lastText = text
        lastBlocks = blocks
        if let boundary = lastBlankLineBoundary(in: text) {
            stableText = String(text[..<boundary])
            stableBlocks = MarkdownParser.parse(stableText)
        } else {
            stableText = ""
            stableBlocks = []
        }
        return blocks
    }

    func inline(_ raw: String) -> AttributedString {
        if let cached = inlineCache[raw] { return cached }
        let opts = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        // Speculatively close any half-typed trailing construct so a
        // mid-stream link styles its label immediately instead of
        // showing raw `[label](https://… until the `)` lands. The
        // synthetic closer is markup, so it's consumed (never shown);
        // if parsing fails we fall back to the untouched original.
        let completed = MarkdownStreaming.completeTrailingMarkup(raw)
        let parsed = (try? AttributedString(markdown: completed, options: opts)) ?? AttributedString(raw)
        if inlineCache.count >= inlineCacheCap {
            inlineCache.removeAll(keepingCapacity: true)
        }
        inlineCache[raw] = parsed
        return parsed
    }

    /// If `text` contains a `\n\n` boundary past the current stable
    /// prefix, grow `stableText` / `stableBlocks` to cover the new
    /// closed-block region.
    private func extendStablePrefix(from text: String) {
        guard let boundary = lastBlankLineBoundary(in: text) else { return }
        let candidateLength = text.distance(from: text.startIndex, to: boundary)
        if candidateLength <= stableText.count { return }
        let oldEnd = text.index(text.startIndex, offsetBy: stableText.count)
        let newStableSlice = String(text[oldEnd ..< boundary])
        let newBlocks = MarkdownParser.parse(newStableSlice)
        stableBlocks.append(contentsOf: newBlocks)
        stableText = String(text[..<boundary])
    }

    /// Index just after the last `\n\n` in `text`, or nil if none.
    /// Caveat: doesn't track unclosed fenced code blocks — a `\n\n`
    /// inside an open ```...``` is wrongly treated as a boundary.
    /// That's a perf miss (the code block gets re-parsed on each
    /// later delta), not a correctness bug: the parser yields the
    /// same blocks once the fence closes.
    private func lastBlankLineBoundary(in text: String) -> String.Index? {
        guard let range = text.range(of: "\n\n", options: .backwards) else { return nil }
        return range.upperBound
    }
}

enum MarkdownBlock: Equatable {
    case heading(Int, String)
    case paragraph(String)
    case bulletList([String])
    case orderedList([String])
    case quote(String)
    case code(String)
    /// GFM-style table — headers then rows of cells. The alignment row
    /// (`---|---`) is consumed by the parser and dropped; alignment
    /// rendering is left to the renderer (currently left-aligned for
    /// every cell — good enough for the agent's structured answers).
    case table(headers: [String], rows: [[String]])
}

enum MarkdownParser {
    /// Split markdown into block-level chunks. Block boundaries are blank
    /// lines, fenced-code openers, list-item runs, and heading lines.
    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                i += 1
                continue
            }
            if trimmed.hasPrefix("```") {
                i += 1
                var codeLines: [String] = []
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    codeLines.append(lines[i])
                    i += 1
                }
                if i < lines.count { i += 1 } // skip closing fence
                blocks.append(.code(codeLines.joined(separator: "\n")))
                continue
            }
            if let h = headingLevel(trimmed) {
                let body = String(trimmed.dropFirst(h + 1))
                blocks.append(.heading(h, body))
                i += 1
                continue
            }
            if isTableHeader(line: trimmed, next: i + 1 < lines.count ? lines[i + 1].trimmingCharacters(in: .whitespaces) : "") {
                let headers = splitRow(trimmed)
                i += 2 // skip header + alignment line
                var rows: [[String]] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix("|") else { break }
                    rows.append(splitRow(t))
                    i += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }
            if trimmed.hasPrefix("> ") {
                var quoteLines: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix("> ") else { break }
                    quoteLines.append(String(t.dropFirst(2)))
                    i += 1
                }
                blocks.append(.quote(quoteLines.joined(separator: " ")))
                continue
            }
            if isBullet(trimmed) {
                var items: [String] = []
                while i < lines.count, isBullet(lines[i].trimmingCharacters(in: .whitespaces)) {
                    items.append(stripBullet(lines[i].trimmingCharacters(in: .whitespaces)))
                    i += 1
                }
                blocks.append(.bulletList(items))
                continue
            }
            if isOrderedItem(trimmed) {
                var items: [String] = []
                while i < lines.count, isOrderedItem(lines[i].trimmingCharacters(in: .whitespaces)) {
                    items.append(stripOrdered(lines[i].trimmingCharacters(in: .whitespaces)))
                    i += 1
                }
                blocks.append(.orderedList(items))
                continue
            }
            // Paragraph: gather adjacent non-empty, non-block-marker lines.
            // Always consume the current line — the outer dispatch has
            // already ruled out every other block type for it, so we
            // must make forward progress here. Without this guarantee,
            // a streamed source ending mid-heading (`"#"` / `"##"`,
            // before the space) would loop forever: outer fails to
            // match it as a heading (which needs `"# "`), paragraph's
            // break check fires on the same line, `i` never advances.
            var paraLines: [String] = [lines[i]]
            i += 1
            while i < lines.count {
                let t = lines[i].trimmingCharacters(in: .whitespaces)
                let next = i + 1 < lines.count
                    ? lines[i + 1].trimmingCharacters(in: .whitespaces)
                    : ""
                if t.isEmpty
                    || headingLevel(t) != nil
                    || t.hasPrefix("> ")
                    || t.hasPrefix("```")
                    || isBullet(t)
                    || isOrderedItem(t)
                    || isTableHeader(line: t, next: next) {
                    break
                }
                paraLines.append(lines[i])
                i += 1
            }
            blocks.append(.paragraph(paraLines.joined(separator: "\n")))
        }
        return blocks
    }

    private static func headingLevel(_ s: String) -> Int? {
        for level in (1 ... 6).reversed() {
            let prefix = String(repeating: "#", count: level) + " "
            if s.hasPrefix(prefix) { return level }
        }
        return nil
    }

    private static func isBullet(_ s: String) -> Bool {
        s.hasPrefix("- ") || s.hasPrefix("* ") || s.hasPrefix("+ ")
    }

    private static func stripBullet(_ s: String) -> String {
        String(s.dropFirst(2))
    }

    private static func isOrderedItem(_ s: String) -> Bool {
        // "1. foo" / "23. foo"
        guard let dotIdx = s.firstIndex(of: ".") else { return false }
        let head = s[s.startIndex ..< dotIdx]
        guard !head.isEmpty, head.allSatisfy(\.isNumber) else { return false }
        let after = s.index(after: dotIdx)
        return after < s.endIndex && s[after] == " "
    }

    private static func stripOrdered(_ s: String) -> String {
        guard let dotIdx = s.firstIndex(of: ".") else { return s }
        let after = s.index(s.index(after: dotIdx), offsetBy: 1, limitedBy: s.endIndex) ?? s.endIndex
        return String(s[after ..< s.endIndex])
    }

    /// A GFM table starts with a pipe-delimited header row followed by
    /// an alignment row whose cells are made of `-` (optionally with
    /// leading `:` and/or trailing `:` for alignment). We're loose on
    /// the alignment row format — anything with pipes + dashes counts.
    private static func isTableHeader(line: String, next: String) -> Bool {
        guard line.contains("|") else { return false }
        guard next.contains("|"), next.contains("-") else { return false }
        let cells = next
            .split(separator: "|", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        return !cells.isEmpty && cells.allSatisfy { cell in
            cell.allSatisfy { $0 == "-" || $0 == ":" }
        }
    }

    private static func splitRow(_ s: String) -> [String] {
        var trimmed = s
        if trimmed.hasPrefix("|") { trimmed = String(trimmed.dropFirst()) }
        if trimmed.hasSuffix("|") { trimmed = String(trimmed.dropLast()) }
        return trimmed
            .split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }
}

/// Streaming polish for incomplete inline markup.
///
/// While the agent's reply is mid-flight, the tail of the text often
/// holds a half-typed inline construct — most visibly a link whose
/// `](url` hasn't been closed with `)` yet. Handed to Foundation's
/// parser verbatim, that renders as raw `[label](https://exa…`
/// characters until the closing paren lands, then "pops" into a styled
/// link. Pre-closing the trailing open construct lets the parser style
/// it immediately: the link *label* becomes link-styled the moment
/// `](` is seen and never moves, while the URL (which lives in the
/// invisible destination attribute) streams in silently behind it.
///
/// Scoped to the single trailing open construct and self-correcting —
/// it's a guess that the next delta refines. Handles links and inline
/// code, the unambiguous, low-false-positive cases. Emphasis
/// (`*` / `_`) is deliberately left alone: a lone asterisk in prose
/// ("paid $5 * 3 times") is common enough that speculatively
/// italicising it would flicker more than it helps.
enum MarkdownStreaming {
    /// Append the closer for a trailing open inline construct, if any.
    /// Returns `text` unchanged when nothing is open, so complete
    /// (non-streaming) content renders exactly as before.
    static func completeTrailingMarkup(_ text: String) -> String {
        guard let closer = trailingCloser(text) else { return text }
        return text + closer
    }

    /// Scan once, tracking the minimal state needed to know which
    /// inline construct (if any) is still open at the end of `text`.
    /// Inline-code spans mask everything inside them, so they're
    /// tracked first; link brackets/parens are only interpreted
    /// outside code. Markdown requires `](` to be adjacent, so a `]`
    /// only arms a pending dest that the very next character must open.
    private static func trailingCloser(_ text: String) -> String? {
        let chars = Array(text)
        var openFenceLength = 0 // backtick-run length holding an open code span; 0 = not in code
        var labelOpen = false // saw `[` with no matching `]`
        var awaitingParen = false // saw `]`; a `(` immediately after opens the destination
        var destOpen = false // saw `](` with no closing `)`

        var idx = 0
        while idx < chars.count {
            let char = chars[idx]

            if char == "`" {
                var runLength = 0
                while idx < chars.count, chars[idx] == "`" {
                    runLength += 1
                    idx += 1
                }
                if openFenceLength == 0 {
                    openFenceLength = runLength
                } else if runLength == openFenceLength {
                    openFenceLength = 0
                }
                awaitingParen = false
                continue
            }

            if openFenceLength > 0 {
                // Inside an inline-code span — every other char is literal.
                idx += 1
                continue
            }

            switch char {
            case "\\":
                // Escape: the next char can't open or close markup.
                idx += 2
                awaitingParen = false
                continue
            case "[":
                labelOpen = true
                awaitingParen = false
            case "]":
                awaitingParen = labelOpen
                labelOpen = false
            case "(":
                if awaitingParen { destOpen = true }
                awaitingParen = false
            case ")":
                destOpen = false
                awaitingParen = false
            default:
                awaitingParen = false
            }
            idx += 1
        }

        if openFenceLength > 0 {
            return String(repeating: "`", count: openFenceLength)
        }
        if destOpen {
            return ")"
        }
        return nil
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Markdown — kitchen sink") {
    ScrollView {
        MarkdownView(text: """
        # Top-level heading

        A paragraph with **bold**, *italic*, and `inline code`. Also a [link](https://example.com).

        ## Lists

        - First item
        - Second **bold** item
        - Third with `code`

        1. Ordered one
        2. Ordered two

        ### Quote

        > A wise person once said something quotable.

        ## Code

        ```
        let x = 42
        print(x)
        ```

        End paragraph.
        """)
        .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Markdown — table wider than the phone") {
    ScrollView {
        MarkdownView(text: """
        ## Quarterly budget review

        | Line item | Owner | Q3 actual | Notes |
        | --- | --- | --- | --- |
        | Venue hire | Maya Reeves | 4,200 | Deposit paid in July; balance due at the end of the quarter |
        | Catering | Jamie Lopez | 1,850 | Vegetarian option added after the survey |
        | Travel and accommodation for the visiting speakers and the two facilitators | David Lin | 6,300 | Booked through the agency |
        | Printing | Sarah Mendez | 310 | — |
        """)
        .padding()
    }
    .background(Theme.bgPrimary)
    .omnesisColorScheme()
}

#Preview("Markdown — table, right to left") {
    ScrollView {
        MarkdownView(text: """
        | Line item | Owner | Q3 actual |
        | --- | --- | --- |
        | Venue hire | Maya Reeves | 4,200 |
        | Catering | Jamie Lopez | 1,850 |
        """)
        .padding()
    }
    .environment(\.layoutDirection, .rightToLeft)
    .background(Theme.bgPrimary)
    .omnesisColorScheme()
}

#Preview("Markdown — streaming link states") {
    // Successive prefixes of a streaming reply that ends in a link.
    // With trailing-markup completion, the label "the Q4 report" is
    // styled as a link the moment `](` is seen and never shows the raw
    // `[`, `](`, or URL — only the final row differs by being tappable
    // to the now-complete destination.
    let prefixes = [
        "Take a look at ",
        "Take a look at [the Q4 repor",
        "Take a look at [the Q4 report](https://exa",
        "Take a look at [the Q4 report](https://example.com/q4",
        "Take a look at [the Q4 report](https://example.com/q4-report) for details.",
    ]
    return ScrollView {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(prefixes.enumerated()), id: \.offset) { _, prefix in
                MarkdownView(text: prefix, bodyFont: .system(size: 15))
                Divider().overlay(Theme.borderLight)
            }
        }
        .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}
#endif
#endif
