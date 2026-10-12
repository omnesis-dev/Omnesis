// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The thin rule and centred day name above each morning brief. An earlier
/// day's separator also folds and opens the day; the latest day's does not.
@available(iOS 17.0, *)
struct DailyBriefDaySeparator: View {
    let day: String
    let label: String
    let spokenLabel: String
    /// Nil for the latest day, which does not fold.
    let isOpen: Bool?
    var onToggle: () -> Void = {}

    var body: some View {
        if let isOpen {
            Button(action: onToggle) {
                row(chevron: isOpen ? "chevron.up" : "chevron.down")
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(spokenLabel)
            .accessibilityValue(isOpen ? "Expanded" : "Collapsed")
            .accessibilityHint(isOpen ? "Folds this day" : "Shows this day")
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("dailyBrief.separator.\(day)")
        } else {
            row(chevron: nil)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(spokenLabel)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("dailyBrief.separator.\(day)")
        }
    }

    private func row(chevron: String?) -> some View {
        HStack(spacing: 10) {
            rule
            HStack(spacing: 4) {
                Text(label)
                if let chevron {
                    Image(systemName: chevron)
                        .font(.caption2.weight(.semibold))
                }
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Theme.textSecondary)
            .fixedSize()
            rule
        }
        .frame(minHeight: 32)
        .padding(.top, 4)
    }

    private var rule: some View {
        Rectangle()
            .fill(Theme.border)
            .frame(height: 1)
            .frame(maxWidth: .infinity)
    }
}

/// An earlier day folded to one line: "Morning brief · 5 things · 2 replies".
@available(iOS 17.0, *)
struct DailyBriefFoldedRow: View {
    let day: String
    let summary: String
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 8) {
                Image(systemName: "sun.max")
                    .foregroundStyle(Theme.warning)
                Text(summary)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 4)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .font(.subheadline)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 10)
            .frame(minHeight: Theme.tapTarget)
            .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: Theme.Radius.large))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.large).stroke(Theme.borderLight))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(summary)
        .accessibilityHint("Shows this day's brief and replies")
        .accessibilityIdentifier("dailyBrief.folded.\(day)")
    }
}

/// The line over a morning brief: a sun, "Morning brief" and the local time
/// it was sent, when known.
@available(iOS 17.0, *)
struct DailyBriefHeader: View {
    let time: String?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "sun.max.fill")
                .foregroundStyle(Theme.warning)
            Text(DailyBriefCopy.title)
                .fontWeight(.semibold)
                .foregroundStyle(Theme.textPrimary)
            if let time {
                Text(time)
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .font(.subheadline)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(time.map { "\(DailyBriefCopy.title), sent at \($0)" } ?? DailyBriefCopy.title)
        .accessibilityIdentifier("dailyBrief.header")
    }
}

/// Under a brief: "Based on N things", which opens to the ranked items it was
/// written from, each with its documents and tasks. Quiet while loading, a
/// Retry line when the read failed, and nothing at all with no items.
@available(iOS 17.0, *)
struct DailyBriefFooter: View {
    let day: String
    let state: DailyBriefModel.ItemsState?
    let isOpen: Bool
    let onToggle: () -> Void
    let onRetry: () -> Void

    @State private var pushedDocument: DailyBriefDocumentPush?

    var body: some View {
        content
            .navigationDestination(item: $pushedDocument) { document in
                DocumentDetailView(documentId: document.id, presetTitle: document.title)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.mini)
                Text("Loading what this brief was based on…")
            }
            .font(.footnote)
            .foregroundStyle(Theme.textMuted)
            .accessibilityElement(children: .combine)
        case .failed:
            HStack(spacing: 4) {
                Text("Couldn't load —")
                    .foregroundStyle(Theme.textMuted)
                Button("Retry", action: onRetry)
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.accent)
                    .buttonStyle(.plain)
                    .frame(minHeight: 32)
                    .accessibilityIdentifier("dailyBrief.retry.\(day)")
            }
            .font(.footnote)
        case .loaded(let page) where !page.items.isEmpty:
            loaded(page.items.sorted { $0.rank < $1.rank })
        default:
            EmptyView()
        }
    }

    private func loaded(_ items: [DailyBriefItem]) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Button(action: onToggle) {
                HStack(spacing: 4) {
                    Text(DailyBriefCopy.basedOn(items.count))
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(isOpen ? 180 : 0))
                }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.accent)
                .frame(minHeight: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(DailyBriefCopy.basedOn(items.count))
            .accessibilityValue(isOpen ? "Expanded" : "Collapsed")
            .accessibilityHint(isOpen ? "Hides the list" : "Lists what this brief was based on")
            .accessibilityIdentifier("dailyBrief.footer.\(day)")
            if isOpen {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    ForEach(items) { item in
                        DailyBriefItemRow(item: item, onOpenDocument: { pushedDocument = $0 })
                    }
                }
                .padding(Theme.Spacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: Theme.Radius.large))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.large).stroke(Theme.borderLight))
            }
        }
    }
}

