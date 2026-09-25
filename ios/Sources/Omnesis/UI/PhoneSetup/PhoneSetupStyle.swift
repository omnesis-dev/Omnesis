// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Colours for phone setup's full-screen pages. The ground and the brand
/// gradient come from the landing surface (`LandingPalette`), so setup reads as
/// the same product as the agent's first screen; each step's tint is the one
/// accent on its page.
enum PhoneSetupPalette {
    static let textPrimary = Color(light: 0x18202C, dark: 0xE6EDF3)
    static let textSecondary = Color(light: 0x4A5666, dark: 0x9AA6B3)
    static let textMuted = Color(light: 0x6A7584, dark: 0x7D8998)
    static let card = Color(light: 0xF3F6FA, dark: 0x0E1624)
    static let cardBorder = Color(light: 0xDCE3EC, dark: 0x1D2838)
    static let chip = Color(light: 0xE6ECF4, dark: 0x152032)
    static let chipText = Color(light: 0x334155, dark: 0xCFD9E4)
    static let keptBorder = Color(light: 0xB4C1D1, dark: 0x3A4A60)
    static let progressPending = Color(light: 0xD8E0EA, dark: 0x1F2A3A)
    static let switchOff = Color(light: 0xD5DDE7, dark: 0x253144)
    /// Section labels, a step darker than `textMuted` on the light page.
    static let sectionLabel = Color(light: 0x566070, dark: 0x7D8998)
    static let disabledFill = Color(light: 0xE3E8EF, dark: 0x1A2433)
    static let success = Color(light: 0x1A7F37, dark: 0x3FB950)
    static let warning = Color(light: 0x9A6700, dark: 0xD29922)
    static let danger = Color(light: 0xCF222E, dark: 0xF85149)
    static let link = Color(light: 0x0B55C9, dark: 0x9CC4FF)
    static let brandGradient = LinearGradient(
        colors: [LandingPalette.markLight, LandingPalette.markMid, LandingPalette.markDeep],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}

/// A step's accent. The raw tint fills rings, bars and the halo; glyphs and
/// small text use a deepened tint on the light page, where saturated yellows
/// and oranges would wash out against white.
struct PhoneSetupTint: Equatable {
    static let brand = PhoneSetupTint(hex: 0x4B9BFF)

    let hex: UInt32

    var fill: Color {
        Color(hex: hex)
    }

    var ink: Color {
        Color(light: Self.deepened(hex), dark: hex)
    }

    static func deepened(_ hex: UInt32, by amount: Double = 0.3) -> UInt32 {
        func channel(_ shift: UInt32) -> UInt32 {
            UInt32((Double((hex >> shift) & 0xFF) * (1 - amount)).rounded()) << shift
        }
        return channel(16) | channel(8) | channel(0)
    }
}

// MARK: - Motion

private struct PhoneSetupMotionKey: EnvironmentKey {
    static let defaultValue = true
}

private struct PhoneSetupPromptVisibleKey: EnvironmentKey {
    static let defaultValue: Bool? = nil
}

extension EnvironmentValues {
    /// Whether setup animates: the travelling dot, the drawn check ring, the
    /// halo's cross-fade. Renders and snapshots turn it off; Reduce Motion
    /// turns it off as well.
    var phoneSetupMotion: Bool {
        get { self[PhoneSetupMotionKey.self] }
        set { self[PhoneSetupMotionKey.self] = newValue }
    }

    /// Overrides whether an iOS permission prompt counts as visible, for
    /// renders that cannot raise a real one.
    var phoneSetupPromptVisible: Bool? {
        get { self[PhoneSetupPromptVisibleKey.self] }
        set { self[PhoneSetupPromptVisibleKey.self] = newValue }
    }
}

// MARK: - Type

extension View {
    func phoneSetupTitle() -> some View {
        font(.system(.title, weight: .bold))
            .tracking(-0.3)
            .foregroundStyle(PhoneSetupPalette.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
    }

    func phoneSetupBody() -> some View {
        font(.callout)
            .lineSpacing(2)
            .foregroundStyle(PhoneSetupPalette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    func phoneSetupFinePrint() -> some View {
        font(.footnote)
            .foregroundStyle(PhoneSetupPalette.textMuted)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// The rounded card every grouped block on a setup page sits in.
    func phoneSetupCard(padding: CGFloat = 16) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous).fill(PhoneSetupPalette.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(PhoneSetupPalette.cardBorder, lineWidth: 1)
            )
    }
}

/// Small uppercase label heading a card section.
struct PhoneSetupSectionLabel: View {
    let text: String
    var symbol: String?

    var body: some View {
        HStack(spacing: 6) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.system(size: 10, weight: .bold))
                    .accessibilityHidden(true)
            }
            Text(text.uppercased())
                .font(.caption2.weight(.semibold))
                .tracking(0.8)
        }
        .foregroundStyle(PhoneSetupPalette.sectionLabel)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Buttons

/// The page's one primary action. Disabled, it turns neutral with muted text
/// rather than fading the gradient, which reads as enabled on a light page.
struct PhoneSetupPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(isEnabled ? Color.white : PhoneSetupPalette.textMuted)
            .frame(maxWidth: .infinity, minHeight: 54)
            .background {
                if isEnabled {
                    RoundedRectangle(cornerRadius: 16, style: .continuous).fill(PhoneSetupPalette.brandGradient)
                } else {
                    RoundedRectangle(cornerRadius: 16, style: .continuous).fill(PhoneSetupPalette.disabledFill)
                }
            }
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

/// A full-width secondary action beside the primary one.
struct PhoneSetupOutlineButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(PhoneSetupPalette.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 54)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(PhoneSetupPalette.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(PhoneSetupPalette.cardBorder, lineWidth: 1)
            )
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
    }
}

