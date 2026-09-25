// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// Centralised colour, typography, and spacing tokens. Every colour is
/// **adaptive**: it carries a dark and a light value and resolves against
/// the active colour scheme, so the whole app follows the user's
/// appearance setting (System / Light / Dark) without any call site
/// having to branch. The dark variants mirror the portal's GitHub-dark
/// palette (`packages/gateway/portal/css/style.css`); the light variants
/// mirror the equivalent GitHub-light palette so the two themes read as
/// the same product.
///
/// Imports are intentionally narrow — extension functions on `Color` /
/// `View` keep call sites short (`.background(Theme.bgSecondary)`).
enum Theme {
    // MARK: - Background surfaces

    /// Page background. Light: white canvas. Dark: `#0d1117`.
    static let bgPrimary = Color(light: 0xFFFFFF, dark: 0x0D1117)
    /// Drawer/menu surface — set off from the page so the slide-out menu
    /// reads as a distinct layer in both themes.
    static let bgDrawer = Color(light: 0xEAEEF2, dark: 0x060A0F)
    /// Card / sidebar surface. Light: `#f6f8fa`. Dark: `#161b22`.
    static let bgSecondary = Color(light: 0xF6F8FA, dark: 0x161B22)
    /// Hovered rows / input chrome. Light: `#eaeef2`. Dark: `#21262d`.
    static let bgTertiary = Color(light: 0xEAEEF2, dark: 0x21262D)
    /// Border colour. Light: `#d0d7de`. Dark: `#30363d`.
    static let border = Color(light: 0xD0D7DE, dark: 0x30363D)
    /// Subtle divider between rows. Light: `#e4e8ec`. Dark: `#21262d`.
    static let borderLight = Color(light: 0xE4E8EC, dark: 0x21262D)

    // MARK: - Text

    /// Primary body / heading text. Light: `#1f2328`. Dark: `#e6edf3`.
    static let textPrimary = Color(light: 0x1F2328, dark: 0xE6EDF3)
    /// Labels, metadata. Light: `#59636e`. Dark: `#8b949e`.
    static let textSecondary = Color(light: 0x59636E, dark: 0x8B949E)
    /// Smallest captions. Light: `#656d76` (kept above the AA contrast
    /// floor on white). Dark: `#6e7681`.
    static let textMuted = Color(light: 0x656D76, dark: 0x6E7681)

    // MARK: - Accent / state

    /// Primary accent — links, focus, tab highlight. Light: `#0969da`.
    /// Dark: `#58a6ff`.
    static let accent = Color(light: 0x0969DA, dark: 0x58A6FF)
    /// Emphasis lift on the accent. Light: `#0860ca`. Dark: `#79c0ff`.
    static let accentHover = Color(light: 0x0860CA, dark: 0x79C0FF)

    /// Brand-mark color. Kept distinct from `accent` so the logo stays a
    /// consistent brand blue across every surface. Light: `#1f6feb`,
    /// dark: `#58a6ff`.
    static let brandLogo = Color(light: 0x1F6FEB, dark: 0x58A6FF)
    /// Brand-mark color for the demo build (orange). Light: `#f97316`,
    /// dark: `#fb923c`.
    static let brandLogoDemo = Color(light: 0xF97316, dark: 0xFB923C)
    /// Synced / success green. Light: `#1a7f37`. Dark: `#3fb950`.
    static let success = Color(light: 0x1A7F37, dark: 0x3FB950)
    /// Error red. Light: `#cf222e`. Dark: `#f85149`.
    static let danger = Color(light: 0xCF222E, dark: 0xF85149)
    /// Warning amber — needs-auth, paused-with-attention. Light:
    /// `#9a6700`. Dark: `#d29922`.
    static let warning = Color(light: 0x9A6700, dark: 0xD29922)

    // MARK: - Doc-type accent palette

    // Mirrors the portal's left-border colour-coding on result cards.
    // Light variants are darker/more-saturated so the thin accent stays
    // legible on a light surface.

    static func docTypeAccent(_ type: String?) -> Color {
        switch type {
        case "email": Color(light: 0xBC4C00, dark: 0xF78166)
        case "note": Color(light: 0x1A7F37, dark: 0x7EE787)
        case "event": Color(light: 0x8250DF, dark: 0xD2A8FF)
        case "conversation", "message": Color(light: 0x0969DA, dark: 0x79C0FF)
        case "bookmark": Color(light: 0x9A6700, dark: 0xFFA657)
        case "task", "reminder": Color(light: 0xCF222E, dark: 0xFF7B72)
        case "page": Color(light: 0x218BFF, dark: 0xA5D6FF)
        case "activity": Color(light: 0x1A7F37, dark: 0x7EE787)
        case "contact": Color(light: 0x8250DF, dark: 0xD2A8FF)
        default: accent
        }
    }

    // MARK: - State pills (background + foreground pair)

    struct PillColor {
        let background: Color
        let foreground: Color

