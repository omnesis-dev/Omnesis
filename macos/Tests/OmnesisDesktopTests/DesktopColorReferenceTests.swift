// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import CryptoKit
import Foundation
@testable import OmnesisDesktop
import SwiftUI
import XCTest

/// Diagnostic references share one actual window and the existing capture pipeline.
@MainActor
final class DesktopColorReferenceTests: XCTestCase {
    private enum Patch: String, CaseIterable {
        case appKitExplicit, swiftUILiteral, swiftUIWrapped, themeCanvas
    }

    private struct Observation {
        let appearance: NSAppearance.Name
        let frame: NSRect
        let centers: [NSPoint]
        let cache: NSBitmapImageRep
        let facts: [String: Any]
    }

    private static var explicit: NSColor {
        NSColor(srgbRed: 11.0 / 255, green: 21.0 / 255, blue: 36.0 / 255, alpha: 1)
    }

    private static var literal: Color {
        Color(.sRGB, red: 11.0 / 255, green: 21.0 / 255, blue: 36.0 / 255, opacity: 1)
    }

    func testActualNativeAndSwiftUIColorReferencesShareOpaqueCanvasRendering() async throws {
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        let size = CGSize(width: 600, height: 240)
        let name = "native-color-reference"
        let appearances: [NSAppearance.Name] = [.aqua, .darkAqua]
        let view = HStack(spacing: 0) {
            NativePatch(color: Self.explicit).frame(width: 150, height: 240)
            Self.literal.frame(width: 150, height: 240)
            Color(nsColor: Self.explicit).frame(width: 150, height: 240)
            DesktopTheme.canvas.frame(width: 150, height: 240)
        }.frame(width: size.width, height: size.height)
        var observations: [Observation] = []

        try await DesktopSnapshotRenderer.renderVisibleWindow(view, name: name, size: size) { hosting in
            let index = observations.count
            guard index < appearances.count else { throw ReferenceFailure.unexpectedCapture }
            let window = try XCTUnwrap(hosting.window)
            let cache = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: cache)
            let cachePNG = try XCTUnwrap(cache.representation(using: .png, properties: [:]))
            try cachePNG.write(to: output.appendingPathComponent("\(name)-reference-cache-\(appearances[index].rawValue).png"))
            let centers = Patch.allCases.indices.map { index in
                hosting.convert(NSPoint(x: CGFloat(index) * 150 + 75, y: 120), to: nil)
            }
            let logical: [NSColor] = [
                Self.explicit,
                NSColor(Self.literal),
                NSColor(Color(nsColor: Self.explicit)),
                NSColor(DesktopTheme.canvas),
            ]
            let facts: [String: Any] = try [
                "format": 1,
                "cachePNGHash": Self.digest(cachePNG),
                "patchOrder": Patch.allCases.map(\.rawValue),
                "logicalColors": logical.map { try Self.colorFacts($0) },
                "displayColorSpace": Self.spaceFacts(window.screen?.colorSpace),
                "backingScale": window.backingScaleFactor,
                "contentWidth": hosting.bounds.width, "contentHeight": hosting.bounds.height,
                "outerWidth": window.frame.width, "outerHeight": window.frame.height,
                "centersInWindow": centers.map { ["x": $0.x, "y": $0.y] },
                "cache": Self.pixels(cache, points: Patch.allCases.indices.map {
                    NSPoint(x: CGFloat($0) * 150 + 75, y: 120)
                }, extent: hosting.bounds.size),
            ]
            // Save the independent cache receipt before later own-window capture can fail.
            try Self.write(facts, to: output.appendingPathComponent("\(name)-cache-\(appearances[index].rawValue).json"))
            observations.append(Observation(
                appearance: appearances[index],
                frame: window.frame,
                centers: centers,
                cache: cache,
                facts: facts
            ))
        }

