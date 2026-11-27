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

/// Opaque neutral surfaces share the same adaptive palette in SwiftUI and AppKit.
enum DesktopTheme {
    enum Palette {
        static func native(_ light: UInt32, _ dark: UInt32) -> NSColor {
            NSColor(name: nil) { appearance in
                let darkAppearance = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                let hex = darkAppearance ? dark : light
                return NSColor(
                    srgbRed: Double((hex >> 16) & 255) / 255,
                    green: Double((hex >> 8) & 255) / 255,
                    blue: Double(hex & 255) / 255,
                    alpha: 1
                )
            }
        }
    }

    static let nativeCanvas = Palette.native(0xFAFAFB, 0x13161B)
    static let canvas = Color(nsColor: nativeCanvas)
    static let sidebar = adaptive(0xF0F1F3, 0x1B1E24)
    static let surface = adaptive(0xF5F6F8, 0x191D23)
    static let elevated = adaptive(0xFFFFFF, 0x22262D)
    static let hover = adaptive(0xE8EBEF, 0x282D35)
    static let selected = adaptive(0xE0E5ED, 0x303640)
    static let pressed = adaptive(0xD7DDE7, 0x343B46)
    static let ink = adaptive(0x20242B, 0xF0F2F5)
    static let secondary = adaptive(0x505864, 0xB0B6C0)
    // Remains normal-text readable on pressed and selected surfaces as well as the canvas.
    static let tertiary = adaptive(0x58616D, 0xA0A7B2)
    static let decorative = adaptive(0x969DA8, 0x626A77)
    static let border = adaptive(0xDEE1E6, 0x2B3039)
    static let strongBorder = adaptive(0x7B8594, 0x818C9C)
    static let separator = adaptive(0xE2E5E9, 0x272C34)
    static let accent = adaptive(0x346CC5, 0x8DB8F4)
    static let accentHover = adaptive(0x285CAD, 0xA1C5F7)
    static let accentPressed = adaptive(0x204D96, 0x75A3E4)
    static let accentForeground = adaptive(0xFFFFFF, 0x101B2C)
    static let success = adaptive(0x297D62, 0x72B9A1)
    static let warning = adaptive(0x93621E, 0xD8AF72)
    static let danger = adaptive(0xB83E48, 0xE58B8B)
    static let dangerHover = adaptive(0xA3343F, 0xEFA3A3)
    static let dangerPressed = adaptive(0x8E2D37, 0xD97979)
    static let dangerInk = adaptive(0xFFFFFF, 0x271416)
    static let dangerSurface = adaptive(0xF7E8EA, 0x352328)
    static let focusRing = accent
    static let information = accent

    // Existing consumers can migrate independently while retaining semantic pairs.
    static let panel = surface
    static let raised = elevated
    static let primary = accent
    static let primaryHover = accentHover
    static let primaryPressed = accentPressed
    static let primaryInk = accentForeground
    static let muted = tertiary
    static let disabled = selected
    static let teal = success

    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: Palette.native(light, dark))
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
    @Environment(\.desktopAppearanceOverride) private var appearanceOverride
    @AppStorage(DesktopAppearance.storageKey) private var storedAppearance = DesktopAppearance.system.rawValue

    private var appearance: DesktopAppearance {
        appearanceOverride ?? DesktopAppearance(rawValue: storedAppearance) ?? .system
    }

    func body(content: Content) -> some View {
        if applied { content }
        else {
            content
                .environment(\.desktopThemeApplied, true)
                .toolbarColorScheme(appearance.colorScheme, for: .windowToolbar)
                .tint(DesktopTheme.accent)
                .foregroundStyle(DesktopTheme.ink)
                .font(DesktopDesignTokens.Typography.body)
                .scrollContentBackground(.hidden)
                .groupBoxStyle(DesktopGroupBoxStyle())
                .background(DesktopTheme.canvas.ignoresSafeArea())
                .background(DesktopWindowAppearance(appearance: appearance))
        }
    }
}

/// Configure only the window that owns this view; nil appearance follows macOS.
private struct DesktopWindowAppearance: NSViewRepresentable {
    let appearance: DesktopAppearance
    @Environment(\.desktopContrast) private var contrast

    final class View: NSView {
        var preferredAppearance: NSAppearance.Name?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            applyAppearance()
        }

        func applyAppearance() {
            window?.appearance = preferredAppearance.flatMap { NSAppearance(named: $0) }
            window?.backgroundColor = DesktopTheme.nativeCanvas
        }
    }

    func makeNSView(context: Context) -> View {
        View()
    }

    func updateNSView(_ view: View, context: Context) {
        switch appearance {
        case .system: view.preferredAppearance = nil
        case .light: view.preferredAppearance = contrast == .increased ? .accessibilityHighContrastAqua : .aqua
        case .dark: view.preferredAppearance = contrast == .increased ? .accessibilityHighContrastDarkAqua : .darkAqua
        }
        view.applyAppearance()
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
            window.backgroundColor = DesktopTheme.nativeCanvas
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
            content().buttonStyle(DesktopButtonStyle()).omnesisTheme().environment(\.desktopThemeApplied, false)
                .presentationBackground(DesktopTheme.canvas)
        }
    }

    func omnesisSheet<Item: Identifiable>(
        item: Binding<Item?>,
        onDismiss: (() -> Void)? = nil,
        @ViewBuilder content: @escaping (Item) -> some View
    )
        -> some View {
        sheet(item: item, onDismiss: onDismiss) { item in
            content(item).buttonStyle(DesktopButtonStyle()).omnesisTheme().environment(\.desktopThemeApplied, false)
                .presentationBackground(DesktopTheme.canvas)
        }
    }

    /// Explicit preferences for the owning window toolbar; supported since macOS 13.
    func omnesisWindowChrome() -> some View {
        background(GeometryReader { geometry in
            DesktopOwnedWindowChrome(swiftUIReportedTop: geometry.safeAreaInsets.top)
        })
        .toolbarBackground(DesktopTheme.canvas, for: .windowToolbar)
        .toolbarBackground(.visible, for: .windowToolbar)
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
        content.padding(DesktopDesignTokens.Space.regular)
            .background(DesktopTheme.surface, in: RoundedRectangle(cornerRadius: DesktopDesignTokens.Radius.large))
            .overlay(RoundedRectangle(cornerRadius: DesktopDesignTokens.Radius.large).strokeBorder(
                contrast == .increased ? DesktopTheme.strongBorder : DesktopTheme.border,
                lineWidth: contrast == .increased ? 2 : 1
            ))
    }
}

private struct DesktopGroupBoxStyle: GroupBoxStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.medium) {
            configuration.label.font(DesktopDesignTokens.Typography.section).accessibilityAddTraits(.isHeader)
            configuration.content
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct DesktopBrandMark: View {
    var size: CGFloat = 48
    var body: some View {
        Image("OmnesisMark").resizable().renderingMode(.template).scaledToFit().foregroundStyle(DesktopTheme.ink)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

struct DesktopBrandHeading: View {
    let subtitle: String
    var body: some View {
        HStack(spacing: DesktopDesignTokens.Space.medium) {
            DesktopBrandMark(size: 32)
            VStack(alignment: .leading, spacing: 3) {
                Text("Omnesis").font(DesktopDesignTokens.Typography.section)
                Text(subtitle).font(.caption).foregroundStyle(DesktopTheme.secondary)
            }
            Spacer()
        }.foregroundStyle(DesktopTheme.ink)
    }
}