        /// Accent-tinted pill — emphasised tags (e.g. operator-issued
        /// merge rules, cluster-merge headers).
        static let accentPill = PillColor(background: accent.opacity(0.15), foreground: accentHover)
        /// Neutral pill — low-emphasis tags (e.g. system-issued rules).
        static let neutralPill = PillColor(background: bgTertiary, foreground: textSecondary)
    }

    /// State-chip colour pair for a sync state string from
    /// `/admin/sync/status`. Falls back to a neutral pill on unknown.
    /// Built from the adaptive tokens above, so the pills follow the
    /// appearance setting too.
    static func pillColor(forState state: String?, paused: Bool) -> PillColor {
        if paused {
            return PillColor(background: bgTertiary, foreground: textMuted)
        }
        switch state {
        case "syncing":
            return PillColor(background: accent.opacity(0.15), foreground: accentHover)
        case "synced", "completed":
            return PillColor(background: success.opacity(0.15), foreground: success)
        case "error":
            return PillColor(background: danger.opacity(0.15), foreground: danger)
        case "needs-auth":
            return PillColor(background: warning.opacity(0.15), foreground: warning)
        case "auth-expiring":
            // Forward-looking consent-expiry (#927): the source is still
            // syncing fine, but its authorization expires soon. A softer
            // amber-tinted warning, distinct from the harder terminal
            // `needs-auth`; the inline "Expires on <date>" copy carries the
            // actual distinction in the rows/detail.
            return PillColor(background: warning.opacity(0.12), foreground: warning)
        case "stale":
            // The source syncs fine but its local data feed has stopped
            // delivering, usually because the app that maintains it isn't
            // running. Indexed data is intact and the fix takes seconds, so it
            // shares the soft amber of `auth-expiring` rather than error-red;
            // the inline hint in the row carries what to actually do.
            return PillColor(background: warning.opacity(0.12), foreground: warning)
        case "rate-limited":
            // Deferred, self-healing back-off — info-blue, not danger-red.
            return PillColor(background: accent.opacity(0.15), foreground: accentHover)
        case "idle":
            return PillColor(background: bgTertiary, foreground: textSecondary)
        case "disabled", "paused":
            return PillColor(background: bgTertiary, foreground: textMuted)
        default:
            return PillColor(background: bgTertiary, foreground: textSecondary)
        }
    }

    // MARK: - Typography

    /// Monospace font for IDs, hashes, technical strings. Mirrors the
    /// portal's `--font-mono: ui-monospace, SFMono-Regular, …`.
    static func monospace(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    // MARK: - Geometry

    enum Radius {
        static let small: CGFloat = 4
        static let medium: CGFloat = 6
        static let large: CGFloat = 8
        static let pill: CGFloat = 10
    }

    /// Minimum edge of a control that has to be comfortably hittable, per the
    /// Human Interface Guidelines. Use it for a control whose glyph is smaller
    /// than the target it needs.
    static let tapTarget: CGFloat = 44

    enum Spacing {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 16
        static let xl: CGFloat = 24
    }

    // MARK: - UIKit bridge

    //
    // UIKit chrome (tab bar, nav bar, etc.) takes `UIColor` rather than
    // SwiftUI `Color`. Mirror each token here as an adaptive `UIColor`
    // so call sites that touch `UITabBarAppearance` /
    // `UINavigationBarAppearance` resolve light/dark from the trait
    // collection automatically — no need to re-apply the appearance when
    // the scheme flips.

    enum UIKit {
        static let bgPrimary = UIColor(light: 0xFFFFFF, dark: 0x0D1117)
        static let bgSecondary = UIColor(light: 0xF6F8FA, dark: 0x161B22)
        static let bgTertiary = UIColor(light: 0xEAEEF2, dark: 0x21262D)
        static let border = UIColor(light: 0xD0D7DE, dark: 0x30363D)
        static let textPrimary = UIColor(light: 0x1F2328, dark: 0xE6EDF3)
        static let textSecondary = UIColor(light: 0x59636E, dark: 0x8B949E)
        static let textMuted = UIColor(light: 0x656D76, dark: 0x6E7681)
        static let accent = UIColor(light: 0x0969DA, dark: 0x58A6FF)
    }
}

extension UIColor {
    /// Hex initialiser for the `0x??????` syntax used in `Theme`.
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        let r = CGFloat((hex >> 16) & 0xFF) / 255
        let g = CGFloat((hex >> 8) & 0xFF) / 255
        let b = CGFloat(hex & 0xFF) / 255
        self.init(red: r, green: g, blue: b, alpha: alpha)
    }

    /// Adaptive initialiser: resolves `dark` under a dark trait
    /// collection and `light` otherwise. Backs the SwiftUI
    /// `Color(light:dark:)` token and the `Theme.UIKit` chrome colours.
    convenience init(light: UInt32, dark: UInt32, alpha: CGFloat = 1) {
        self.init(dynamicProvider: { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(hex: dark, alpha: alpha)
                : UIColor(hex: light, alpha: alpha)
        })
    }
}

extension Color {
    /// Hex initialiser for the 0x?????? syntax used in `Theme`.
    init(hex: UInt32, alpha: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double((hex >> 0) & 0xFF) / 255.0
        self = Color(red: r, green: g, blue: b, opacity: alpha)
    }