struct PhoneSetupTextButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(PhoneSetupPalette.link)
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

// MARK: - Marks

/// A step's glyph on a tinted rounded square.
struct PhoneSetupGlyphTile: View {
    let symbol: String
    let tint: PhoneSetupTint
    var size: CGFloat = 60

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(tint.fill.opacity(0.16))
            .overlay(
                RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                    .strokeBorder(tint.fill.opacity(0.45), lineWidth: 1)
            )
            .overlay(
                Image(systemName: symbol)
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(tint.ink)
            )
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The Omnesis mark on the brand gradient, lit from behind.
struct PhoneSetupBrandTile: View {
    var size: CGFloat = 68

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .fill(PhoneSetupPalette.brandGradient)
            .overlay(
                Image("OmnesisMark")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.white)
                    .padding(size * 0.22)
            )
            .frame(width: size, height: size)
            .shadow(color: LandingPalette.markGlow.opacity(0.5), radius: size * 0.32)
            .accessibilityHidden(true)
    }
}

/// The Omnesis mark on its own, lit from behind: white over the dark page and
/// brand blue over the light one, where white would vanish.
struct PhoneSetupBrandMark: View {
    var size: CGFloat = 76

    var body: some View {
        Image("OmnesisMark")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(Color(light: PhoneSetupTint.deepened(PhoneSetupTint.brand.hex), dark: 0xFFFFFF))
            .frame(width: size, height: size)
            .shadow(color: LandingPalette.markGlow.opacity(0.55), radius: size * 0.35)
            .accessibilityHidden(true)
    }
}

/// Thin segmented progress: one segment per selected step.
struct PhoneSetupProgressBar: View {
    let count: Int
    let current: Int
    let tint: PhoneSetupTint

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0 ..< count, id: \.self) { index in
                Capsule()
                    .fill(color(for: index))
                    .frame(height: 4)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Step \(current + 1) of \(count)")
    }

    private func color(for index: Int) -> Color {
        if index == current { return tint.fill }
        return index < current ? PhoneSetupPalette.textPrimary.opacity(0.55) : PhoneSetupPalette.progressPending
    }
}

/// A switch drawn to match iOS, for rows whose whole surface is the control.
struct PhoneSetupSwitch: View {
    let isOn: Bool

    var body: some View {
        Capsule()
            .fill(isOn ? Color(hex: 0x34C759) : PhoneSetupPalette.switchOff)
            .frame(width: 51, height: 31)
            .overlay(alignment: isOn ? .trailing : .leading) {
                Circle()
                    .fill(.white)
                    .shadow(color: .black.opacity(0.15), radius: 2, y: 1)
                    .padding(2)
            }
            .accessibilityHidden(true)
    }
}

// MARK: - Chips

struct PhoneSetupChip: View {
    enum Style: Equatable {
        /// Something sent to the gateway.
        case sent
        /// Something that never leaves the phone: dashed outline.
        case kept
        /// A choice the user can switch on or off.
        case option(isOn: Bool)
    }

    let text: String
    let style: Style
    var tint = PhoneSetupTint.brand

    var body: some View {
        HStack(spacing: 5) {
            if case .option(let isOn) = style {
                Image(systemName: isOn ? "checkmark" : "plus")
                    .font(.system(size: 10, weight: .bold))
                    .accessibilityHidden(true)
            }
            Text(text)
                .font(.footnote.weight(.medium))
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .background(Capsule().fill(fill))
        .overlay(
            Capsule().strokeBorder(border, style: StrokeStyle(lineWidth: 1, dash: style == .kept ? [3, 3] : []))
        )
    }

    private var foreground: Color {
        switch style {
        case .sent: PhoneSetupPalette.chipText
        case .kept: PhoneSetupPalette.textSecondary
        case .option(let isOn): isOn ? tint.ink : PhoneSetupPalette.textSecondary
        }
    }

    private var fill: Color {
        switch style {
        case .sent: PhoneSetupPalette.chip
        case .kept: .clear
        case .option(let isOn): isOn ? tint.fill.opacity(0.14) : .clear
        }
    }

    private var border: Color {
        switch style {
        case .sent: .clear
        case .kept: PhoneSetupPalette.keptBorder
        case .option(let isOn): isOn ? tint.fill.opacity(0.5) : PhoneSetupPalette.cardBorder
        }
    }
}

/// Lays chips out in rows, wrapping to the next row when one would overflow.
struct PhoneSetupFlowLayout: Layout {
    var spacing: CGFloat = 6
    /// Space between rows; `spacing` when nil.
    var rowSpacing: CGFloat?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.last.map { $0.origin + $0.height } ?? 0
        let widest = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? widest, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        for row in arrange(width: bounds.width, subviews: subviews) {
            for item in row.items {
                subviews[item.index].place(
                    at: CGPoint(x: bounds.minX + item.offset, y: bounds.minY + row.origin),
                    proposal: ProposedViewSize(item.size)
                )
            }
        }
    }

