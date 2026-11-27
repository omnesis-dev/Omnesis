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
        case appKitExplicit, swiftUILiteral, swiftUIWrapped, themeCanvas, nativeBlack, nativeWhite, nativeInk
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
        for color in [Self.explicit, NSColor(Self.literal), NSColor(Color(nsColor: Self.explicit)), NSColor(DesktopTheme.canvas)] {
            try DesktopNativeColorReference.validateLogicalCanvas(color)
        }
        let width = size.width / CGFloat(Patch.allCases.count)
        let view = HStack(spacing: 0) {
            DesktopNativeColorReference.Brush(color: Self.explicit).frame(width: width, height: 240)
            Self.literal.frame(width: width, height: 240)
            Color(nsColor: Self.explicit).frame(width: width, height: 240)
            DesktopTheme.canvas.frame(width: width, height: 240)
            DesktopNativeColorReference.Brush(color: .black).frame(width: width, height: 240)
            DesktopNativeColorReference.Brush(color: .white).frame(width: width, height: 240)
            DesktopNativeColorReference.Brush(color: DesktopNativeColorReference.ink).frame(width: width, height: 240)
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
                hosting.convert(NSPoint(x: (CGFloat(index) + 0.5) * width, y: 120), to: nil)
            }
            let logical: [NSColor] = [
                Self.explicit,
                NSColor(Self.literal),
                NSColor(Color(nsColor: Self.explicit)),
                NSColor(DesktopTheme.canvas),
                .black, .white, DesktopNativeColorReference.ink,
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
                    NSPoint(x: (CGFloat($0) + 0.5) * width, y: 120)
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
                NSPoint(x: (CGFloat($0) + 0.5) * width, y: 120)
            }, extent: size)
            try Self.assertRelativeColors(captured, points: observation.centers, extent: observation.frame.size)
        }
    }

    func testNativeOracleRejectsUniformTransparentAndWrongLogicalInputs() throws {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 1, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ))
        @MainActor func paint(_ pixels: [[Int]]) throws -> [DesktopNativeColorReference.Pixel] {
            for (x, value) in pixels.enumerated() {
                var channels = value
                bitmap.setPixel(&channels, atX: x, y: 0)
            }
            return try (0 ..< 4).map { try DesktopNativeColorReference.pixel(bitmap, x: $0, y: 0) }
        }
        let canvas = [8, 24, 40, 255], black = [0, 0, 0, 255], white = [255, 255, 255, 255], ink = [233, 239, 247, 255]
        XCTAssertNoThrow(try DesktopNativeColorReference.validateControls(paint([canvas, black, white, ink])))
        XCTAssertThrowsError(try DesktopNativeColorReference.validateControls(paint(Array(repeating: black, count: 4))))
        XCTAssertThrowsError(try DesktopNativeColorReference.validateControls(paint(Array(repeating: canvas, count: 4))))
        XCTAssertThrowsError(try DesktopNativeColorReference.validateControls(paint([canvas, black, white, [233, 239, 247, 0]])))
        XCTAssertThrowsError(try DesktopNativeColorReference.validateLogicalCanvas(.red))
        try DesktopNativeColorReference.validateLogicalCanvas(Self.explicit)
        let expectedInk = DesktopNativeColorReference.Pixel(channels: ink.map { Double($0) / 255 })
        let background = try paint(Array(repeating: canvas, count: 4))
        XCTAssertFalse(background.contains { $0.matches(expectedInk) })
        XCTAssertThrowsError(try DesktopNativeColorReference.requireInk(
            bitmap,
            rect: NSRect(x: 0, y: 0, width: 4, height: 1),
            ink: expectedInk
        ))
        _ = try paint([canvas, ink, canvas, canvas])
        XCTAssertNoThrow(try DesktopNativeColorReference.requireInk(
            bitmap,
            rect: NSRect(x: 0, y: 0, width: 4, height: 1),
            ink: expectedInk
        ))
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
        let controls = try [0, 4, 5, 6].map { index in
            try DesktopNativeColorReference.pixel(bitmap, x: mapped[index].0, y: mapped[index].1)
        }
        try DesktopNativeColorReference.validateControls(controls)
        let native = try XCTUnwrap(colors.first)
        for (index, color) in colors.prefix(4).enumerated() {
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
}

/// A test-owned native brush is an output-pipeline reference, not an absolute display-calibration claim.
@MainActor
enum DesktopNativeColorReference {
    static let accuracy = 0.01
    static var canvas: NSColor {
        NSColor(srgbRed: 11.0 / 255, green: 21.0 / 255, blue: 36.0 / 255, alpha: 1)
    }