    /// Adaptive token initialiser: builds a `Color` that resolves to the
    /// `dark` hex under a dark colour scheme and the `light` hex
    /// otherwise. The whole `Theme` palette is built from this so a
    /// single `.preferredColorScheme` flip re-themes the app.
    init(light: UInt32, dark: UInt32, alpha: Double = 1.0) {
        self = Color(uiColor: UIColor(light: light, dark: dark, alpha: alpha))
    }

    /// Failable string-hex initialiser for provider-declared brand
    /// colors that arrive over the wire as "#RRGGBB" or "RRGGBB".
    /// Returns nil on parse failure so callers can fall back to a
    /// neutral token rather than crashing on bad data.
    init?(hex: String, alpha: Double = 1.0) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
        self.init(hex: value, alpha: alpha)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Theme — pills + card (dark)") {
    ThemePalettePreview()
        .environment(\.appearanceStore, AppearanceStore(mode: .dark))
}

@available(iOS 17.0, *)
#Preview("Theme — pills + card (light)") {
    ThemePalettePreview()
        .environment(\.appearanceStore, AppearanceStore(mode: .light))
}

/// Shared palette swatch used by both the light and dark theme previews
/// so the two themes can be eyeballed side by side.
@available(iOS 17.0, *)
private struct ThemePalettePreview: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                OmnesisPill(text: "synced", colors: Theme.pillColor(forState: "synced", paused: false))
                OmnesisPill(text: "syncing", colors: Theme.pillColor(forState: "syncing", paused: false))
                OmnesisPill(text: "error", colors: Theme.pillColor(forState: "error", paused: false))
                OmnesisPill(text: "needs auth", colors: Theme.pillColor(forState: "needs-auth", paused: false))
                OmnesisPill(text: "paused", colors: Theme.pillColor(forState: "synced", paused: true))
            }
            OmnesisCard {
                Text("Card surface — bg-secondary with border")
                    .foregroundStyle(Theme.textPrimary)
            }
            ForEach(["email", "note", "event", "conversation", "bookmark", "task"], id: \.self) { type in
                HStack {
                    Theme.docTypeAccent(type).frame(width: 3, height: 18)
                    Text(type)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textPrimary)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgPrimary)
        .omnesisColorScheme()
    }
}
#endif

/// Card surface — `--bg-secondary` with thin border. Use for stat
/// blocks, top summary, and group containers.
@available(iOS 17.0, *)
struct OmnesisCard<Content: View>: View {
    let content: Content
    var padding: CGFloat = Theme.Spacing.md

    init(padding: CGFloat = Theme.Spacing.md, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .padding(padding)
            .background(Theme.bgSecondary)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.large)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }
}

/// Section header used by the flat layout — mirrors the portal's
/// `pc-page-section-h` (12px / weight 600 / `--text-secondary`,
/// uppercase, tracking 0.5) with an optional horizontal rule that
/// fills the row to the right of the label.
///
/// Carries a small top inset so headers that follow other content
/// in a `VStack` get breathing room above them instead of sitting
/// flush against the previous section's last line. Sections that
/// already sit at the very top of a scroll view inherit the
/// outer container's top padding, so the extra inset is harmless
/// there.
@available(iOS 17.0, *)
struct FlatSectionHeader: View {
    let title: String
    var trailing: String?
    var showRule: Bool = true

    var body: some View {
        HStack(spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 12, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.textSecondary)
            if showRule {
                Rectangle()
                    .fill(Theme.border)
                    .frame(height: 1)
                    .frame(maxWidth: .infinity)
            }
            if let trailing {
                Text(trailing)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .monospacedDigit()
            }
        }
        .padding(.top, Theme.Spacing.md)
    }
}

/// Flat section — a `FlatSectionHeader` above content that sits
/// directly on the page background (no rounded card chrome, no
/// outer border). Used in place of `OmnesisCard` everywhere we
/// want the portal's "no card" look.
///
/// `FlatSection` injects its own top padding so that, when several
/// of these stack in a `VStack`, the header has breathing room
/// above it instead of sitting flush against the previous
/// section's content. The first section on a page still inherits
/// the page's leading inset from the outer container.
@available(iOS 17.0, *)
struct FlatSection<Content: View>: View {
    let title: String
    var trailing: String?
    @ViewBuilder let content: Content

    init(_ title: String, trailing: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.trailing = trailing
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            FlatSectionHeader(title: title, trailing: trailing)
            content
        }
    }
}

/// Pill / chip used for sync state, doc-type tags, and aliases.
@available(iOS 17.0, *)
struct OmnesisPill: View {
    let text: String
    let colors: Theme.PillColor
    var monospace: Bool = false

    var body: some View {
        Text(text)
            .font(monospace
                ? Theme.monospace(size: 11, weight: .medium)
                : .system(size: 11, weight: .medium))
            .textCase(.uppercase)
            .tracking(0.5)
            .foregroundStyle(colors.foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(colors.background)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.pill))
    }
}

#endif
