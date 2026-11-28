// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopDesignSystemTests: XCTestCase {
    func testIndependentAppearancePaletteRejectsTheOtherAppearanceAndWrongCanvas() throws {
        let light = try XCTUnwrap(NSAppearance(named: .aqua))
        let dark = try XCTUnwrap(NSAppearance(named: .darkAqua))
        for appearance in [light, dark] {
            try DesktopNativeColorReference.validateLogicalCanvas(NSColor(DesktopTheme.canvas), appearance: appearance)
            XCTAssertThrowsError(try DesktopNativeColorReference.validateLogicalCanvas(.red, appearance: appearance))
        }
        XCTAssertThrowsError(try DesktopNativeColorReference.validateLogicalCanvas(
            DesktopNativeColorReference.expectedCanvas(dark), appearance: light
        ))
        XCTAssertThrowsError(try DesktopNativeColorReference.validateLogicalCanvas(
            DesktopNativeColorReference.expectedCanvas(light), appearance: dark
        ))
        try assertColor(DesktopTheme.ink, equals: [32, 36, 43], appearance: light)
        try assertColor(DesktopTheme.ink, equals: [240, 242, 245], appearance: dark)
    }

    func testWindowCanvasValidationRejectsOppositeStaticBackgroundDespiteAmbientAppearance() throws {
        let light = try XCTUnwrap(NSAppearance(named: .aqua))
        let dark = try XCTUnwrap(NSAppearance(named: .darkAqua))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 120, height: 80),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        defer { window.close() }
        for (target, ambient) in [(light, dark), (dark, light)] {
            window.appearance = target
            window.backgroundColor = DesktopNativeColorReference.expectedCanvas(ambient)
            ambient.performAsCurrentDrawingAppearance {
                XCTAssertFalse(
                    DesktopSnapshotRenderer.backgroundMatchesCanvas(window),
                    "The other appearance's static background must not pass because it matches ambient drawing"
                )
            }
            window.backgroundColor = DesktopNativeColorReference.expectedCanvas(target)
            ambient.performAsCurrentDrawingAppearance {
                XCTAssertTrue(DesktopSnapshotRenderer.backgroundMatchesCanvas(window))
            }
            window.backgroundColor = DesktopTheme.nativeCanvas
            ambient.performAsCurrentDrawingAppearance {
                XCTAssertTrue(
                    DesktopSnapshotRenderer.backgroundMatchesCanvas(window),
                    "Both dynamic colors must resolve under the target window, not ambient drawing"
                )
            }
        }
    }

    /// Contrast contracts use actual resolved sRGB tokens, not a duplicate style implementation.
    func testTextStatusAndActionRolesRemainReadableAcrossTheirActualSurfaces() throws {
        for name in [NSAppearance.Name.aqua, .darkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua] {
            let appearance = try XCTUnwrap(NSAppearance(named: name))
            let surfaces = [
                DesktopTheme.canvas,
                DesktopTheme.sidebar,
                DesktopTheme.surface,
                DesktopTheme.elevated,
                DesktopTheme.hover,
                DesktopTheme.selected,
                DesktopTheme.pressed,
            ]
            for surface in surfaces {
                for text in [DesktopTheme.ink, DesktopTheme.secondary, DesktopTheme.tertiary] {
                    XCTAssertGreaterThanOrEqual(try contrast(text, surface, appearance: appearance), 4.5, name.rawValue)
                }
            }
            for surface in [DesktopTheme.canvas, DesktopTheme.surface, DesktopTheme.elevated] {
                for status in [DesktopTheme.success, DesktopTheme.warning, DesktopTheme.danger] {
                    XCTAssertGreaterThanOrEqual(try contrast(status, surface, appearance: appearance), 4.5, name.rawValue)
                }
            }
            for fill in [DesktopTheme.primary, DesktopTheme.primaryHover, DesktopTheme.primaryPressed] {
                XCTAssertGreaterThanOrEqual(try contrast(DesktopTheme.primaryInk, fill, appearance: appearance), 4.5)
            }
            for fill in [DesktopTheme.danger, DesktopTheme.dangerHover, DesktopTheme.dangerPressed] {
                XCTAssertGreaterThanOrEqual(try contrast(DesktopTheme.dangerInk, fill, appearance: appearance), 4.5)
            }
            XCTAssertGreaterThanOrEqual(try contrast(DesktopTheme.muted, DesktopTheme.disabled, appearance: appearance), 4.5)
            XCTAssertGreaterThanOrEqual(try contrast(DesktopTheme.strongBorder, DesktopTheme.surface, appearance: appearance), 3)
            for surface in [DesktopTheme.canvas, DesktopTheme.surface] {
                XCTAssertGreaterThanOrEqual(
                    try contrast(DesktopTheme.focusRing, surface, appearance: appearance),
                    3,
                    "A custom-drawn focus stroke must contrast after alpha compositing"
                )
            }
            let hovered = try rgba(DesktopTheme.hover, appearance: appearance)
            let selected = try rgba(DesktopTheme.selected, appearance: appearance)
            let pressed = try rgba(DesktopTheme.pressed, appearance: appearance)
            XCTAssertNotEqual(hovered, selected, "Pointer hover must not masquerade as persistent selection")
            XCTAssertNotEqual(pressed, selected)
        }
    }

    func testPrivateStoredPreferenceUpdatesTheSameMountedWindowWithoutRestart() async throws {
        try await withMountedProbe(.storedPreference) { mounted in
            XCTAssertNil(mounted.defaults.object(forKey: DesktopAppearance.storageKey), "A fresh private store follows System")
            for mode in [DesktopAppearance.light, .dark, .light] {
                mounted.defaults.set(mode.rawValue, forKey: DesktopAppearance.storageKey)
                let expected: NSAppearance.Name = mode == .dark ? .darkAqua : .aqua
                try await wait(mounted, phase: .storedPreference, mode: mode) {
                    mounted.window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == expected &&
                        mounted.observation.scheme == mode.colorScheme
                }
                try DesktopNativeColorReference.validateLogicalCanvas(
                    NSColor(DesktopTheme.canvas),
                    appearance: mounted.window.effectiveAppearance
                )
                XCTAssertTrue(mounted.host.window === mounted.window)
            }
            mounted.defaults.set("unrecognized-fixture-appearance", forKey: DesktopAppearance.storageKey)
            try await wait(mounted, phase: .invalidPreference, mode: .system) {
                mounted.window.appearance == nil && mounted.observation.scheme ==
                    (mounted.window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? .dark : .light)
            }
        }
    }

    func testSystemInheritsLiveApplicationAppearanceWhileExplicitPreferenceStaysFixed() async throws {
        // Only this serial hosted test app changes; no macOS preference is written.
        let previous = NSApp.appearance
        defer { NSApp.appearance = previous }
        try await withMountedProbe(.systemInheritance) { mounted in
            for name in [NSAppearance.Name.aqua, .darkAqua, .aqua] {
                NSApp.appearance = try XCTUnwrap(NSAppearance(named: name))
                try await wait(mounted, phase: .systemInheritance, mode: .system) {
                    mounted.window.appearance == nil && mounted.window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == name &&
                        mounted.observation.scheme == (name == .aqua ? .light : .dark)
                }
            }
            mounted.defaults.set(DesktopAppearance.dark.rawValue, forKey: DesktopAppearance.storageKey)
            try await wait(mounted, phase: .explicitPreference, mode: .dark) {
                mounted.observation.scheme == .dark && mounted.window.appearance != nil
            }
            NSApp.appearance = try XCTUnwrap(NSAppearance(named: .aqua))
            try await wait(mounted, phase: .explicitHeldAcrossAmbientChange, mode: .dark) {
                mounted.window.effectiveAppearance.bestMatch(from: [
                    .aqua,
                    .darkAqua,
                ]) == .darkAqua
            }
            XCTAssertEqual(mounted.observation.scheme, .dark)
            mounted.defaults.set(DesktopAppearance.system.rawValue, forKey: DesktopAppearance.storageKey)
            try await wait(mounted, phase: .returnToSystem, mode: .system) {
                mounted.window.appearance == nil && mounted.observation.scheme == .light
            }
        }
    }

    func testRenderedControlRolesKeepDisabledActionsUnavailableAndOwnTextFocus() async throws {
        let actions = ControlActions()
        var expectedPresses = 0
        try await DesktopSnapshotRenderer.renderVisibleWindow(
            ControlProbe(actions: actions).frame(minWidth: 600, minHeight: 360), name: "design-controls", size: CGSize(
                width: 600,
                height: 360
            )
        ) { hosting in
            XCTAssertEqual(actions.presses, expectedPresses, "Mounting another appearance must not activate a control")
            let enabled = try DesktopAccessibilityDriver.element("design-primary", in: hosting)
            let disabled = try DesktopAccessibilityDriver.element("design-disabled", in: hosting)
            XCTAssertEqual(enabled.accessibilityRole(), .button)
            XCTAssertEqual(disabled.accessibilityRole(), .button)
            XCTAssertTrue(enabled.isAccessibilityEnabled())
            XCTAssertFalse(disabled.isAccessibilityEnabled())
            let window = try XCTUnwrap(hosting.window)
            for element in [enabled, disabled] {
                let frame = element.accessibilityFrame()
                XCTAssertGreaterThan(frame.width, 0)
                XCTAssertGreaterThan(frame.height, 0)
                XCTAssertTrue(window.frame.contains(frame))
            }
            try DesktopAccessibilityDriver.press("design-primary", in: hosting)
            expectedPresses += 1
            XCTAssertEqual(actions.presses, expectedPresses)
            try DesktopAccessibilityDriver.type("An invented focused draft", into: "design-input", in: hosting)
            try await wait {
                let value = try? DesktopAccessibilityDriver.element("design-input", in: hosting).accessibilityTextValue()
                return (window.firstResponder as? NSTextView)?.window === window && value == "An invented focused draft"
            }
            XCTAssertEqual(actions.presses, expectedPresses, "Focusing an input must not submit its contents")
        }
        XCTAssertEqual(expectedPresses, 2)
        XCTAssertEqual(actions.presses, 2)
    }

    func testWrappedRowLabelExpandsInsideItsRealButtonAndKeepsAdjacentActionsSeparate() async throws {
        let layout = MultilineButtonLayout()
        var seenRenders = Set<UUID>()
        var expectedPresses = 0
        try await DesktopSnapshotRenderer.renderVisibleWindow(
            MultilineButtonProbe(layout: layout).frame(minWidth: 520, minHeight: 400), name: "design-multiline-controls", size: CGSize(
                width: 520,
                height: 400
            )
        ) { hosting in
            try await wait {
                guard let snapshot = layout.snapshot, !seenRenders.contains(snapshot.id) else { return false }
                return MultilineButtonLayout.Part.allCases.allSatisfy { snapshot.frames[$0] != nil }
            }
            let snapshot = try XCTUnwrap(layout.snapshot)
            XCTAssertTrue(seenRenders.insert(snapshot.id).inserted, "Each appearance must measure its own mounted layout")
            let row = try XCTUnwrap(snapshot.frames[.row])
            let title = try XCTUnwrap(snapshot.frames[.title])
            let scope = try XCTUnwrap(snapshot.frames[.scope])
            let next = try XCTUnwrap(snapshot.frames[.next])
            let icon = try XCTUnwrap(snapshot.frames[.icon])
            let window = try XCTUnwrap(hosting.window)
            let scale = window.backingScaleFactor
            XCTAssertGreaterThan(scale, 0)
            let pixel = 1 / scale
            for frame in [row, title, scope, next, icon] {
                XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
                XCTAssertGreaterThan(frame.width, 0)
                XCTAssertGreaterThan(frame.height, 0)
            }
            XCTAssertGreaterThan(scope.height, title.height, "The actual narrow description must wrap naturally")
            XCTAssertTrue(row.insetBy(dx: -pixel, dy: -pixel).contains(title), "The button must contain its title")
            XCTAssertTrue(row.insetBy(dx: -pixel, dy: -pixel).contains(scope), "The button must contain every description line")
            XCTAssertGreaterThan(row.height, next.height, "A wrapped row must expand beyond an ordinary one-line control")
            XCTAssertGreaterThanOrEqual(next.minY + pixel, row.maxY)
            XCTAssertGreaterThanOrEqual(
                next.minY + pixel,
                title.union(scope).maxY,
                "Adjacent actions cannot overlap overflowing label text"
            )
            XCTAssertEqual(next.height, 30, accuracy: pixel, "Ordinary controls remain compact")
            XCTAssertEqual(icon.width, 32, accuracy: pixel)
            XCTAssertEqual(icon.height, 32, accuracy: pixel)
            let action = try DesktopAccessibilityDriver.element("design-multiline-row", in: hosting)
            XCTAssertEqual(action.accessibilityRole(), .button)
            XCTAssertTrue(action.isAccessibilityEnabled())
            XCTAssertTrue(window.frame.insetBy(dx: -pixel, dy: -pixel).contains(action.accessibilityFrame()))
            XCTAssertEqual(layout.presses, expectedPresses, "Mounting the next appearance cannot activate the row")
            try DesktopAccessibilityDriver.press("design-multiline-row", in: hosting)
            expectedPresses += 1
            XCTAssertEqual(layout.presses, expectedPresses)
        }
        XCTAssertEqual(seenRenders.count, 2)
        XCTAssertEqual(expectedPresses, 2)
        XCTAssertEqual(layout.presses, 2)
    }

    @MainActor
    private final class MultilineButtonLayout {
        enum Part: CaseIterable, Hashable { case row, title, scope, next, icon }
        struct Snapshot {
            let id: UUID
            let frames: [Part: CGRect]
        }

        private var active: UUID?
        private var frames: [UUID: [Part: CGRect]] = [:]
        var presses = 0
        var snapshot: Snapshot? {
            guard let active else { return nil }
            return Snapshot(id: active, frames: frames[active] ?? [:])
        }

        func begin(_ id: UUID) {
            active = id
        }

        func record(_ part: Part, frame: CGRect, id: UUID) {
            guard frames[id] != nil || frames.count < 2 else { return }
            frames[id, default: [:]][part] = frame
        }
    }

    @MainActor
    private final class MultilineRenderIdentity: ObservableObject {
        let id = UUID()
    }

    @MainActor
    private struct MultilineButtonProbe: View {
        let layout: MultilineButtonLayout
        @StateObject private var render = MultilineRenderIdentity()
        private let coordinateSpace = "design-multiline-layout"

        var body: some View {
            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.regular) {
                Button { layout.presses += 1 } label: {
                    VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.xSmall) {
                        Text("Example notebook").font(DesktopDesignTokens.Typography.secondary.weight(.medium))
                            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(coordinateSpace)) } action: {
                                layout.record(.title, frame: $0, id: render.id)
                            }
                        Text(
                            "Read the selected project folder and the nested notes this source collects. Your original files remain where they are."
                        )
                        .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(coordinateSpace)) } action: {
                            layout.record(.scope, frame: $0, id: render.id)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(DesktopButtonStyle()).frame(width: 240)
                    .accessibilityIdentifier("design-multiline-row").accessibilityLabel("Choose Example notebook")
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(coordinateSpace)) } action: {
                        layout.record(.row, frame: $0, id: render.id)
                    }
                Button("Continue") {}.buttonStyle(DesktopButtonStyle())
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(coordinateSpace)) } action: {
                        layout.record(.next, frame: $0, id: render.id)
                    }
                Button("Refresh", systemImage: "arrow.clockwise") {}.labelStyle(.iconOnly)
                    .buttonStyle(DesktopButtonStyle(iconOnly: true)).help("Refresh").accessibilityLabel("Refresh")
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(coordinateSpace)) } action: {
                        layout.record(.icon, frame: $0, id: render.id)
                    }
            }.coordinateSpace(name: coordinateSpace).padding(24).onAppear { layout.begin(render.id) }
        }
    }

    private final class ControlActions { var presses = 0 }

    private struct ControlProbe: View {
        let actions: ControlActions
        @State private var text = ""
        var body: some View {
            VStack(alignment: .leading, spacing: 16) {
                TextField("Draft", text: $text).textFieldStyle(.roundedBorder).accessibilityIdentifier("design-input")
                Button("Continue") { actions.presses += 1 }.buttonStyle(DesktopButtonStyle(primary: true))
                    .accessibilityIdentifier("design-primary")
                Button("Unavailable") { actions.presses += 100 }.buttonStyle(DesktopButtonStyle(primary: true))
                    .disabled(true).accessibilityIdentifier("design-disabled")
            }.padding(24)
        }
    }

    private enum ProbeCase: String { case storedPreference, systemInheritance }

    private enum ProbePhase: String {
        case mounted, storedPreference, invalidPreference, systemInheritance
        case explicitPreference, explicitHeldAcrossAmbientChange, returnToSystem
    }

    private final class Observation {
        var scheme: ColorScheme?
        var phase = ProbePhase.mounted
        var requested = DesktopAppearance.system
    }

    private struct Probe: View {
        let observation: Observation
        @Environment(\.colorScheme) private var scheme
        var body: some View {
            Text("Appearance observation").padding(24)
                .onAppear { observation.scheme = scheme }
                .onChange(of: scheme) { observation.scheme = scheme }
        }
    }

    private struct Mounted {
        let selected: ProbeCase
        let window: NSWindow
        let host: NSView
        let defaults: UserDefaults
        let observation: Observation
    }

    private func withMountedProbe(_ selected: ProbeCase, _ operation: @MainActor (Mounted) async throws -> Void) async throws {
        let suite = "dev.omnesis.appearance-tests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let observation = Observation()
        let host = NSHostingView(rootView: Probe(observation: observation)
            .frame(minWidth: 520, minHeight: 240).omnesisTheme().defaultAppStorage(defaults))
        host.sizingOptions = []
        host.autoresizingMask = [.width, .height]
        host.frame = NSRect(x: 0, y: 0, width: 520, height: 240)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer {
            window.contentView = nil
            window.close()
            defaults.removePersistentDomain(forName: suite)
        }
        window.makeKeyAndOrderFront(nil)
        window.setContentSize(NSSize(width: 520, height: 240))
        host.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        let mounted = Mounted(selected: selected, window: window, host: host, defaults: defaults, observation: observation)
        do {
            try await wait(mounted, phase: .mounted, mode: .system) { observation.scheme != nil }
            try await operation(mounted)
        } catch {
            recordProbeFailure(mounted, error: error)
            throw error
        }
    }

    private func wait(
        _ mounted: Mounted, phase: ProbePhase, mode: DesktopAppearance,
        _ predicate: () throws -> Bool
    ) async throws {
        mounted.observation.phase = phase
        mounted.observation.requested = mode
        try await wait(predicate)
    }

    private func recordProbeFailure(_ mounted: Mounted, error: Error) {
        struct Facts: Encodable {
            let testCase: String
            let phase: String
            let requested: String
            let applicationAppearance: String
            let windowAppearance: String
            let effectiveAppearance: String
            let scheme: String
            let persistedPreference: String
            let appHidden: Bool
            let appActive: Bool
            let finishedLaunching: Bool
            let windowVisible: Bool
            let windowOnActiveSpace: Bool
            let hostAttached: Bool
            let windowFrame: [Double?]
            let hostFrame: [Double?]
            let hostBounds: [Double?]
            let failure: String
        }
        func appearance(_ value: NSAppearance?) -> String {
            guard let value else { return "inherited" }
            switch value.bestMatch(from: [.aqua, .darkAqua]) {
            case .aqua: return "light"
            case .darkAqua: return "dark"
            default: return "unknown"
            }
        }
        func frame(_ value: NSRect) -> [Double?] {
            [value.minX, value.minY, value.width, value.height].map { $0.isFinite ? Double($0) : nil }
        }
        let stored = mounted.defaults.object(forKey: DesktopAppearance.storageKey)
        let preference: String = if stored == nil { "absent" }
        else if let raw = stored as? String, let value = DesktopAppearance(rawValue: raw) { value.rawValue }
        else { "unrecognized" }
        let failure = (error as? URLError)?.code == .timedOut ? "deadline" : error is CancellationError ? "cancelled" : "other"
        let facts = Facts(
            testCase: mounted.selected.rawValue,
            phase: mounted.observation.phase.rawValue,
            requested: mounted.observation.requested.rawValue,
            applicationAppearance: appearance(NSApp.appearance),
            windowAppearance: appearance(mounted.window.appearance),
            effectiveAppearance: appearance(mounted.window.effectiveAppearance),
            scheme: mounted.observation.scheme.map { $0 == .dark ? "dark" : "light" } ?? "unobserved",
            persistedPreference: preference,
            appHidden: NSApp.isHidden, appActive: NSRunningApplication.current.isActive,
            finishedLaunching: NSRunningApplication.current.isFinishedLaunching,
            windowVisible: mounted.window.isVisible, windowOnActiveSpace: mounted.window.isOnActiveSpace,
            hostAttached: mounted.host.window === mounted.window,
            windowFrame: frame(mounted.window.frame), hostFrame: frame(mounted.host.frame), hostBounds: frame(mounted.host.bounds),
            failure: failure
        )
        guard let data = try? JSONEncoder().encode(facts), data.count <= 4096 else { return }
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            let name = "design-appearance-" + mounted.selected.rawValue + "-" + mounted.observation.phase.rawValue + "-failure.txt"
            try data.write(to: output.appendingPathComponent(name), options: .atomic)
        } catch { /* Diagnostic publication cannot replace the original failure. */ }
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "appearance-probe-failure-facts"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func wait(_ predicate: () throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            let ready = try predicate()
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            if ready { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw URLError(.timedOut)
    }

    private func rgba(_ color: Color, appearance: NSAppearance) throws -> [Double] {
        var resolved: NSColor?
        appearance.performAsCurrentDrawingAppearance { resolved = NSColor(color).usingColorSpace(.sRGB) }
        let native = try XCTUnwrap(resolved)
        return [Double(native.redComponent), Double(native.greenComponent), Double(native.blueComponent), Double(native.alphaComponent)]
    }

    private func assertColor(_ color: Color, equals expected: [Double], appearance: NSAppearance) throws {
        let actual = try rgba(color, appearance: appearance)
        for index in 0 ..< 3 {
            XCTAssertEqual(actual[index], expected[index] / 255, accuracy: 0.01)
        }
        XCTAssertEqual(actual[3], 1, accuracy: 0.01)
    }

    private func contrast(_ foreground: Color, _ background: Color, appearance: NSAppearance) throws -> Double {
        let front = try rgba(foreground, appearance: appearance)
        let back = try rgba(background, appearance: appearance)
        XCTAssertEqual(back[3], 1, accuracy: 0.01, "Contrast requires the actual opaque surface")
        let composited = (0 ..< 3).map { front[$0] * front[3] + back[$0] * (1 - front[3]) }
        func luminance(_ channels: [Double]) -> Double {
            let linear = channels.prefix(3).map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
            return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
        }
        let a = luminance(composited), b = luminance(back)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }
}
