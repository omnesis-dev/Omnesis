// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The table arithmetic on its own: column caps, ragged rows, row heights and
/// the mirrored column order. The layout that renders a table supplies only
/// the two measurements these tests hand in as closures.
final class MarkdownTableMetricsTests: XCTestCase {
    private func measure(
        columns: Int,
        naturalWidths: [CGFloat],
        maxCellWidth: CGFloat = 220,
        height: @escaping (Int, CGFloat) -> CGFloat = { _, _ in 20 }
    )
        -> MarkdownTableMetrics {
        MarkdownTableMetrics.measure(
            columns: columns,
            cellCount: naturalWidths.count,
            maxCellWidth: maxCellWidth,
            spacing: MarkdownTableSpacing(horizontal: 20, vertical: 7),
            cells: MarkdownTableCellMeasure(naturalWidth: { naturalWidths[$0] }, height: height)
        )
    }

    func testAColumnIsAsWideAsItsWidestCell() {
        let metrics = measure(columns: 2, naturalWidths: [40, 60, 90, 10])

        XCTAssertEqual(metrics.columnWidths, [90, 60])
        XCTAssertEqual(metrics.width, 90 + 20 + 60)
    }

    func testACellPastTheCapIsGivenTheCapAndMeasuredAtIt() {
        var offered: [CGFloat] = []
        let metrics = measure(columns: 2, naturalWidths: [500, 30]) { _, width in
            offered.append(width)
            return width == 220 ? 60 : 20
        }

        XCTAssertEqual(metrics.columnWidths, [220, 30])
        XCTAssertEqual(offered, [220, 30])
        XCTAssertEqual(metrics.rowHeights, [60])
    }

    func testACellExactlyAtTheCapIsNotWrapped() {
        var offered: [CGFloat] = []
        let metrics = measure(columns: 1, naturalWidths: [220]) { _, width in
            offered.append(width)
            return 20
        }

        XCTAssertEqual(metrics.columnWidths, [220])
        XCTAssertEqual(offered, [220])
    }

    func testARaggedLastRowContributesOnlyTheCellsItHas() {
        let metrics = measure(columns: 3, naturalWidths: [10, 20, 30, 40, 50])

        XCTAssertEqual(metrics.columnWidths, [40, 50, 30])
        XCTAssertEqual(metrics.rowHeights.count, 2)
        XCTAssertEqual(metrics.position(ofCell: 4).row, 1)
        XCTAssertEqual(metrics.position(ofCell: 4).column, 1)
    }

    func testARowIsAsTallAsItsTallestCell() {
        let metrics = measure(columns: 2, naturalWidths: [10, 10, 10, 10]) { cell, _ in
            [12, 48, 20, 20][cell]
        }

        XCTAssertEqual(metrics.rowHeights, [48, 20])
        XCTAssertEqual(metrics.height, 48 + 7 + 20)
        XCTAssertEqual(metrics.rowMinY(1), 48 + 7)
    }

    func testColumnsAreMirroredRightToLeft() {
        let metrics = measure(columns: 3, naturalWidths: [100, 50, 30])

        XCTAssertEqual(metrics.columnMinX(0, rightToLeft: false), 0)
        XCTAssertEqual(metrics.columnMinX(1, rightToLeft: false), 120)
        XCTAssertEqual(metrics.columnMinX(2, rightToLeft: false), 190)
        // Mirrored: the first column sits against the trailing edge.
        XCTAssertEqual(metrics.columnMinX(0, rightToLeft: true), 120)
        XCTAssertEqual(metrics.columnMinX(1, rightToLeft: true), 50)
        XCTAssertEqual(metrics.columnMinX(2, rightToLeft: true), 0)
    }

    func testAnEmptyTableHasNoSize() {
        let metrics = measure(columns: 2, naturalWidths: [])

        XCTAssertEqual(metrics.width, 20)
        XCTAssertEqual(metrics.height, 0)
        XCTAssertTrue(metrics.rowHeights.isEmpty)
    }
}
