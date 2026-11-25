// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import SwiftUI
import XCTest

@MainActor
enum DesktopSnapshotRenderer {
    static func render(_ view: some View, name: String, size: CGSize) async throws {
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
            hosting.frame = NSRect(origin: .zero, size: size)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: appearance)
            window.contentView = hosting
            windows.append(window)
            window.orderFront(nil)
            // Yield the main actor so SwiftUI can resolve appearance and commit its first display.
            try await Task.sleep(for: .milliseconds(150))
            hosting.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            let center = bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)
            XCTAssertEqual(center?.alphaComponent ?? 0, 1, accuracy: 0.01, "Snapshots must have an opaque background")
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            XCTAssertGreaterThan(png.count, 1000, "The snapshot must contain a rendered view")
            try png.write(to: output.appendingPathComponent("\(name)-\(appearance.rawValue).png"))
        }
    }
}