/// A document to push from a source chip.
@available(iOS 17.0, *)
struct DailyBriefDocumentPush: Hashable, Identifiable {
    let id: String
    let title: String
}

/// One ranked item: its sentence, then a chip for each document and task.
@available(iOS 17.0, *)
private struct DailyBriefItemRow: View {
    let item: DailyBriefItem
    let onOpenDocument: (DailyBriefDocumentPush) -> Void
    @Environment(NotificationRouter.self) private var router: NotificationRouter?
    @Environment(AppStore.self) private var store: AppStore?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(item.rank)")
                .font(.footnote.weight(.semibold).monospacedDigit())
                .foregroundStyle(Theme.textMuted)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text(item.summary)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("\(item.rank). \(item.summary)")
                if !item.sources.isEmpty || !item.tasks.isEmpty {
                    DailyBriefChipFlow(spacing: 6) {
                        ForEach(item.sources) { source in
                            sourceChip(source)
                        }
                        ForEach(item.tasks) { task in
                            taskChip(task)
                        }
                    }
                }
            }
        }
    }

    private func sourceChip(_ source: DailyBriefSource) -> some View {
        let title = source.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled document"
        return Button {
            onOpenDocument(DailyBriefDocumentPush(id: source.id, title: title))
        } label: {
            DailyBriefChip(title: title) {
                if let store {
                    SourceIconView(sourceId: source.sourceType, store: store, size: 13)
                } else {
                    Image(systemName: "doc.text")
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), document")
        .accessibilityHint("Opens the document")
        .accessibilityIdentifier("dailyBrief.source.\(source.id)")
    }

    private func taskChip(_ task: DailyBriefTask) -> some View {
        Button {
            router?.pendingTarget = .task(taskId: task.id)
        } label: {
            DailyBriefChip(title: task.title) {
                Image(systemName: task.isResolved ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(task.isResolved ? Theme.success : Theme.accent)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(task.title), task, \(task.isResolved ? "done" : "open")")
        .accessibilityHint("Opens the task in Tasks")
        .accessibilityIdentifier("dailyBrief.task.\(task.id)")
    }
}

/// Chips left to right, wrapping onto new lines. Each chip is offered the
/// row's width, so a title longer than the row wraps inside its chip (at
/// large text sizes) rather than running off the screen.
@available(iOS 17.0, *)
private struct DailyBriefChipFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let placed = place(subviews, width: width)
        return CGSize(width: width.isFinite ? width : placed.width, height: placed.height)
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        let placed = place(subviews, width: bounds.width)
        for (subview, frame) in zip(subviews, placed.frames) {
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(frame.size)
            )
        }
    }

    private struct Placement {
        var frames: [CGRect]
        var width: CGFloat
        var height: CGFloat
    }

    private func place(_ subviews: Subviews, width: CGFloat) -> Placement {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: width.isFinite ? width : nil, height: nil))
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return Placement(frames: frames, width: widest, height: y + lineHeight)
    }
}

/// A rounded chip: a small icon, then its title, on two lines at most.
@available(iOS 17.0, *)
private struct DailyBriefChip<Icon: View>: View {
    let title: String
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        HStack(spacing: 5) {
            icon()
                .font(.caption)
            Text(title)
                .font(.caption)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(2)
                .truncationMode(.tail)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(Theme.bgPrimary, in: Capsule())
        .overlay(Capsule().stroke(Theme.border))
        .contentShape(Capsule())
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Morning brief parts") {
    VStack(alignment: .leading, spacing: 14) {
        DailyBriefDaySeparator(day: "2026-10-12", label: "Mon 12 Oct", spokenLabel: "Monday 12 October", isOpen: false)
        DailyBriefFoldedRow(day: "2026-10-12", summary: "Morning brief · 2 things · 1 reply", onOpen: {})
        DailyBriefDaySeparator(day: "2026-10-14", label: "Today", spokenLabel: "Today", isOpen: nil)
        DailyBriefHeader(time: "07:02")
        DailyBriefFooter(day: "2026-10-14", state: .loading, isOpen: true, onToggle: {}, onRetry: {})
        DailyBriefFooter(day: "2026-10-14", state: .failed, isOpen: true, onToggle: {}, onRetry: {})
        DailyBriefFooter(
            day: "2026-10-14",
            state: .loaded(PreviewMocks.dailyBriefToday),
            isOpen: true,
            onToggle: {},
            onRetry: {}
        )
    }
    .padding()
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
}
#endif
#endif
