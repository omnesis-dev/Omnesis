// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The Resync sheet of a source: how to resync — in place or from scratch —
/// with what each does in plain words. In place is selected on opening, so
/// confirming without choosing anything deletes nothing; the confirm button
/// turns red only while from scratch is selected. Android draws the same
/// sheet and the portal the same dialog, in the same words.
@available(iOS 17.0, *)
struct SourceResyncSheet: View {
    @Environment(\.dismiss) private var dismiss

    let sourceName: String
    let modes: [SourceResyncMode]
    let brainNote: Bool
    let onConfirm: (SourceResyncMode) -> Void

    @State private var mode: SourceResyncMode
    @State private var contentHeight: CGFloat = 420

    /// `initialMode` opens the sheet on a mode other than the default one;
    /// previews and snapshots use it to show each selection.
    init(
        sourceName: String,
        modes: [SourceResyncMode],
        brainNote: Bool,
        initialMode: SourceResyncMode? = nil,
        onConfirm: @escaping (SourceResyncMode) -> Void
    ) {
        self.sourceName = sourceName
        self.modes = modes
        self.brainNote = brainNote
        self.onConfirm = onConfirm
        let opening = initialMode ?? SourceResyncOffer.choice(modes).defaultMode ?? .inPlace
        _mode = State(initialValue: opening)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text(SourceResyncCopy.title(sourceName: sourceName))
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                options
                if let footnote = SourceResyncCopy.footnote(modes: modes) {
                    Text(footnote)
                        .font(.footnote)
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                actions
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.top, Theme.Spacing.xl)
            .padding(.bottom, Theme.Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(GeometryReader { proxy in
                Color.clear.preference(key: SourceResyncHeightKey.self, value: proxy.size.height)
            })
        }
        .scrollBounceBehavior(.basedOnSize)
        .onPreferenceChange(SourceResyncHeightKey.self) { contentHeight = $0 }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .omnesisColorScheme()
        .presentationDetents([.height(contentHeight), .large])
        .presentationDragIndicator(.visible)
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(modes.enumerated()), id: \.element) { index, candidate in
                if index > 0 {
                    Divider().background(Theme.borderLight)
                }
                optionRow(SourceResyncCopy.option(candidate, sourceName: sourceName, brainNote: brainNote))
            }
        }
    }

    private func optionRow(_ option: SourceResyncOption) -> some View {
        let selected = option.mode == mode
        return Button {
            mode = option.mode
        } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(selected ? Theme.accent : Theme.textSecondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(option.title)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                    Text(option.body)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textSecondary)
                    if let note = option.note {
                        Text(note)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.warning)
                    }
                }
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.vertical, Theme.Spacing.md)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private var actions: some View {
        HStack(spacing: Theme.Spacing.lg) {
            Spacer()
            Button(SourceResyncCopy.cancel) { dismiss() }
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.accent)
                .frame(minHeight: Theme.tapTarget)
            Button {
                onConfirm(mode)
                dismiss()
            } label: {
                // The label takes the page background's colour, as Android's
                // filled buttons do: white on the light theme, navy on the dark.
                Text(SourceResyncCopy.confirm(mode))
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.bgPrimary)
                    .padding(.horizontal, Theme.Spacing.xl)
                    .frame(minHeight: 40)
                    .background(mode == .fromScratch ? Theme.danger : Theme.accent, in: Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(.top, Theme.Spacing.xs)
    }
}

@available(iOS 17.0, *)
extension View {
    /// Presents what a source's Resync action asks before it runs: the
    /// two-mode sheet on a gateway that resyncs in modes, or a plain
    /// confirmation of the delete on one that only resyncs from scratch.
    func sourceResyncConfirmation(
        isPresented: Binding<Bool>,
        offer: SourceResyncOffer,
        sourceName: String,
        brainNote: Bool,
        onConfirm: @escaping (SourceResyncMode) -> Void
    )
        -> some View {
        modifier(SourceResyncConfirmation(
            isPresented: isPresented,
            offer: offer,
            sourceName: sourceName,
            brainNote: brainNote,
            onConfirm: onConfirm
        ))
    }
}

@available(iOS 17.0, *)
private struct SourceResyncConfirmation: ViewModifier {
    @Binding var isPresented: Bool
    let offer: SourceResyncOffer
    let sourceName: String
    let brainNote: Bool
    let onConfirm: (SourceResyncMode) -> Void

    private var modes: [SourceResyncMode]? {
        if case .choice(let modes) = offer { modes } else { nil }
    }

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: Binding(get: { isPresented && modes != nil }, set: { isPresented = $0 })) {
                SourceResyncSheet(sourceName: sourceName, modes: modes ?? [], brainNote: brainNote, onConfirm: onConfirm)
            }
            .alert(
                SourceResyncCopy.wipeOnlyTitle,
                isPresented: Binding(get: { isPresented && offer == .wipeOnly }, set: { isPresented = $0 })
            ) {
                Button("Resync", role: .destructive) { onConfirm(.fromScratch) }
                Button(SourceResyncCopy.cancel, role: .cancel) {}
            } message: {
                Text(SourceResyncCopy.wipeOnlyMessage)
            }
    }
}

private struct SourceResyncHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 420

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Resync — in place selected") {
    SourceResyncSheet(sourceName: "Gmail", modes: SourceResyncMode.allCases, brainNote: false, onConfirm: { _ in })
}

@available(iOS 17.0, *)
#Preview("Resync — from scratch selected") {
    SourceResyncSheet(
        sourceName: "Gmail",
        modes: SourceResyncMode.allCases,
        brainNote: false,
        initialMode: .fromScratch,
        onConfirm: { _ in }
    )
}

@available(iOS 17.0, *)
#Preview("Resync — from scratch, Brain on") {
    SourceResyncSheet(
        sourceName: "Gmail",
        modes: SourceResyncMode.allCases,
        brainNote: true,
        initialMode: .fromScratch,
        onConfirm: { _ in }
    )
}

@available(iOS 17.0, *)
#Preview("Resync — presented over a source") {
    Color.clear.sheet(isPresented: .constant(true)) {
        SourceResyncSheet(sourceName: "Gmail", modes: SourceResyncMode.allCases, brainNote: true, onConfirm: { _ in })
    }
}
#endif
#endif