    static var ink: NSColor {
        NSColor(srgbRed: 233.0 / 255, green: 239.0 / 255, blue: 247.0 / 255, alpha: 1)
    }

    @MainActor struct Pixel {
        let channels: [Double]
        func matches(_ other: Pixel) -> Bool {
            channels.count == 4 && other.channels.count == 4 && zip(channels, other.channels).allSatisfy { pair in
                pair.0.isFinite && pair.1.isFinite && abs(pair.0 - pair.1) <= accuracy
            }
        }
    }

    @MainActor struct Reference {
        let canvas: Pixel
        let ink: Pixel
        let screen: NSScreen
        let screenProfile: String
        let outputProfile: String
        let backingScale: CGFloat
        let appearance: NSAppearance.Name
    }

    enum Failure: Error { case bitmap, logicalCanvas, controls, mapping, pipeline, emptyContent }

    static func validateLogicalCanvas(_ color: NSColor) throws {
        guard let actual = color.usingColorSpace(.sRGB),
              Pixel(channels: [
                  Double(actual.redComponent),
                  Double(actual.greenComponent),
                  Double(actual.blueComponent),
                  Double(actual.alphaComponent),
              ])
              .matches(Pixel(channels: [11.0 / 255, 21.0 / 255, 36.0 / 255, 1])) else { throw Failure.logicalCanvas }
    }

    static func pixel(_ bitmap: NSBitmapImageRep, x: Int, y: Int) throws -> Pixel {
        guard bitmap.bitsPerSample == 8, bitmap.samplesPerPixel == 4, bitmap.hasAlpha, !bitmap.isPlanar,
              x >= 0, y >= 0, x < bitmap.pixelsWide, y < bitmap.pixelsHigh else { throw Failure.bitmap }
        var values = [Int](repeating: 0, count: 4)
        bitmap.getPixel(&values, atX: x, y: y)
        let rgba = bitmap.bitmapFormat.contains(.alphaFirst) ? Array(values.dropFirst()) + [values[0]] : values
        return Pixel(channels: rgba.map { Double($0) / 255 })
    }

    static func validateControls(_ colors: [Pixel]) throws {
        guard colors.count == 4,
              colors.allSatisfy({ $0.channels.count == 4 && abs($0.channels[3] - 1) <= accuracy }),
              colors[1].matches(Pixel(channels: [0, 0, 0, 1])),
              colors[2].matches(Pixel(channels: [1, 1, 1, 1])),
              !colors[0].matches(colors[1]), !colors[0].matches(colors[2]),
              !colors[3].matches(colors[0]), !colors[3].matches(colors[1]), !colors[3].matches(colors[2]) else { throw Failure.controls }
    }