        XCTAssertEqual(observations.count, appearances.count)
        for observation in observations {
            let path = output.appendingPathComponent("\(name)-window-\(observation.appearance.rawValue).png")
            let png = try Data(contentsOf: path)
            let captured = try XCTUnwrap(NSBitmapImageRep(data: png))
            // Own-window PNGs include native chrome. Map actual window coordinates
            // through the measured output dimensions, not a guessed titlebar inset.
            let receipt = try Self.pixels(captured, points: observation.centers, extent: observation.frame.size)
            var facts = observation.facts
            facts["window"] = receipt
            facts["windowPNGHash"] = Self.digest(png)
            try Self.write(facts, to: output.appendingPathComponent("\(name)-comparison-\(observation.appearance.rawValue).json"))

            try Self.assertRelativeColors(observation.cache, points: Patch.allCases.indices.map {
                NSPoint(x: CGFloat($0) * 150 + 75, y: 120)
            }, extent: size)
            try Self.assertRelativeColors(captured, points: observation.centers, extent: observation.frame.size)
        }
    }

    private static func samplePoints(_ bitmap: NSBitmapImageRep, points: [NSPoint], extent: CGSize) throws -> [(Int, Int)] {
        guard extent.width > 0, extent.height > 0 else { throw ReferenceFailure.invalidMapping }
        let scaleX = CGFloat(bitmap.pixelsWide) / extent.width
        let scaleY = CGFloat(bitmap.pixelsHigh) / extent.height
        guard abs(scaleX - scaleY) < 0.01 else { throw ReferenceFailure.invalidMapping }
        return try points.map { point in
            let x = Int((point.x * scaleX).rounded(.down))
            let y = Int(((extent.height - point.y) * scaleY).rounded(.down))
            guard x >= 0, y >= 0, x < bitmap.pixelsWide, y < bitmap.pixelsHigh else { throw ReferenceFailure.invalidMapping }
            return (x, y)
        }
    }

    private static func pixels(_ bitmap: NSBitmapImageRep, points: [NSPoint], extent: CGSize) throws -> [String: Any] {
        guard bitmap.bitsPerSample > 0, bitmap.bitsPerSample <= 16,
              bitmap.samplesPerPixel > 0, bitmap.samplesPerPixel <= 5,
              !bitmap.isPlanar else { throw ReferenceFailure.unsupportedBitmap }
        let mapped = try samplePoints(bitmap, points: points, extent: extent)
        let rows: [[String: Any]] = try mapped.enumerated().map { index, point in
            var raw = [Int](repeating: 0, count: bitmap.samplesPerPixel)
            bitmap.getPixel(&raw, atX: point.0, y: point.1)
            let color = try XCTUnwrap(bitmap.colorAt(x: point.0, y: point.1))
            return try ["patch": Patch.allCases[index].rawValue, "x": point.0, "y": point.1, "raw": raw, "color": colorFacts(color)]
        }
        return [
            "width": bitmap.pixelsWide, "height": bitmap.pixelsHigh,
            "bitsPerSample": bitmap.bitsPerSample, "samplesPerPixel": bitmap.samplesPerPixel,
            "bitmapFormat": bitmap.bitmapFormat.rawValue,
            "hasAlpha": bitmap.hasAlpha, "colorSpace": spaceFacts(bitmap.colorSpace),
            "scaleX": CGFloat(bitmap.pixelsWide) / extent.width,
            "scaleY": CGFloat(bitmap.pixelsHigh) / extent.height,
            "samples": rows,
        ]
    }

    private static func assertRelativeColors(_ bitmap: NSBitmapImageRep, points: [NSPoint], extent: CGSize) throws {
        let mapped = try samplePoints(bitmap, points: points, extent: extent)
        let colors = try mapped.map { point in
            try XCTUnwrap(bitmap.colorAt(x: point.0, y: point.1)?.usingColorSpace(.sRGB))
        }
        let native = try XCTUnwrap(colors.first)
        for (index, color) in colors.enumerated() {
            XCTAssertEqual(color.alphaComponent, 1, accuracy: 0.01, Patch.allCases[index].rawValue)
            XCTAssertEqual(color.redComponent, native.redComponent, accuracy: 0.01, Patch.allCases[index].rawValue)
            XCTAssertEqual(color.greenComponent, native.greenComponent, accuracy: 0.01, Patch.allCases[index].rawValue)
            XCTAssertEqual(color.blueComponent, native.blueComponent, accuracy: 0.01, Patch.allCases[index].rawValue)
        }
    }

    private static func colorFacts(_ color: NSColor) throws -> [String: Any] {
        let converted = try XCTUnwrap(color.usingColorSpace(.sRGB))
        return [
            "sRGB": [converted.redComponent, converted.greenComponent, converted.blueComponent, converted.alphaComponent],
            "colorSpace": spaceFacts(color.colorSpace),
        ]
    }

    private static func spaceFacts(_ space: NSColorSpace?) -> [String: Any] {
        guard let space else { return ["present": false] }
        var facts: [String: Any] = ["present": true, "model": space.colorSpaceModel.rawValue, "components": space.numberOfColorComponents]
        if let profile = space.iccProfileData { facts["profileHash"] = digest(profile) }
        return facts
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func write(_ facts: [String: Any], to path: URL) throws {
        try JSONSerialization.data(withJSONObject: facts, options: [.sortedKeys]).write(to: path, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }

    private enum ReferenceFailure: Error { case unexpectedCapture, invalidMapping, unsupportedBitmap }

    private struct NativePatch: NSViewRepresentable {
        let color: NSColor
        func makeNSView(context: Context) -> PaintedView {
            PaintedView(color: color)
        }

        func updateNSView(_ view: PaintedView, context: Context) {
            view.color = color
            view.needsDisplay = true
        }
    }

    private final class PaintedView: NSView {
        var color: NSColor
        init(color: NSColor) {
            self.color = color
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            nil
        }

        override var isOpaque: Bool {
            true
        }

        override func draw(_ dirtyRect: NSRect) {
            color.setFill()
            NSBezierPath(rect: bounds).fill()
        }
    }
}
