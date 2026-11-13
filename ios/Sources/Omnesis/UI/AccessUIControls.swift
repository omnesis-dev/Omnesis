// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The checkbox or radio that leads an option, a source account or a filter item.
struct AccessControlMark: View {
    enum Kind { case checkbox, radio }

    let kind: Kind
    let selected: Bool
    var tint: Color = Theme.accent

    var body: some View {
        Group {
            switch kind {
            case .checkbox:
                RoundedRectangle(cornerRadius: 6)
                    .fill(selected ? tint : Color.clear)
                    .overlay { if !selected { RoundedRectangle(cornerRadius: 6).strokeBorder(AccessUI.muted, lineWidth: 1.5) } }
                    .overlay {
                        if selected {
                            Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.bgPrimary)
                        }
                    }
            case .radio:
                Circle()
                    .strokeBorder(selected ? tint : AccessUI.muted, lineWidth: selected ? 2 : 1.5)
                    .overlay { if selected { Circle().fill(tint).padding(6) } }
            }
        }
        .frame(width: AccessUI.controlSize, height: AccessUI.controlSize)
        .accessibilityHidden(true)
    }
}

/// An option on the surface colour: its control on the left, its title, and what choosing it means.
/// An option that reads raw records is outlined in the danger colour and states its warning once chosen.
struct AccessOptionCard: View {
    let title: String
    var detail = ""
    var warning: String?
    let selected: Bool
    var control: AccessControlMark.Kind = .radio

    private var tint: Color {
        warning == nil ? Theme.accent : Theme.danger
    }