    static func capture(for target: NSWindow, output: URL) async throws -> Reference {
        try validateLogicalCanvas(NSColor(DesktopTheme.canvas))
        try validateLogicalCanvas(canvas)
        let screen = try XCTUnwrap(target.screen)
        let screenProfile = try profile(screen.colorSpace)
        let appearance = try XCTUnwrap(target.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]))
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 160))
        let colors: [NSColor] = [canvas, .black, .white, ink]
        for (index, color) in colors.enumerated() {
            let patch = PaintedView(color: color)
            patch.frame = NSRect(x: CGFloat(index) * 100, y: 0, width: 100, height: 160)
            view.addSubview(patch)
        }
        let window = NSWindow(
            contentRect: view.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.title = "Native color reference"
        window.appearance = target.effectiveAppearance
        window.backgroundColor = canvas
        window.contentView = view
        defer { window.contentView = nil
            window.close()
        }
        window.setFrameOrigin(NSPoint(
            x: screen.visibleFrame.midX - window.frame.width / 2,
            y: screen.visibleFrame.midY - window.frame.height / 2
        ))
        window.makeKeyAndOrderFront(nil)
        view.displayIfNeeded()
        guard window.screen === screen, screen.visibleFrame.contains(window.frame) else { throw Failure.pipeline }
        DesktopSnapshotRenderer.assertOwnedWindowChrome(window)
        let name = "search-document-native-reference"
        try await DesktopSnapshotRenderer.captureOwnedWindow(
            window, output: output, name: name, appearance: .darkAqua, requireActive: true
        )
        let data = try Data(contentsOf: output.appendingPathComponent("\(name)-window-NSAppearanceNameDarkAqua.png"))
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: data))
        let centers = (0 ..< 4).map { view.convert(NSPoint(x: CGFloat($0) * 100 + 50, y: 80), to: nil) }
        let samples = try centers.map { point in
            let location = try mappedRect(
                NSRect(origin: point, size: CGSize(width: 1, height: 1)),
                bitmap: bitmap,
                extent: window.frame.size
            )
            return try pixel(bitmap, x: Int(location.minX), y: Int(location.minY))
        }
        let outputProfile = try profile(bitmap.colorSpace)
        let receipt: [String: Any] = [
            "format": 1, "purpose": "native-output-reference-not-absolute-display-calibration",
            "screenProfileHash": screenProfile, "outputProfileHash": outputProfile,
            "targetEffectiveAppearance": appearance.rawValue,
            "referenceEffectiveAppearance": window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])?.rawValue ?? "unknown",
            "backingScale": window.backingScaleFactor, "pixelWidth": bitmap.pixelsWide, "pixelHeight": bitmap.pixelsHigh,
            "windowWidth": window.frame.width, "windowHeight": window.frame.height,
            "centersInWindow": centers.map { ["x": $0.x, "y": $0.y] },
            "samplesRGBA": samples.map(\.channels), "pngHash": digest(data),
        ]
        try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys])
            .write(to: output.appendingPathComponent(name + ".json"), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.appendingPathComponent(name + ".json").path)
        try validateControls(samples)
        guard view.bounds.size == CGSize(width: 400, height: 160), target.screen === screen, window.screen === screen,
              try profile(screen.colorSpace) == screenProfile,
              window.backingScaleFactor == target.backingScaleFactor,
              window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == appearance,
              target.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == appearance else { throw Failure.pipeline }
        return Reference(
            canvas: samples[0],
            ink: samples[3],
            screen: screen,
            screenProfile: screenProfile,
            outputProfile: outputProfile,
            backingScale: window.backingScaleFactor,
            appearance: appearance
        )
    }

    static func validatePipeline(_ bitmap: NSBitmapImageRep, window: NSWindow, reference: Reference) throws {
        guard window.screen === reference.screen, window.backingScaleFactor == reference.backingScale,
              window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == reference.appearance,
              try profile(window.screen?.colorSpace) == reference.screenProfile,
              try profile(bitmap.colorSpace) == reference.outputProfile else { throw Failure.pipeline }
    }

    static func mappedRect(_ local: NSRect, bitmap: NSBitmapImageRep, extent: CGSize) throws -> NSRect {
        guard extent.width.isFinite, extent.height.isFinite, extent.width > 0, extent.height > 0,
              local.minX.isFinite, local.minY.isFinite, local.width.isFinite, local.height.isFinite,
              local.width > 0, local.height > 0, NSRect(origin: .zero, size: extent).contains(local) else { throw Failure.mapping }
        let scaleX = CGFloat(bitmap.pixelsWide) / extent.width, scaleY = CGFloat(bitmap.pixelsHigh) / extent.height
        guard abs(scaleX - scaleY) < CGFloat(accuracy) else { throw Failure.mapping }
        let rect = NSRect(
            x: local.minX * scaleX,
            y: (extent.height - local.maxY) * scaleY,
            width: local.width * scaleX,
            height: local.height * scaleY
        ).integral
        guard NSRect(x: 0, y: 0, width: CGFloat(bitmap.pixelsWide), height: CGFloat(bitmap.pixelsHigh)).contains(rect)
        else { throw Failure.mapping }
        return rect
    }

    static func requireInk(_ bitmap: NSBitmapImageRep, rect: NSRect, ink: Pixel) throws {
        guard rect.minX.isFinite, rect.minY.isFinite, rect.maxX.isFinite, rect.maxY.isFinite,
              rect.width > 0, rect.height > 0, bitmap.pixelsWide <= 4096, bitmap.pixelsHigh <= 4096,
              NSRect(x: 0, y: 0, width: CGFloat(bitmap.pixelsWide), height: CGFloat(bitmap.pixelsHigh)).contains(rect)
        else { throw Failure.mapping }
        for y in Int(rect.minY) ..< Int(rect.maxY) {
            for x in Int(rect.minX) ..< Int(rect.maxX) {
                if try pixel(bitmap, x: x, y: y).matches(ink) { return }
            }
        }
        throw Failure.emptyContent
    }

    private static func profile(_ space: NSColorSpace?) throws -> String {
        guard let data = space?.iccProfileData else { throw Failure.pipeline }
        return digest(data)
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    struct Brush: NSViewRepresentable {
        let color: NSColor
        func makeNSView(context: Context) -> PaintedView {
            PaintedView(color: color)
        }

        func updateNSView(_ view: PaintedView, context: Context) {
            view.color = color
            view.needsDisplay = true
        }
    }

    final class PaintedView: NSView {
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
