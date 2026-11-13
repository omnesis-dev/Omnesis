// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The colours and measures every access screen is drawn with: the Access page, the access-level
/// and source-filter flows, and the approval sheet.
enum AccessUI {
    /// Option cards, stat tiles, fields and dialogs.
    static let surface = Color(light: 0xF3F5F8, dark: 0x161B22)
    static let divider = Color(light: 0xE3E7EC, dark: 0x232A33)
    static let secondary = Color(light: 0x59636E, dark: 0x9AA4B2)
    /// Decisions a review lists as unchanged, and controls that are off: quieter than the secondary text, still
    /// readable at 4.5:1 on the background and on the surface in both themes.
    static let muted = Color(light: 0x57606A, dark: 0x8B949E)

    /// The one horizontal inset every title, row and button of a screen aligns to.
    static let inset: CGFloat = 20
    static let captionGap: CGFloat = 8
    static let headerGap: CGFloat = 24
    static let sectionGap: CGFloat = 32
    static let headingGap: CGFloat = 12
    static let rowPadding: CGFloat = 14
    static let rowMinHeight: CGFloat = 56
    static let iconGap: CGFloat = 12
    static let cardPadding: CGFloat = 16
    static let cardGap: CGFloat = 10
    static let cardRadius: CGFloat = 14
    static let controlSize: CGFloat = 22
    static let barHeight: CGFloat = 52
    static let buttonHeight: CGFloat = 52
    /// The label column of a before-and-after pair, which anything listed under one of its values aligns to.
    static let beforeAfterLabelWidth: CGFloat = 56
}

/// The type ramp of the access screens.
enum AccessTextStyle {
    case barTitle, barAction, caption, title, subtitle, heading, rowTitle, rowSecondary, pill, button, cardTitle, dialogTitle
    case stat, statLabel, label, capability

    var size: CGFloat {
        switch self {
        case .barTitle, .barAction, .heading: 17
        case .caption, .statLabel: 13
        case .title: 26
        case .subtitle: 15
        case .rowTitle, .button, .cardTitle: 16
        case .rowSecondary, .label: 14
        case .pill: 12
        case .capability: 11
        case .dialogTitle: 18
        case .stat: 28
        }
    }

    var weight: Font.Weight {
        switch self {
        case .barTitle, .caption, .title, .heading, .pill, .button, .cardTitle, .dialogTitle, .stat, .label, .capability: .semibold
        case .rowTitle: .medium
        case .barAction, .subtitle, .rowSecondary, .statLabel: .regular
        }
    }

    /// The line height the style is set on, where a wrapped text or a card's height depends on it.
    var lineHeight: CGFloat? {
        switch self {
        case .title: 32
        case .subtitle: 21
        case .rowSecondary, .label: 20
        default: nil
        }
    }

    var relativeTo: Font.TextStyle {
        switch self {
        case .title: .title
        case .barTitle, .barAction, .heading, .dialogTitle: .headline
        case .caption, .statLabel, .pill: .footnote
        case .capability: .caption2
        case .stat: .title2
        default: .body
        }
    }
}

/// A text style of the ramp at its size and line height, growing with the reader's type size.
private struct AccessTextModifier: ViewModifier {
    /// The system font's own line height, as a multiple of its size.
    private static let naturalLineHeight: CGFloat = 1.193

    @ScaledMetric private var size: CGFloat
    private let weight: Font.Weight
    /// The space to add per line to reach the style's line height, as a multiple of the size.
    private let leading: CGFloat

    init(_ style: AccessTextStyle) {
        _size = ScaledMetric(wrappedValue: style.size, relativeTo: style.relativeTo)
        weight = style.weight
        leading = style.lineHeight.map { max(0, $0 / style.size - Self.naturalLineHeight) } ?? 0
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight)).lineSpacing(size * leading).padding(.vertical, size * leading / 2)
    }
}

extension View {
    func accessText(_ style: AccessTextStyle, color: Color = Theme.textPrimary) -> some View {
        modifier(AccessTextModifier(style)).foregroundStyle(color)
    }
}

