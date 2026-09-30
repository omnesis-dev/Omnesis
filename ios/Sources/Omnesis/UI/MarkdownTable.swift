// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

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
    var copyValues: Bool = false
    var copyFont: UIFont = .systemFont(ofSize: 13)

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
                        cellText(cell(headers, column), header: true)
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
            .accessibilityRepresentation {
                if copyValues {
                    // Keep copy buttons reachable in the native cell order.
                    accessibilityCopyRows
                } else {
                    accessibilityRows
                }
            }
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

    @ViewBuilder
    private func cellText(_ raw: String, header: Bool = false) -> some View {
        if copyValues, !MarkdownCopyContent.values(in: raw).isEmpty {
            let descriptor = header
                ? copyFont.fontDescriptor.withSymbolicTraits(.traitBold) ?? copyFont.fontDescriptor
                : copyFont.fontDescriptor
            MarkdownCopyText(
                raw: raw,
                font: UIFont(descriptor: descriptor, size: copyFont.pointSize),
                color: header ? Theme.textSecondary : Theme.textPrimary
            )
        } else {
            Text(cache.inline(raw))
        }
    }

    private var accessibilityCopyRows: some View {
        VStack(alignment: .leading) {
            ForEach(Array(([headers] + rows).enumerated()), id: \.offset) { _, cells in
                ForEach(Array(cells.enumerated()), id: \.offset) { column, raw in
                    Text("\(plain(cell(headers, column))): \(plain(raw))")
                    ForEach(Array(MarkdownCopyContent.values(in: raw).enumerated()), id: \.offset) { _, value in
                        MarkdownCodeCopyButton(value: value)
                            .accessibilityLabel("Copy \(value)")
                    }
                }
            }
        }
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

#if DEBUG
#Preview("Markdown table — copyable values") {
    ScrollView {
        MarkdownView(text: PreviewMocks.copyableMarkdown, copyValues: true)
            .padding()
    }
    .background(Theme.bgPrimary)
}
#endif
#endif
