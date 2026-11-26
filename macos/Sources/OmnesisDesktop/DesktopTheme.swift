// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import SwiftUI

private struct DesktopContrastKey: EnvironmentKey {
    static let defaultValue: ColorSchemeContrast? = nil
}

extension EnvironmentValues {
    /// Follow the native preference unless an app-local preview or test supplies one.
    var desktopContrast: ColorSchemeContrast {
        get { self[DesktopContrastKey.self] ?? colorSchemeContrast }
        set { self[DesktopContrastKey.self] = newValue }
    }
}

/// Large areas stay quiet; the blue navigation plane carries the brand.
/// Opaque surfaces also remain legible with Reduce Transparency enabled.
enum DesktopTheme {
    static let accent = color(0x91BDF2)
    static let teal = color(0x79C7BF)
    static let ink = color(0xE9EFF7)
    static let secondary = color(0xA8B8CC)
    static let muted = color(0x8293AA)
    static let canvas = color(0x0B1524)
    static let navy = canvas
    static let sidebar = color(0x102B49)
    static let panel = color(0x142337)
    static let raised = color(0x1B2D43)
    static let border = color(0x2A3C52)
    static let primary = accent
    static let primaryInk = color(0x0B2038)
    static let primaryHover = color(0xB1D2FA)
    static let primaryPressed = color(0x76A7E2)
    static let disabled = color(0x23364B)
    static let selected = color(0x203F61)
    static let danger = color(0xF1A6A8)
    static let dangerHover = color(0xF5C4C5)
    static let dangerPressed = color(0xD88A90)
    static let dangerSurface = color(0x3B242C)
    static func color(_ hex: UInt32) -> Color {
        Color(
            .sRGB,
            red: Double((hex >> 16) & 255) / 255,
            green: Double((hex >> 8) & 255) / 255,
            blue: Double(hex & 255) / 255,
            opacity: 1
        )
    }
}

private struct DesktopThemeApplied: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    fileprivate var desktopThemeApplied: Bool {
        get { self[DesktopThemeApplied.self] }
        set { self[DesktopThemeApplied.self] = newValue }
    }
}

private struct DesktopThemeModifier: ViewModifier {
    @Environment(\.desktopThemeApplied) private var applied
    func body(content: Content) -> some View {
        if applied { content }
        else {
            content
                .environment(\.desktopThemeApplied, true)
                .environment(\.colorScheme, .dark)
                .tint(DesktopTheme.accent)
                .foregroundStyle(DesktopTheme.ink)
                .scrollContentBackground(.hidden)
                .groupBoxStyle(DesktopGroupBoxStyle())
                .background(DesktopTheme.canvas.ignoresSafeArea())
                .background(DesktopWindowAppearance())
        }
    }
}

/// Keep native titlebar and toolbar controls consistent with the app's navy appearance.
private struct DesktopWindowAppearance: NSViewRepresentable {
    @Environment(\.desktopContrast) private var contrast
    final class View: NSView {
        var preferredAppearance = NSAppearance.Name.darkAqua
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            window?.appearance = NSAppearance(named: preferredAppearance)
            window?.backgroundColor = NSColor(DesktopTheme.canvas)
        }
    }

    func makeNSView(context: Context) -> View {
        View()
    }

    func updateNSView(_ view: View, context: Context) {
        view.preferredAppearance = contrast == .increased ? .accessibilityHighContrastDarkAqua : .darkAqua
        view.window?.appearance = NSAppearance(named: view.preferredAppearance)
        view.window?.backgroundColor = NSColor(DesktopTheme.canvas)
    }
}

/// Applied only by an owning Root/Settings view, including when that product view is hosted in a capture.
struct DesktopOwnedWindowChrome: NSViewRepresentable {
    let swiftUIReportedTop: CGFloat

    final class View: NSView {
        private(set) var swiftUIReportedTop: CGFloat = 0
        private(set) var hasSwiftUIMeasurement = false

        func observe(top: CGFloat) {
            hasSwiftUIMeasurement = top.isFinite && top >= 0
            if hasSwiftUIMeasurement { swiftUIReportedTop = top }
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            applyChrome()
        }

        func applyChrome() {
            guard let window else { return }
            window.backgroundColor = NSColor(DesktopTheme.canvas)
        }
    }

    func makeNSView(context: Context) -> View {
        let view = View()
        view.observe(top: swiftUIReportedTop)
        return view
    }

    func updateNSView(_ view: View, context: Context) {
        view.observe(top: swiftUIReportedTop)
        view.applyChrome()
    }
}

extension View {
    /// Present a native sheet with an explicit opaque content background.
    /// Inherited theme values alone do not paint a separate presentation window.
    func omnesisSheet(
        isPresented: Binding<Bool>,
        onDismiss: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> some View
    )
        -> some View {
        sheet(isPresented: isPresented, onDismiss: onDismiss) {
            content().buttonStyle(DesktopButtonStyle()).omnesisTheme().presentationBackground(DesktopTheme.canvas)
        }
    }

    func omnesisSheet<Item: Identifiable>(
        item: Binding<Item?>,
        onDismiss: (() -> Void)? = nil,
        @ViewBuilder content: @escaping (Item) -> some View
    )
        -> some View {
        sheet(item: item, onDismiss: onDismiss) { item in
            content(item).buttonStyle(DesktopButtonStyle()).omnesisTheme().presentationBackground(DesktopTheme.canvas)
        }
    }

    /// Explicit preferences for the owning window toolbar; supported since macOS 13.
    func omnesisWindowChrome() -> some View {
        background(GeometryReader { geometry in
            DesktopOwnedWindowChrome(swiftUIReportedTop: geometry.safeAreaInsets.top)
        })
        .toolbarBackground(DesktopTheme.canvas, for: .windowToolbar)
        .toolbarBackground(.visible, for: .windowToolbar)
        .toolbarColorScheme(.dark, for: .windowToolbar)
        .preferredColorScheme(.dark)
    }

    func omnesisTheme() -> some View {
        modifier(DesktopThemeModifier())
    }

    func omnesisCard() -> some View {
        modifier(DesktopCardStyle())
    }
}

private struct DesktopCardStyle: ViewModifier {
    @Environment(\.desktopContrast) private var contrast
    func body(content: Content) -> some View {
        content.padding(20).background(DesktopTheme.panel, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(
                contrast == .increased ? DesktopTheme.secondary : DesktopTheme.border,
                lineWidth: contrast == .increased ? 2 : 1
            ))
    }
}

private struct DesktopGroupBoxStyle: GroupBoxStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            configuration.label.font(.headline)
            configuration.content
        }.frame(maxWidth: .infinity, alignment: .leading).omnesisCard()
    }
}

struct DesktopBrandMark: View {
    var size: CGFloat = 48
    var body: some View {
        Image("OmnesisMark").resizable().scaledToFit().foregroundStyle(.white)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

struct DesktopBrandHeading: View {
    let subtitle: String
    var body: some View {
        HStack(spacing: 14) {
            DesktopBrandMark(size: 32)
            VStack(alignment: .leading, spacing: 3) {
                Text("Omnesis").font(.system(size: 18, weight: .semibold))
                Text(subtitle).font(.caption).foregroundStyle(DesktopTheme.secondary)
            }
            Spacer()
        }.foregroundStyle(DesktopTheme.ink)
    }
}