    var body: some View {
        HStack(alignment: .top, spacing: AccessUI.iconGap) {
            AccessControlMark(kind: control, selected: selected)
            VStack(alignment: .leading, spacing: 4) {
                AccessBalancedLayout { Text(title).accessText(.cardTitle).fixedSize(horizontal: false, vertical: true) }
                    .frame(minHeight: AccessUI.controlSize)
                if !detail.isEmpty { Text(detail).accessText(.rowSecondary, color: AccessUI.secondary) }
                if let warning {
                    Text(warning).accessText(.label, color: selected ? Theme.danger : AccessUI.secondary).padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(AccessUI.cardPadding)
        .background(AccessUI.surface, in: .rect(cornerRadius: AccessUI.cardRadius))
        .overlay { if selected { RoundedRectangle(cornerRadius: AccessUI.cardRadius).strokeBorder(tint, lineWidth: 1.5) } }
        .contentShape(.rect(cornerRadius: AccessUI.cardRadius))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

/// A short pill, toned by what it says.
struct AccessPill: View {
    enum Tone { case neutral, accent, danger, success, outlined }

    let text: String
    var tone: Tone = .neutral

    var body: some View {
        Text(text)
            .accessText(.pill, color: foreground)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .frame(minHeight: 24)
            .background(background, in: .rect(cornerRadius: 6))
            .overlay { if tone == .outlined { RoundedRectangle(cornerRadius: 6).strokeBorder(AccessUI.divider) } }
    }

    private var foreground: Color {
        switch tone {
        case .neutral: AccessUI.secondary
        case .accent: Theme.accent
        case .danger: Theme.danger
        case .success: Theme.success
        case .outlined: AccessUI.muted
        }
    }

    private var background: Color {
        switch tone {
        case .neutral: AccessUI.surface
        case .accent: Theme.accent.opacity(0.15)
        case .danger: Theme.danger.opacity(0.15)
        case .success: Theme.success.opacity(0.15)
        case .outlined: .clear
        }
    }
}

/// The icon of a source account, from the account's own artwork or the app's icon for its source.
@available(iOS 17.0, *)
struct AccessSourceIcon: View {
    @Environment(AppStore.self) private var store
    let source: AccessSourceInstance
    var size: CGFloat = 24

    var body: some View {
        SourceIconView(sourceId: source.id, store: store, size: size, art: source.icon?.nilIfBlank).accessibilityHidden(true)
    }
}

/// The account a filter belongs to, under the screen's title: its icon, then "Source · account".
@available(iOS 17.0, *)
struct AccessAccountLine: View {
    let source: AccessSourceInstance

    var body: some View {
        HStack(spacing: 8) {
            AccessSourceIcon(source: source, size: 20)
            Text(accessAccountLineText(source)).accessText(.subtitle, color: AccessUI.secondary).lineLimit(1).truncationMode(.middle)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A source account in a list: the source's name, the account on its own line, and what the account shares.
/// A list that only shows the accounts passes no `selected`; one that picks them passes `toggle` as well.
/// The checkbox, the icon and the trailing action are centred on the row, and the hairline under it spans the row.
@available(iOS 17.0, *)
struct AccessAccountRow<Trailing: View>: View {
    let source: AccessSourceInstance
    var selected: Bool?
    let status: AccessAccountStatus
    var last = false
    var toggle: (() -> Void)?
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        AccessRow(last: last) {
            HStack(alignment: .center, spacing: AccessUI.iconGap) {
                if let toggle {
                    Button(action: toggle) { account }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Share \(accessAccountLineText(source))")
                        .accessibilityValue(status.text)
                        .accessibilityAddTraits(selected == true ? [.isButton, .isSelected] : .isButton)
                } else {
                    account.accessibilityElement(children: .combine)
                }
                trailing()
            }
        }
    }

    private var account: some View {
        let name = accessSourceNameParts(source)
        return HStack(alignment: .center, spacing: AccessUI.iconGap) {
            if let selected { AccessControlMark(kind: .checkbox, selected: selected) }
            AccessSourceIcon(source: source)
            VStack(alignment: .leading, spacing: 4) {
                Text(name.source).accessText(.rowTitle).lineLimit(1)
                if let account = name.account {
                    Text(account).accessText(.rowSecondary, color: AccessUI.secondary).lineLimit(1).truncationMode(.middle)
                }
                AccessPill(status: status).padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(.rect)
    }
}

@available(iOS 17.0, *)
extension AccessAccountRow where Trailing == EmptyView {
    init(source: AccessSourceInstance, status: AccessAccountStatus, last: Bool = false) {
        self.init(source: source, selected: nil, status: status, last: last, toggle: nil) { EmptyView() }
    }
}

extension AccessPill {
    init(status: AccessAccountStatus) {
        self.init(text: status.text, tone: status.tone)
    }
}

extension AccessAccountStatus {
    var tone: AccessPill.Tone {
        switch kind {
        case .all: .neutral
        case .only: .accent
        case .except: .danger
        case .notShared: .outlined
        }
    }
}

/// The kinds of item a filter can match, as rectangular tabs in a row that scrolls past both screen edges.
struct AccessKindTabs: View {
    struct Tab: Identifiable, Equatable {
        let id: String
        let title: String
    }

    let tabs: [Tab]
    @Binding var selection: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(tabs) { tab in
                    let selected = tab.id == selection
                    Button { selection = tab.id } label: {
                        Text(tab.title)
                            .accessText(.label, color: selected ? Theme.textPrimary : AccessUI.secondary)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 36)
                            .background(selected ? AccessUI.surface : Color.clear, in: .rect(cornerRadius: 8))
                            .overlay { if !selected { RoundedRectangle(cornerRadius: 8).strokeBorder(AccessUI.divider) } }
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            .padding(.horizontal, AccessUI.inset)
        }
        .padding(.horizontal, -AccessUI.inset)
    }
}

/// What a decision was and what it becomes, as two labelled rows.
struct AccessBeforeAfter<Before: View, After: View>: View {
    @ViewBuilder var before: () -> Before
    @ViewBuilder var after: () -> After

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AccessBeforeAfterLine(side: .before) { before() }
            AccessBeforeAfterLine(side: .after) { after() }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One row of a before-and-after pair: "Before" in the secondary colour or "After" in the accent colour, in a
/// column of its own, then the value.
struct AccessBeforeAfterLine<Value: View>: View {
    enum Side { case before, after }

    let side: Side
    @ViewBuilder var value: () -> Value

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(side == .before ? "Before" : "After")
                .accessText(.label, color: side == .before ? AccessUI.secondary : Theme.accent)
                .frame(width: AccessUI.beforeAfterLabelWidth, alignment: .leading)
            value().frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// A value of a before-and-after pair written out: secondary before, primary after.
struct AccessBeforeAfterText: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text).accessText(.subtitle, color: color).fixedSize(horizontal: false, vertical: true)
    }
}

extension AccessBeforeAfter where Before == AccessBeforeAfterText, After == AccessBeforeAfterText {
    init(before: String, after: String) {
        self.init {
            AccessBeforeAfterText(text: before, color: AccessUI.secondary)
        } after: {
            AccessBeforeAfterText(text: after, color: Theme.textPrimary)
        }
    }
}

/// Answer, Direct and Notes as three small pills, always in that order: a capability the level allows in its own
/// colour (Answer green, Direct red, Notes blue) on a faint tint of it, one it does not outlined in the muted colour.
/// Wherever a level's capabilities are listed, they are listed with this row.
struct AccessCapabilityPills: View {
    let holdings: AccessCapabilityHoldings

    var body: some View {
        // The pills sit in a row when it fits and stack when the text is too large for one, so no label is cut.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { pills }
            VStack(alignment: .leading, spacing: 6) { pills }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(holdings.spokenSummary)
    }

    private var pills: some View {
        ForEach(AccessCapability.allCases, id: \.self) { capability in
            let held = holdings.holds(capability)
            let color = held ? Self.color(capability) : AccessUI.muted
            Text(capability.label.uppercased())
                .kerning(0.4)
                .accessText(.capability, color: color)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 7)
                .frame(minHeight: 20)
                .background(held ? color.opacity(0.10) : Color.clear, in: .rect(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(held ? color.opacity(0.45) : AccessUI.muted.opacity(0.6)) }
        }
    }

    private static func color(_ capability: AccessCapability) -> Color {
        switch capability {
        case .answer: Theme.success
        case .direct: Theme.danger
        case .notes: Theme.accent
        }
    }
}

/// One item of a filter: its kind as a caption, its name, and how many records match it.
/// An item a change adds or removes carries a pill after its name; a row without a count yet shows a spinner.
struct AccessFilterItemRow<Trailing: View>: View {
    let kind: String
    let label: String
    /// A line under the name, for an item whose name could not be loaded.
    var note: String?
    var count: Int?
    var counting = false
    var status: String?
    var change: ScopeRefChange = .kept
    var last = false
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        AccessRow(last: last) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(kind).accessText(.caption, color: AccessUI.secondary).fontWeight(.regular)
                    HStack(spacing: 8) {
                        Text(label)
                            .accessText(.rowTitle, color: change == .removed ? AccessUI.secondary : Theme.textPrimary)
                            .fontWeight(.regular)
                            .strikethrough(change == .removed)
                        if change == .added { AccessPill(text: "Added", tone: .success) }
                        if change == .removed { AccessPill(text: "Removed", tone: .danger) }
                    }
                    if let note { Text(note).accessText(.rowSecondary, color: AccessUI.secondary) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let status {
                    Text(status).accessText(.rowSecondary, color: AccessUI.secondary)
                } else {
                    AccessMatchCount(count: count, counting: counting)
                }
                trailing()
            }
        }
    }
}

extension AccessFilterItemRow {
    /// A saved item as every list of a filter's items names it: its kind, the best name known for it, and a note
    /// when nothing names it. `named` is what a list or a count has said about the item.
    init(
        ref: ScopeRef,
        named: ScopePreview.Item?,
        scopes: SourceScopes?,
        count: Int?,
        counting: Bool = false,
        status: String? = nil,
        change: ScopeRefChange = .kept,
        last: Bool,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) {
        self.init(
            kind: accessScopeKindName(ref, scopes: scopes, depth: named?.depth),
            label: scopeDisplayLabel(ref, previewItem: named, scopes: scopes),
            note: scopeNameUnavailable(ref, previewItem: named) ? scopeNameUnavailableNote : nil,
            count: count,
            counting: counting,
            status: status,
            change: change,
            last: last,
            trailing: trailing
        )
    }
}

extension AccessFilterItemRow where Trailing == EmptyView {
    init(ref: ScopeRef, named: ScopePreview.Item?, scopes: SourceScopes?, count: Int?, change: ScopeRefChange, last: Bool) {
        self.init(ref: ref, named: named, scopes: scopes, count: count, change: change, last: last) { EmptyView() }
    }

    init(
        kind: String,
        label: String,
        note: String? = nil,
        count: Int? = nil,
        counting: Bool = false,
        change: ScopeRefChange = .kept,
        last: Bool = false
    ) {
        self.init(kind: kind, label: label, note: note, count: count, counting: counting, status: nil, change: change, last: last) {
            EmptyView()
        }
    }
}

/// The small spinner shown where a count is on its way.
struct AccessCountingSpinner: View {
    var body: some View {
        ProgressView().controlSize(.small).tint(AccessUI.secondary).frame(width: 16, height: 16)
    }
}

/// How many records an item matches, or a spinner while the gateway is still counting them.
struct AccessMatchCount: View {
    let count: Int?
    var counting = false

    var body: some View {
        if let count {
            Text("\(count) matching").accessText(.rowSecondary, color: AccessUI.secondary).monospacedDigit()
        } else if counting {
            AccessCountingSpinner()
        }
    }
}

/// The connections and integrations that use an access level, one name per line.
struct AccessLevelUsageNames: View {
    let usage: AccessLevelUsage

    var body: some View {
        ForEach(Array(usage.connections.enumerated()), id: \.offset) { _, name in Text(name).accessText(.subtitle) }
        ForEach(Array(usage.integrations.enumerated()), id: \.offset) { _, name in
            HStack(spacing: 8) {
                Text(name).accessText(.subtitle)
                AccessPill(text: "Integration")
            }
        }
    }
}

/// How much a filter leaves shared and how much it hides, as two equal tiles.
struct AccessStatPair: View {
    let shared: Int
    let hidden: Int

    var body: some View {
        HStack(spacing: 12) {
            tile(shared, "shared")
            tile(hidden, "hidden")
        }
    }

    private func tile(_ value: Int, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value.formatted()).accessText(.stat).monospacedDigit()
            Text(label).accessText(.statLabel, color: AccessUI.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(AccessUI.cardPadding)
        .background(AccessUI.surface, in: .rect(cornerRadius: AccessUI.cardRadius))
        .accessibilityElement(children: .combine)
    }
}

/// The decisions a review leaves as they were: label and value rows in the muted colour, with nothing to act on.
struct AccessUnchangedBlock: View {
    let rows: [AccessDecisionLine]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(rows) { row in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(row.title).accessText(.rowSecondary, color: AccessUI.muted).frame(width: 116, alignment: .leading)
                    VStack(alignment: .leading, spacing: 6) {
                        if !row.value.isEmpty {
                            Text(row.value).accessText(.rowSecondary, color: AccessUI.muted).fixedSize(horizontal: false, vertical: true)
                        }
                        if let holdings = row.holdings { AccessCapabilityPills(holdings: holdings) }
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A notice above a screen's caption, with the action that resolves it inside.
struct AccessBanner: View {
    let message: String
    var action: String?
    var perform: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(message).accessText(.rowSecondary).fixedSize(horizontal: false, vertical: true)
            if let action {
                Button(action: perform) { Text(action).accessText(.label, color: Theme.accent).frame(minHeight: 28) }.buttonStyle(.plain)
            }
        }
        .padding(AccessUI.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.danger.opacity(0.12), in: .rect(cornerRadius: AccessUI.cardRadius))
        .padding(.bottom, AccessUI.headerGap)
    }
}

/// A dialog centred over its screen, with text buttons under its message.
struct AccessDialog: View {
    struct Action {
        let title: String
        var destructive = false
        let perform: () -> Void
    }

    let title: String
    let message: String
    let actions: [Action]

    var body: some View {
        ZStack {
            Color.black.opacity(0.4).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 12) {
                Text(title).accessText(.dialogTitle).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                Text(message).accessText(.subtitle, color: AccessUI.secondary).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 28) {
                    Spacer(minLength: 0)
                    ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                        Button(action: action.perform) {
                            Text(action.title)
                                .accessText(.button, color: action.destructive ? Theme.danger : Theme.accent)
                                .frame(minHeight: 44)
                                .contentShape(.rect)
                        }.buttonStyle(.plain)
                    }
                }
                .padding(.top, 8)
            }
            .padding([.top, .horizontal], 24)
            .padding(.bottom, 12)
            .frame(maxWidth: 320)
            .background(AccessUI.surface, in: .rect(cornerRadius: 20))
            .padding(.horizontal, 32)
            .accessibilityAddTraits(.isModal)
        }
    }
}

/// The menu a bar's "more" button opens, under that button.
struct AccessMenu: View {
    struct Item: Identifiable {
        let title: String
        let symbol: String
        let perform: () -> Void
        var id: String {
            title
        }
    }

    let items: [Item]
    let dismiss: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.opacity(0.001).ignoresSafeArea().onTapGesture(perform: dismiss).accessibilityHidden(true)
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    Button {
                        dismiss()
                        item.perform()
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: item.symbol)
                                .font(.system(size: 17))
                                .foregroundStyle(Theme.textPrimary)
                                .frame(width: 24)
                                .accessibilityHidden(true)
                            Text(item.title).accessText(.barAction)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 16)
                        .frame(minHeight: 48)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    if index < items.count - 1 { AccessDivider() }
                }
            }
            .frame(width: 250)
            .background(AccessUI.surface, in: .rect(cornerRadius: AccessUI.cardRadius))
            .overlay { RoundedRectangle(cornerRadius: AccessUI.cardRadius).strokeBorder(AccessUI.divider) }
            .shadow(color: .black.opacity(0.3), radius: 24, y: 8)
            .padding(.top, AccessUI.barHeight - 4)
            .padding(.trailing, AccessUI.inset - 8)
        }
    }
}

