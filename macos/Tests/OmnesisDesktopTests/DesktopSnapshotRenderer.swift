// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import SwiftUI
import XCTest

@MainActor
enum DesktopSnapshotRenderer {
    static func render(
        _ view: some View,
        name: String,
        size: CGSize,
        validate: ((NSView) throws -> Void)? = nil
    ) async throws {
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        var windows: [NSWindow] = []
        defer { for window in windows {
            window.close()
        } }
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let scheme: ColorScheme = appearance == .aqua ? .light : .dark
            let content = view.environment(\.colorScheme, scheme)
                .frame(width: size.width, height: size.height)
                .background(Color(nsColor: .windowBackgroundColor))
            let hosting = NSHostingView(rootView: content)
            hosting.sizingOptions = []
            hosting.autoresizingMask = [.width, .height]
            hosting.frame = NSRect(origin: .zero, size: size)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: appearance)
            window.contentView = hosting
            window.setContentSize(size)
            windows.append(window)
            window.makeKeyAndOrderFront(nil)
            // Yield the main actor so SwiftUI can resolve appearance and commit its first display.
            try await Task.sleep(for: .milliseconds(150))
            hosting.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            try await Task.sleep(for: .milliseconds(150))
            hosting.layoutSubtreeIfNeeded()
            hosting.displayIfNeeded()
            XCTAssertEqual(hosting.bounds.size, size, "The capture must use the complete window content bounds")
            try validate?(hosting)
            let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            let center = bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)
            XCTAssertEqual(center?.alphaComponent ?? 0, 1, accuracy: 0.01, "Snapshots must have an opaque background")
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            XCTAssertGreaterThan(png.count, 1000, "The snapshot must contain a rendered view")
            try png.write(to: output.appendingPathComponent("\(name)-\(appearance.rawValue).png"))
            if name == "waiting" {
                try writeSidebarDiagnostics(hosting, output: output, appearance: appearance)
                // Compare native layer compositing with cacheDisplay before changing the product layout.
                hosting.wantsLayer = true
                try await Task.sleep(for: .milliseconds(150))
                hosting.layoutSubtreeIfNeeded()
                let layered = try XCTUnwrap(NSBitmapImageRep(
                    bitmapDataPlanes: nil,
                    pixelsWide: Int(size.width),
                    pixelsHigh: Int(size.height),
                    bitsPerSample: 8,
                    samplesPerPixel: 4,
                    hasAlpha: true,
                    isPlanar: false,
                    colorSpaceName: .deviceRGB,
                    bytesPerRow: 0,
                    bitsPerPixel: 0
                ))
                let context = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: layered))
                try XCTUnwrap(hosting.layer).render(in: context.cgContext)
                let data = try XCTUnwrap(layered.representation(using: .png, properties: [:]))
                try data.write(to: output.appendingPathComponent("waiting-layers-\(appearance.rawValue).png"))
            }
        }
    }

    private static func writeSidebarDiagnostics(_ root: NSView, output: URL, appearance: NSAppearance.Name) throws {
        func descendants(_ view: NSView) -> [NSView] {
            [view] + view.subviews.flatMap(descendants)
        }
        let lines = descendants(root).compactMap { view -> String? in
            if let table = view as? NSTableView {
                let visible = table.rows(in: table.visibleRect)
                let row = table.numberOfRows > 0 ? table.rowView(atRow: 0, makeIfNecessary: false) : nil
                return "table bounds=\(table.bounds) visible=\(table.visibleRect) rows=\(table.numberOfRows) visibleRows=\(visible) firstRow=\(String(describing: row?.frame)) hidden=\(table.isHiddenOrHasHiddenAncestor)"
            }
            if view is NSVisualEffectView || view is NSClipView {
                return "\(String(describing: type(of: view))) frame=\(view.frame) bounds=\(view.bounds) hidden=\(view.isHiddenOrHasHiddenAncestor)"
            }
            return nil
        }
        try Data(lines.joined(separator: "\n").utf8).write(to: output.appendingPathComponent("waiting-native-\(appearance.rawValue).txt"))
    }
}