/// Gives a text the narrowest width that keeps its line count, so a title that wraps breaks into even lines.
struct AccessBalancedLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        guard let text = subviews.first else { return .zero }
        let available = proposal.width ?? .infinity
        let size = text.sizeThatFits(.init(width: balancedWidth(text, within: available), height: nil))
        return CGSize(width: available.isFinite ? available : size.width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        guard let text = subviews.first else { return }
        text.place(at: bounds.origin, proposal: .init(width: balancedWidth(text, within: bounds.width), height: bounds.height))
    }

    private func balancedWidth(_ text: LayoutSubview, within width: CGFloat) -> CGFloat {
        guard width.isFinite, width > 0 else { return width }
        let height = text.sizeThatFits(.init(width: width, height: nil)).height
        var low: CGFloat = 0
        var high = width
        for _ in 0 ..< 10 {
            let middle = (low + high) / 2
            if text.sizeThatFits(.init(width: middle, height: nil)).height <= height + 0.5 { high = middle } else { low = middle }
        }
        return min(width, ceil(high))
    }
}

/// A text action of the top bar: Close, Cancel or Back.
struct AccessBarButton: View {
    let title: String
    let action: () -> Void

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title).accessText(.barAction, color: Theme.accent).frame(minHeight: 44).contentShape(.rect)
        }.buttonStyle(.plain)
    }
}

/// The bar at the top of a screen: a centred title, a text action leading it, and at most one action trailing it.
struct AccessTopBar<Leading: View, Trailing: View>: View {
    let title: String
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        ZStack {
            Text(title).accessText(.barTitle).lineLimit(1).padding(.horizontal, 76).accessibilityAddTraits(.isHeader)
            HStack(spacing: 0) {
                leading()
                Spacer(minLength: 0)
                trailing()
            }
        }
        .padding(.horizontal, AccessUI.inset)
        .frame(maxWidth: .infinity, minHeight: AccessUI.barHeight)
        .background(Theme.bgPrimary)
    }
}

extension AccessTopBar where Trailing == EmptyView {
    init(title: String, @ViewBuilder leading: @escaping () -> Leading) {
        self.init(title: title, leading: leading) { EmptyView() }
    }
}

/// A screen on the app background: its bar, its body, and its actions pinned under the body so nothing scrolls beneath them.
struct AccessFrame<Bar: View, Content: View, Footer: View>: View {
    @ViewBuilder var bar: () -> Bar
    @ViewBuilder var content: () -> Content
    @ViewBuilder var footer: () -> Footer

    var body: some View {
        VStack(spacing: 0) {
            bar()
            content().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            footer()
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .tint(Theme.accent)
    }
}

/// The scrolling body of a screen, inset on both sides.
struct AccessScroll<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) { content() }
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .padding(.horizontal, AccessUI.inset)
                .padding(.top, 16)
                .padding(.bottom, AccessUI.headerGap)
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

/// The area that holds a screen's pinned action.
struct AccessFooter<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) { content() }
            .padding(.horizontal, AccessUI.inset)
            .padding(.top, 12)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity)
            .background(Theme.bgPrimary)
    }
}

/// The full-width capsule that carries a screen's one primary action, on one line.
struct AccessPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .accessText(.button, color: enabled ? Theme.bgPrimary : AccessUI.muted)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, minHeight: AccessUI.buttonHeight)
            .background(enabled ? Theme.accent : AccessUI.surface, in: Capsule())
            .opacity(enabled && configuration.isPressed ? 0.8 : 1)
    }
}

/// A secondary action inside a screen's body: an outlined, full-width button with an accent label that may wrap.
struct AccessSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .accessText(.button, color: enabled ? Theme.accent : AccessUI.muted)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 44)
            .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(AccessUI.divider, lineWidth: 1) }
            .contentShape(.rect(cornerRadius: 12))
            .opacity(enabled && configuration.isPressed ? 0.6 : 1)
    }
}

/// The top of a screen's body: an optional caption, the question, and one grey line or an account under it.
struct AccessHeader<Accessory: View>: View {
    var caption: String?
    let title: String
    var subtitle: String?
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        VStack(alignment: .leading, spacing: AccessUI.captionGap) {
            if let caption { Text(caption).accessText(.caption, color: Theme.accent) }
            AccessBalancedLayout {
                Text(title).accessText(.title).fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityAddTraits(.isHeader)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle).accessText(.subtitle, color: AccessUI.secondary).fixedSize(horizontal: false, vertical: true)
            }
            accessory()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, AccessUI.headerGap)
    }
}

extension AccessHeader where Accessory == EmptyView {
    init(caption: String? = nil, title: String, subtitle: String? = nil) {
        self.init(caption: caption, title: title, subtitle: subtitle) { EmptyView() }
    }
}

