// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The geometry of a rendered Markdown table: column widths, row heights and
/// where each cell goes. Computed from numbers alone — a cell's natural
/// single-line width and its height at a given width — so the arithmetic is
/// testable without a view or a simulator, and `MarkdownTable`'s layout only
/// supplies the measurements.
struct MarkdownTableMetrics: Equatable {
    let columnWidths: [CGFloat]
    let rowHeights: [CGFloat]
    let spacing: MarkdownTableSpacing

    var width: CGFloat {
        columnWidths.reduce(0, +) + CGFloat(max(columnWidths.count - 1, 0)) * spacing.horizontal
    }

    var height: CGFloat {
        rowHeights.reduce(0, +) + CGFloat(max(rowHeights.count - 1, 0)) * spacing.vertical
    }

    /// Cells fill the grid in reading order.
    func position(ofCell index: Int) -> (row: Int, column: Int) {
        (row: index / columnWidths.count, column: index % columnWidths.count)
    }

    /// The x of a column's leading edge from the table's own leading edge.
    /// Right-to-left mirrors the column order, so the first column sits at the
    /// trailing side and the arithmetic is the same table read backwards.
    func columnMinX(_ column: Int, rightToLeft: Bool) -> CGFloat {
        let leading = columnWidths.prefix(column).reduce(0, +) + CGFloat(column) * spacing.horizontal
        return rightToLeft ? width - leading - columnWidths[column] : leading
    }

    func rowMinY(_ row: Int) -> CGFloat {
        rowHeights.prefix(row).reduce(0, +) + CGFloat(row) * spacing.vertical
    }

    /// Measure a table of `cellCount` cells laid out in `columns` columns. A
    /// column is as wide as its widest cell's natural width, capped at
    /// `maxCellWidth`; every cell is then given its column's width — so a cell
    /// past the cap wraps — and a row is as tall as its tallest cell. A count
    /// that is not a whole number of rows gets a final short row; the missing
    /// cells contribute nothing.
    static func measure(
        columns: Int,
        cellCount: Int,
        maxCellWidth: CGFloat,
        spacing: MarkdownTableSpacing,
        cells: MarkdownTableCellMeasure
    )
        -> MarkdownTableMetrics {
        precondition(columns > 0, "a table has at least one column")
        let rowCount = (cellCount + columns - 1) / columns
        var columnWidths = [CGFloat](repeating: 0, count: columns)
        for cell in 0 ..< cellCount {
            let column = cell % columns
            columnWidths[column] = max(columnWidths[column], min(cells.naturalWidth(cell), maxCellWidth))
        }
        var rowHeights = [CGFloat](repeating: 0, count: rowCount)
        for cell in 0 ..< cellCount {
            let row = cell / columns
            rowHeights[row] = max(rowHeights[row], cells.height(cell, columnWidths[cell % columns]))
        }
        return MarkdownTableMetrics(columnWidths: columnWidths, rowHeights: rowHeights, spacing: spacing)
    }
}

/// The gaps between columns and between rows.
struct MarkdownTableSpacing: Equatable {
    let horizontal: CGFloat
    let vertical: CGFloat
}

/// How a cell is measured: its natural single-line width, and its height once
/// it is given a width to wrap in. Cells are addressed by their index in
/// reading order.
struct MarkdownTableCellMeasure {
    let naturalWidth: (_ cell: Int) -> CGFloat
    let height: (_ cell: Int, _ width: CGFloat) -> CGFloat
}