    private struct Item {
        let index: Int
        let offset: CGFloat
        let size: CGSize
    }

    private struct Row {
        var origin: CGFloat
        var items: [Item] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row(origin: 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil))
            if !row.items.isEmpty, row.width + spacing + size.width > width {
                rows.append(row)
                row = Row(origin: row.origin + row.height + (rowSpacing ?? spacing))
            }
            let offset = row.items.isEmpty ? 0 : row.width + spacing
            row.items.append(Item(index: index, offset: offset, size: size))
            row.width = offset + size.width
            row.height = max(row.height, size.height)
        }
        if !row.items.isEmpty {
            rows.append(row)
        }
        return rows
    }
}

// MARK: - Page chrome

/// Every setup page: an optional pinned header, scrolling content, and actions
/// pinned to the bottom. Content keeps a readable width on iPad, and can be
/// centred vertically when it fits without scrolling.
struct PhoneSetupPageLayout<Header: View, Content: View, Actions: View>: View {
    var centersContent = false
    @ViewBuilder var header: Header
    @ViewBuilder var content: Content
    @ViewBuilder var actions: Actions

    private static var fadeHeight: CGFloat {
        24
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 24)
                .padding(.top, 8)
            GeometryReader { proxy in
                ScrollView {
                    content
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 24)
                        .padding(.bottom, 24)
                        .frame(
                            minHeight: centersContent ? proxy.size.height : nil,
                            alignment: centersContent ? .center : .top
                        )
                }
                .scrollIndicators(.hidden)
                .scrollBounceBehavior(.basedOnSize)
                // Content scrolling under the actions fades out over whatever
                // is behind the page instead of ending at a hard edge.
                .mask {
                    VStack(spacing: 0) {
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                            .frame(height: Self.fadeHeight)
                    }
                }
            }
            actions
                .padding(.horizontal, 24)
                .padding(.top, 8)
                .padding(.bottom, 12)
        }
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
    }
}

extension PhoneSetupPageLayout where Header == EmptyView {
    init(centersContent: Bool = false, @ViewBuilder content: () -> Content, @ViewBuilder actions: () -> Actions) {
        self.centersContent = centersContent
        header = EmptyView()
        self.content = content()
        self.actions = actions()
    }
}

#if DEBUG
#Preview("Phone setup — brand mark") {
    HStack(spacing: 40) {
        PhoneSetupBrandMark()
            .padding(40)
            .background(LandingPalette.base)
            .environment(\.colorScheme, .dark)
        PhoneSetupBrandMark()
            .padding(40)
            .background(LandingPalette.base)
            .environment(\.colorScheme, .light)
    }
}

#Preview("Phone setup — components") {
    ZStack {
        PhoneSetupBackdrop(tint: PhoneSetupTint(hex: 0x0A84FF))
        VStack(alignment: .leading, spacing: 18) {
            PhoneSetupProgressBar(count: 4, current: 1, tint: PhoneSetupTint(hex: 0x0A84FF))
            HStack(spacing: 16) {
                PhoneSetupBrandTile()
                PhoneSetupGlyphTile(symbol: "photo.on.rectangle", tint: PhoneSetupTint(hex: 0x0A84FF))
                PhoneSetupGlyphTile(symbol: "bell.fill", tint: PhoneSetupTint(hex: 0xFFD60A))
                PhoneSetupSwitch(isOn: true)
            }
            PhoneSetupFlowLayout {
                PhoneSetupChip(text: "Text found in the image", style: .sent)
                PhoneSetupChip(text: "Scene labels", style: .sent)
                PhoneSetupChip(text: "The photos themselves", style: .kept)
                PhoneSetupChip(text: "Sleep", style: .option(isOn: true), tint: PhoneSetupTint(hex: 0xFF2D55))
                PhoneSetupChip(text: "Mood", style: .option(isOn: false))
            }
            Button("Continue") {}.buttonStyle(PhoneSetupPrimaryButtonStyle())
            Button("Open Settings") {}.buttonStyle(PhoneSetupOutlineButtonStyle())
        }
        .padding(24)
    }
    .omnesisColorScheme()
}
#endif
#endif