/// A heading inside a screen, above the rows it names. `first` leaves out the space that separates it from a section above.
struct AccessSectionHeading<Trailing: View>: View {
    let title: String
    var first = false
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title).accessText(.heading).accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.top, first ? 0 : AccessUI.sectionGap)
        .padding(.bottom, AccessUI.headingGap)
    }
}

extension AccessSectionHeading where Trailing == EmptyView {
    init(_ title: String, first: Bool = false) {
        self.init(title: title, first: first) { EmptyView() }
    }
}

/// The hairline under a row, starting where the row's text starts.
struct AccessDivider: View {
    var leading: CGFloat = 0

    var body: some View {
        Rectangle().fill(AccessUI.divider).frame(height: 1).padding(.leading, leading).accessibilityHidden(true)
    }
}

/// A flat row with a hairline under it; a section's last row has none.
struct AccessRow<Content: View>: View {
    var last = false
    var dividerInset: CGFloat = 0
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            content()
                .padding(.vertical, AccessUI.rowPadding)
                .frame(maxWidth: .infinity, minHeight: AccessUI.rowMinHeight, alignment: .leading)
            if !last { AccessDivider(leading: dividerInset) }
        }
    }
}

/// The accent "Change" that opens a decision or a filter from its row.
struct AccessChangeButton: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text("Change").accessText(.rowTitle, color: Theme.accent).fontWeight(.regular).frame(minHeight: 28).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// The box a single-line field or a menu sits in: on the surface colour on a page, on the page colour inside a card.
struct AccessFieldBox: ViewModifier {
    var fill = AccessUI.surface

    func body(content: Content) -> some View {
        content.padding(.horizontal, 16).frame(minHeight: 52).background(fill, in: .rect(cornerRadius: 12))
    }
}

/// A single-line text field: its text style, in the field box.
struct AccessFieldChrome: ViewModifier {
    var fill = AccessUI.surface

    func body(content: Content) -> some View {
        content.accessText(.rowTitle).fontWeight(.regular).modifier(AccessFieldBox(fill: fill))
    }
}

/// The field an access level is named in, with what stops the name from being used under it.
struct AccessLevelNameField: View {
    @Binding var name: String
    let problem: String?
    var fill = AccessUI.surface

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField(
                AccessConnectionCopy.levelNameLabel,
                text: $name,
                prompt: Text(AccessConnectionCopy.levelNameLabel).foregroundStyle(AccessUI.secondary)
            )
            .submitLabel(.done)
            .accessibilityIdentifier("access-level-name")
            .modifier(AccessFieldChrome(fill: fill))
            AccessProblemText(text: problem)
        }
    }
}

/// A search field: the field chrome with a magnifier leading it and a way to clear what was typed.
struct AccessSearchField: View {
    let prompt: String
    @Binding var text: String
    var accessibilityLabel: String?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").font(.system(size: 16)).foregroundStyle(AccessUI.secondary).accessibilityHidden(true)
            TextField(prompt, text: $text, prompt: Text(prompt).foregroundStyle(AccessUI.secondary))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityLabel(accessibilityLabel ?? prompt)
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(AccessUI.secondary).frame(minWidth: 32, minHeight: 44)
                }.buttonStyle(.plain).accessibilityLabel("Clear search")
            }
        }
        .modifier(AccessFieldChrome())
    }
}

#if DEBUG
#Preview("Screen furniture") {
    AccessFrame {
        AccessTopBar(title: "Access level") { AccessBarButton("Back") {} } trailing: { AccessBarButton("Cancel") {} }
    } content: {
        AccessScroll {
            AccessHeader(caption: "Research assistant", title: "What should this access level be called?", subtitle: "One grey line.")
            TextField("", text: .constant("Research assistant")).modifier(AccessFieldChrome())
            AccessSectionHeading("Rows")
            AccessRow { Text("Permissions").accessText(.rowTitle) }
            AccessRow(last: true) { Text("New sources").accessText(.rowTitle) }
            AccessSearchField(prompt: "Search sources", text: .constant(""))
        }
    } footer: {
        AccessFooter {
            Button("Review changes") {}.buttonStyle(AccessPrimaryButtonStyle())
            Button("Review changes") {}.buttonStyle(AccessPrimaryButtonStyle()).disabled(true)
        }
    }
}
#endif
#endif
