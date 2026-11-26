// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
@testable import OmnesisDesktop
import ScreenCaptureKit
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
            let content = view.frame(width: size.width, height: size.height)
                .omnesisTheme().environment(\.colorScheme, scheme)
                .background(DesktopTheme.canvas)
            let hosting = NSHostingView(rootView: content)
            hosting.sizingOptions = []
            hosting.autoresizingMask = [.width, .height]
            hosting.frame = NSRect(origin: .zero, size: size)
            let window = NSWindow(
                contentRect: hosting.frame,
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            window.title = "Omnesis"
            window.appearance = NSAppearance(named: appearance)
            window.contentView = hosting
            window.setContentSize(size)
            windows.append(window)
            NSApp.activate()
            window.makeKeyAndOrderFront(nil)
            // Yield the main actor so SwiftUI can resolve appearance and commit its first display.
            try await Task.sleep(for: .milliseconds(150))
            hosting.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            try await Task.sleep(for: .milliseconds(150))
            hosting.layoutSubtreeIfNeeded()
            hosting.displayIfNeeded()
            XCTAssertEqual(hosting.bounds.size, size, "The capture must use the complete window content bounds")
            let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            let center = bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)
            XCTAssertEqual(center?.alphaComponent ?? 0, 1, accuracy: 0.01, "Snapshots must have an opaque background")
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            XCTAssertGreaterThan(png.count, 1000, "The snapshot must contain a rendered view")
            try png.write(to: output.appendingPathComponent("\(name)-\(appearance.rawValue).png"))
            // Retain the actual render even when a semantic/layout assertion fails.
            if validate != nil { try await DesktopAccessibilityDriver.materializeOwnedApplication() }
            try validate?(hosting)
            if name == "settings-branded" || name == "settings-all-required-ready" || name == "settings-storage-required-first" || name ==
                "welcome" || name == "sources-library" ||
                name == "ask-increased-contrast" {
                try await captureOwnedWindow(window, output: output, name: name, appearance: appearance)
            }
            if name == "ready-sidebar" {
                try await captureOwnedWindow(window, output: output, name: name, appearance: appearance)
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
                context.cgContext.translateBy(x: 0, y: size.height)
                context.cgContext.scaleBy(x: 1, y: -1)
                try XCTUnwrap(hosting.layer).render(in: context.cgContext)
                let data = try XCTUnwrap(layered.representation(using: .png, properties: [:]))
                try data.write(to: output.appendingPathComponent("ready-sidebar-layers-\(appearance.rawValue).png"))
            }
        }
    }

    static func captureOwnedWindow(_ window: NSWindow, output: URL, name: String, appearance: NSAppearance.Name) async throws {
        guard #available(macOS 14.4, *) else {
            throw NSError(
                domain: "DesktopSnapshot",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Own-window capture requires macOS 14.4 or later"]
            )
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        let activationRequested = NSRunningApplication.current.activate(options: [.activateAllWindows])
        let deadline = ContinuousClock.now + .seconds(2)
        while !NSApp.isActive || !window.isKeyWindow, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(25))
        }
        window.displayIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        let frontmostIsOwnProcess = NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier
        let active = NSApp.isActive && window.isKeyWindow && frontmostIsOwnProcess
        let policy = switch NSApp.activationPolicy() {
        case .regular: "regular"
        case .accessory: "accessory"
        case .prohibited: "prohibited"
        @unknown default: "unknown"
        }
        var state: [String: Any] = [
            "applicationActive": NSApp.isActive, "windowKey": window.isKeyWindow, "windowMain": window.isMainWindow,
            "frontmostIsOwnProcess": frontmostIsOwnProcess, "activationRequested": activationRequested,
            "activationPolicy": policy, "canBecomeKey": window.canBecomeKey, "canBecomeMain": window.canBecomeMain,
            "firstResponderIsTextInput": window.firstResponder is NSTextView,
            "contentWidth": window.contentView?.bounds.width ?? 0, "contentHeight": window.contentView?.bounds.height ?? 0,
            "outerWidth": window.frame.width, "outerHeight": window.frame.height,
            "fullSizeContentView": window.styleMask.contains(.fullSizeContentView),
            "titlebarAppearsTransparent": window.titlebarAppearsTransparent,
            "backgroundMatchesCanvas": backgroundMatchesCanvas(window),
            "contentLayoutX": window.contentLayoutRect.minX, "contentLayoutY": window.contentLayoutRect.minY,
            "contentLayoutWidth": window.contentLayoutRect.width, "contentLayoutHeight": window.contentLayoutRect.height,
            "safeAreaTop": window.contentView?.safeAreaInsets.top ?? 0,
        ]
        state.merge(ownedLayoutFacts(window)) { _, observation in observation }
        try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
            .write(to: output.appendingPathComponent("\(name)-state-\(appearance.rawValue).txt"))
        // This API exposes current-process content without requesting Screen Recording permission.
        // Never replace it with general window enumeration or a permission request.
        let identifier = try XCTUnwrap(CGWindowID(exactly: window.windowNumber), "The test window needs a valid WindowServer identity")
        let content = try await SCShareableContent.currentProcess
        let owned = try XCTUnwrap(content.windows.first {
            $0.windowID == identifier && $0.owningApplication?.processID == ProcessInfo.processInfo.processIdentifier
        }, "Only the exact test-owned window may be captured")
        let filter = SCContentFilter(desktopIndependentWindow: owned)
        let configuration = SCStreamConfiguration()
        configuration.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale))
        configuration.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
        configuration.colorSpaceName = CGColorSpace.sRGB
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.includeChildWindows = false
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
        let bitmap = NSBitmapImageRep(cgImage: image)
        let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try data.write(to: output.appendingPathComponent("\(name)-window-\(appearance.rawValue).png"))
        if name == "hosted-chat-ready-to-send" {
            XCTAssertTrue(
                active,
                "Primary-control qualification requires this exact app and window to be active; see the owned state artifact"
            )
        }
    }

    private static func rectangle(_ rect: NSRect) -> [String: CGFloat] {
        ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
    }

    static func ownedLayoutFacts(_ window: NSWindow) -> [String: Any] {
        guard let content = window.contentView else { return ["contentPresent": false] }
        var pending = [content], probes: [DesktopOwnedWindowChrome.View] = []
        var visited = 0
        while visited < 4096, let view = pending.popLast() {
            visited += 1
            if let probe = view as? DesktopOwnedWindowChrome.View, probe.window === window { probes.append(probe) }
            pending.append(contentsOf: view.subviews)
        }
        let contentFrame = content.convert(content.bounds, to: nil)
        let layout = window.contentLayoutRect
        let overlap = max(0, contentFrame.maxY - layout.maxY)
        var facts: [String: Any] = [
            "contentPresent": true, "fullHostingBounds": rectangle(content.bounds),
            "hostingFrameInWindow": rectangle(contentFrame), "usableLayoutInWindow": rectangle(layout),
            "usableLayoutInScreen": rectangle(window.convertToScreen(layout)),
            "actualTopOverlap": overlap, "chromeProbeCount": probes.count,
            "hostingReportedSafeAreaTop": content.safeAreaInsets.top,
            "viewTraversalBoundReached": !pending.isEmpty,
            "toolbarPresent": window.toolbar != nil, "toolbarVisible": window.toolbar?.isVisible ?? false,
            "toolbarItemCount": window.toolbar?.items.count ?? 0,
        ]
        if probes.count == 1, let probe = probes.first, probe.hasSwiftUIMeasurement {
            facts["owningProbeBounds"] = rectangle(probe.bounds)
            facts["owningProbeFrameInWindow"] = rectangle(probe.convert(probe.bounds, to: nil))
            facts["swiftUIReportedSafeAreaTop"] = probe.swiftUIReportedTop
            facts["missingTopObservationOnly"] = max(0, overlap - probe.swiftUIReportedTop)
        } else { facts["swiftUIReportedSafeAreaTop"] = NSNull()
            facts["missingTopObservationOnly"] = NSNull()
        }
        facts["nativeControls"] = [
            ("close", NSWindow.ButtonType.closeButton), ("minimize", .miniaturizeButton), ("zoom", .zoomButton),
        ].map { name, type -> [String: Any] in
            guard let button = window.standardWindowButton(type) else { return ["kind": name, "present": false] }
            let ownWindow = button.window === window
            let localFrame = button.convert(button.bounds, to: nil)
            var result: [String: Any] = [
                "kind": name, "present": true, "windowMatchesParent": ownWindow,
                "windowIsChildOfParent": button.window?.parent === window,
                "frameInButtonWindow": rectangle(localFrame), "visibleRect": rectangle(button.visibleRect),
                "hidden": button.isHiddenOrHasHiddenAncestor, "enabled": button.isEnabled, "alpha": button.alphaValue,
                "hitTestPerformed": false,
            ]
            if let buttonWindow = button.window { result["frameInScreen"] = rectangle(buttonWindow.convertToScreen(localFrame)) }
            if ownWindow, let frameView = content.superview {
                let point = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: frameView.superview)
                let hit = frameView.hitTest(point)
                result["hitTestPerformed"] = true
                result["hitTargetIsButton"] = hit === button || hit?.isDescendant(of: button) == true
                result["hitTargetInContent"] = hit === content || hit?.isDescendant(of: content) == true
            }
            return result
        }
        var banner: [String: Any] = [:]
        let observedElements = try? DesktopAccessibilityDriver.elements(in: content)
        facts["accessibilityEnumerationSucceeded"] = observedElements != nil
        let elements = observedElements ?? []
        for identifier in [
            "required-setup-banner",
            "required-setup-label",
            "required-setup-review",
            "library-brand-title",
            "chat-history-refresh",
        ] {
            if let element = elements.first(where: { $0.accessibilityIdentifier() == identifier }) {
                banner[identifier] = ["present": true, "frameInScreen": rectangle(element.accessibilityFrame())]
            } else { banner[identifier] = ["present": false] }
        }
        facts["bannerAndHeaderAX"] = banner
        return facts
    }

    static func writeOwnedLayoutFacts(_ window: NSWindow, name: String) throws {
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ownedLayoutFacts(window), options: [.sortedKeys])
            .write(to: output.appendingPathComponent(name + "-layout-facts.json"))
    }

    static func backgroundMatchesCanvas(_ window: NSWindow) -> Bool {
        guard let actual = window.backgroundColor.usingColorSpace(.sRGB),
              let expected = NSColor(DesktopTheme.canvas).usingColorSpace(.sRGB) else { return false }
        return abs(actual.redComponent - expected.redComponent) < 0.001
            && abs(actual.greenComponent - expected.greenComponent) < 0.001
            && abs(actual.blueComponent - expected.blueComponent) < 0.001
            && abs(actual.alphaComponent - expected.alphaComponent) < 0.001
    }

    static func assertOwnedWindowChrome(_ window: NSWindow, file: StaticString = #filePath, line: UInt = #line) {
        // Full-size/transparent titlebars were prototype mechanisms, not user requirements.
        // Require native controls to remain visible and actually hit-testable instead.
        XCTAssertTrue(window.styleMask.contains(.titled), file: file, line: line)
        XCTAssertTrue(backgroundMatchesCanvas(window), file: file, line: line)
        for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            guard let button = window.standardWindowButton(type), let content = window.contentView,
                  let frameView = content.superview else { XCTFail("The native window control must exist", file: file, line: line)
                continue
            }
            XCTAssertTrue(button.window === window, file: file, line: line)
            XCTAssertFalse(button.isHiddenOrHasHiddenAncestor, file: file, line: line)
            XCTAssertTrue(button.isEnabled, file: file, line: line)
            XCTAssertGreaterThan(button.alphaValue, 0, file: file, line: line)
            XCTAssertGreaterThan(button.bounds.width, 0, file: file, line: line)
            XCTAssertGreaterThan(button.bounds.height, 0, file: file, line: line)
            XCTAssertTrue(button.visibleRect.intersects(button.bounds), file: file, line: line)
            let screenFrame = window.convertToScreen(button.convert(button.bounds, to: nil))
            XCTAssertTrue(
                window.frame.insetBy(dx: -1, dy: -1).contains(screenFrame),
                "The native control must be inside its own window",
                file: file,
                line: line
            )
            let point = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: frameView.superview)
            let hit = frameView.hitTest(point)
            XCTAssertTrue(
                hit === button || hit?.isDescendant(of: button) == true,
                "The native control must receive its center hit",
                file: file,
                line: line
            )
            XCTAssertFalse(
                hit === content || hit?.isDescendant(of: content) == true,
                "Library content must not intercept native window controls",
                file: file,
                line: line
            )
        }
        XCTAssertGreaterThan(window.contentLayoutRect.width, 0, file: file, line: line)
        XCTAssertGreaterThan(window.contentLayoutRect.height, 0, file: file, line: line)
    }

    static func assertRequiredBannerLayout(
        _ hosting: NSView,
        below identifiers: [String],
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let window = try XCTUnwrap(hosting.window, file: file, line: line)
        let usable = window.convertToScreen(window.contentLayoutRect).insetBy(dx: -1, dy: -1)
        let group = try DesktopAccessibilityDriver.element("required-setup-banner", in: hosting).accessibilityFrame()
        let label = try DesktopAccessibilityDriver.element("required-setup-label", in: hosting).accessibilityFrame()
        let review = try DesktopAccessibilityDriver.element("required-setup-review", in: hosting).accessibilityFrame()
        // A Group's backdrop can extend into the safe area. Its actual label/action must not.
        XCTAssertGreaterThan(group.height, 30, file: file, line: line)
        for frame in [label, review] {
            XCTAssertGreaterThan(frame.width, 0, file: file, line: line)
            XCTAssertGreaterThan(frame.height, 0, file: file, line: line)
            XCTAssertTrue(usable.contains(frame), "The banner label and action must remain inside usable content", file: file, line: line)
            XCTAssertTrue(group.insetBy(dx: -1, dy: -1).contains(frame), "The banner must contain its label/action", file: file, line: line)
        }
        for identifier in identifiers {
            let frame = try DesktopAccessibilityDriver.element(identifier, in: hosting).accessibilityFrame()
            XCTAssertGreaterThan(frame.height, 10, file: file, line: line)
            XCTAssertTrue(usable.contains(frame), "The toolbar must not cover \(identifier)", file: file, line: line)
            XCTAssertLessThanOrEqual(
                frame.maxY,
                min(label.minY, review.minY) + 1,
                "The banner content must remain above \(identifier)",
                file: file,
                line: line
            )
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
        try Data(lines.joined(separator: "\n").utf8)
            .write(to: output.appendingPathComponent("ready-sidebar-native-\(appearance.rawValue).txt"))
    }
}
