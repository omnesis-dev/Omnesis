// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import XCTest

@MainActor
final class DesktopBrandAssetTests: XCTestCase {
    func testBundledMenuMarkHasStatusBarDimensionsAndTemplateRepresentations() throws {
        let image = try XCTUnwrap(Bundle.main.image(forResource: NSImage.Name("OmnesisMenuMark")))
        XCTAssertTrue(image.isValid)
        XCTAssertTrue(image.isTemplate)
        XCTAssertEqual(image.size.width, 18, accuracy: 0.01)
        XCTAssertEqual(image.size.height, 18, accuracy: 0.01)
        XCTAssertTrue(image.representations.contains { $0 is NSPDFImageRep }, "The status mark must retain its vector representation")
        for representation in image.representations {
            XCTAssertEqual(representation.size.width, 18, accuracy: 0.01)
            XCTAssertEqual(representation.size.height, 18, accuracy: 0.01)
        }
    }

    func testBundledSharedMarkHasValidNativeDimensionsAndRecordsItsRepresentations() throws {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "dev.omnesis.desktop")
        let image = try XCTUnwrap(Bundle.main.image(forResource: NSImage.Name("OmnesisMark")))
        XCTAssertTrue(image.isValid)
        let size = image.size
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else {
            return XCTFail("The bundled mark must have finite positive native dimensions")
        }
        let representations = image.representations
        XCTAssertFalse(representations.isEmpty)
        var details: [[String: Any]] = []
        for representation in representations.prefix(16) {
            let size = representation.size
            guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else {
                return XCTFail("The bundled mark representation must have finite positive dimensions")
            }
            let kind = representation is NSPDFImageRep ? "pdf" : representation is NSBitmapImageRep ? "bitmap" : "other"
            details.append([
                "kind": kind, "width": Double(size.width), "height": Double(size.height),
                "pixelsWide": representation.pixelsWide, "pixelsHigh": representation.pixelsHigh,
            ])
        }
        let facts: [String: Any] = [
            "asset": "OmnesisMark", "width": Double(size.width), "height": Double(size.height),
            "template": image.isTemplate, "representationCount": representations.count,
            "representationsTruncated": representations.count > 16, "representations": details,
        ]
        let json = try JSONSerialization.data(withJSONObject: facts, options: [.sortedKeys])
        let attachment = try XCTAttachment(string: XCTUnwrap(String(data: json, encoding: .utf8)))
        attachment.name = "shared-brand-mark-native-dimensions"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