#if DEBUG
#Preview("Controls") {
    ScrollView {
        VStack(alignment: .leading, spacing: AccessUI.cardGap) {
            AccessOptionCard(
                title: "Answer",
                detail: "Ask questions to the Omnesis agent using allowed sources.",
                selected: true,
                control: .checkbox
            )
            AccessOptionCard(
                title: "Direct",
                detail: "Search and read raw matching records from allowed sources.",
                warning: "Direct is not protected by a privacy policy.",
                selected: true,
                control: .checkbox
            )
            AccessOptionCard(title: "Keep new sources blocked", detail: "I will allow each new source.", selected: false)
            HStack {
                AccessPill(text: "All content")
                AccessPill(text: "Only 1 selected match", tone: .accent)
                AccessPill(text: "Not shared", tone: .outlined)
            }
            AccessKindTabs(tabs: [.init(id: "a", title: "Conversations"), .init(id: "b", title: "People")], selection: .constant("b"))
            AccessBeforeAfter(before: "83 shared · 37 hidden", after: "98 shared · 22 hidden")
            AccessFilterItemRow(kind: "Conversation", label: "Workshop planning", count: 24, change: .removed)
            AccessFilterItemRow(kind: "Person", label: "Jamie Lopez", counting: true, change: .added, last: true)
            AccessStatPair(shared: 83, hidden: 37)
            AccessCapabilityPills(holdings: .init(answer: true, direct: true))
            AccessUnchangedBlock(rows: [.init(title: "Permissions", value: "", holdings: .init(answer: true, direct: true))])
            AccessBanner(message: "This access level changed elsewhere.", action: "Reload latest and discard draft")
        }
        .padding(AccessUI.inset)
    }
    .background(Theme.bgPrimary)
    .overlay { AccessMenu(items: [.init(title: "New access level", symbol: "plus") {}], dismiss: {}) }
}

#Preview("Dialog") {
    Theme.bgPrimary.ignoresSafeArea().overlay {
        AccessDialog(title: "Delete “Notes capture”?", message: "This cannot be undone.", actions: [
            .init(title: "Cancel") {}, .init(title: "Delete", destructive: true) {},
        ])
    }
}
#endif
#endif
