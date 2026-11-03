// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// One task as a bullet-journal line: the bullet, the title, a line of
/// context, and — when Omnesis has an opinion — a proposal to confirm or keep.
/// The documents the task refers to are listed under it, each opening the
/// document.
///
/// A tap on the circle completes the task (or reopens a resolved one), and a
/// tap on the text opens its details. A long press anywhere on an open task
/// opens its action fan (`TaskFanOverlay`); the screen reads that press over
/// the whole list (`TaskRowPressBridge`), so the row itself carries only the
/// fan's VoiceOver actions.
///
/// A suggestion from Omnesis is the same line with a dashed circle: the
/// circle marks it already done, and its fan offers to accept it — as it stands,
/// with a note, or for a time — or to ignore it.
///
/// Proposals and suggestions come from the Brain, which runs only on an
/// experimental gateway; `showsBrainProposals` carries that mode, and
/// without it the row shows no proposal.
@available(iOS 17.0, *)
struct TaskRowView: View {
    let task: TaskRecord
    let view: TaskViewKind
    let today: String
    var busy = false
    var showsBrainProposals = false
    /// This row's fan is open: the row stays lit above the dimmed list.
    var fanOpen = false
    /// Opens the details.
    var onOpen: () -> Void = {}
    var onBullet: () -> Void = {}
    var onAction: (TaskAction) -> Void = { _ in }
    var onDocument: (TaskDocument) -> Void = { _ in }
    /// Runs a fan action directly — VoiceOver's custom actions.
    var onFanAction: (TaskFanAction) -> Void = { _ in }
    /// Whether the fan offers Chat about this, so VoiceOver does too.
    var offersChat = false
    var offersTell = false

    /// Whether a long press opens the action fan: any open task, a
    /// suggestion included. A resolved task is reopened instead.
    private var hasFan: Bool {
        !task.isResolved
    }

    /// Where the title starts: the side inset plus the bullet's column.
    static let textInset: CGFloat = Theme.Spacing.lg + bulletColumn + Theme.Spacing.sm
    static let bulletColumn: CGFloat = 28

    /// The bullet column, grown with the text size alongside the bullet.
    @ScaledMetric(relativeTo: .body) private var bulletWidth: CGFloat = TaskRowView.bulletColumn

    private var schedule: TaskSchedule {
        TaskSchedule()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                TaskBullet(task: task, busy: busy, action: onBullet)
                    .frame(width: bulletWidth)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
                headline
            }
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                TaskDocumentsList(task: task, onOpen: onDocument)
                if showsBrainProposals, let change = task.proposedChange, !task.isResolved {
                    TaskProposalView(
                        change: change,
                        today: today,
                        busy: busy,
                        onConfirm: { onAction(.confirm) },
                        onKeep: { onAction(.keep) }
                    )
                }
            }
            .padding(.leading, bulletWidth + Theme.Spacing.sm)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md)
        .background(fanOpen ? Theme.bgSecondary : Color.clear)
    }

    /// The title and its context line: the tap target that opens the details.
    /// VoiceOver reaches every fan action from here as a custom action.
    private var headline: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(task.title)
                .font(.body)
                .foregroundStyle(task.isResolved ? Theme.textMuted : Theme.textPrimary)
                .strikethrough(task.isResolved, color: Theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            if !task.description.isEmpty {
                Text(task.description)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(3)
                    .truncationMode(.tail)
            }
            if !metaItems.isEmpty {
                TaskMetaLine(items: metaItems)
            }
            if let note = task.completionNote, !note.isEmpty {
                Text(note)
                    .font(.footnote.italic())
                    .foregroundStyle(Theme.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .modifier(ResolvedTaskMenu(resolved: task.isResolved && offersTell, tell: { onFanAction(.tell) }, reopen: onBullet))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(accessibilityState)
        .accessibilityHint("Opens details")
        .accessibilityActions {
            if task.isSuggestion {
                Button("Accept") { onFanAction(.accept) }
                Button("Accept with note") { onFanAction(.acceptWithNote) }
                Button("Accept for…") { onFanAction(.acceptFor) }
                Button("Mark as done") { onFanAction(.done) }
                Button("Ignore") { onFanAction(.ignore) }
                if offersTell { Button("Tell Omnesis") { onFanAction(.tell) } }
            } else if hasFan {
                Button("Done") { onFanAction(.done) }
                Button("Done with note") { onFanAction(.doneWithNote) }
                if offersTell { Button("Tell Omnesis") { onFanAction(.tell) } }
                Button("Tomorrow") { onFanAction(.tomorrow) }
                Button("Next month") { onFanAction(.nextMonth) }
                Button("Move to month…") { onFanAction(.otherMonth) }
                Button("Cancel task") { onFanAction(.cancelTask) }
                if offersChat {
                    Button("Chat about this") { onFanAction(.chat) }
                }
            } else if task.isResolved {
                Button("Reopen", action: onBullet)
                if offersTell { Button("Tell Omnesis") { onFanAction(.tell) } }
            }
        }
    }

    private var accessibilityState: String {
        switch task.state {
        case .done: "Done"
        case .dismissed: "Struck"
        default: task.isSuggestion ? "Suggested" : ""
        }
    }

    private var metaItems: [TaskMetaLine.Item] {
        var items: [TaskMetaLine.Item] = []
        if task.carried, !task.isResolved {
            let from = schedule.scheduleLabel(task.scheduledFor, today: today)
            items.append(.init(
                icon: "arrow.uturn.forward",
                text: from.map { "Carried from \($0.lowercasedIfRelative)" } ?? "Carried",
                tone: .warning
            ))
        } else if view != .today || !task.isResolved,
                  let planned = schedule.scheduleLabel(task.scheduledFor, today: today),
                  // On Today, "Today" is the page itself.
                  !(view == .today && planned == "Today") {
            items.append(.init(icon: "calendar", text: planned, tone: .neutral))
        }
        if let due = schedule.deadlineLabel(task.deadline, dueDay: task.dueDay, today: today), !task.isResolved {
            let overdue = schedule.isOverdue(dueDay: task.dueDay, today: today)
            items.append(.init(icon: "flag", text: due, tone: overdue ? .danger : .neutral))
        }
        let people = TaskJournal.people(task)
        if !people.isEmpty {
            items.append(.init(icon: "person", text: people.joined(separator: ", "), tone: .neutral))
        }
        if let blocker = task.blockedBy.first {
            items.append(.init(icon: "hourglass", text: "Waiting on \(blocker.title)", tone: .neutral))
        }
        if task.isResolved, let resolved = resolvedLabel {
            items.append(.init(icon: nil, text: resolved, tone: .neutral))
        }
        if task.origin == .note, !task.isResolved {
            items.append(.init(icon: "mic", text: "From a note", tone: .neutral))
        }
        return items
    }

    /// "Done Tue 13 Oct" on the Done view, where the day matters.
    private var resolvedLabel: String? {
        guard view == .done, let resolvedAt = task.resolvedAt,
              let date = ISO8601DateFormatter.tasksFractional.date(from: resolvedAt)
              ?? ISO8601DateFormatter().date(from: resolvedAt),
              let day = schedule.dayLabel(schedule.day(date), today: today)
        else { return nil }
        return "\(task.state == .dismissed ? "Struck" : "Done") \(day.lowercasedIfRelative)"
    }
}

extension String {
    /// "Today" reads as "today" mid-sentence; a date stays as written.
    fileprivate var lowercasedIfRelative: String {
        ["Today", "Tomorrow", "Yesterday"].contains(self) ? lowercased() : self
    }
}

extension ISO8601DateFormatter {
    /// The gateway's `toISOString()` shape, with fractional seconds.
    static let tasksFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

// MARK: - Bullet

/// The tap target that completes a task, or reopens a resolved one. On a
/// suggestion it marks the suggestion already done; its dashed circle says
/// the task is not yet the person's own.
@available(iOS 17.0, *)
private struct TaskBullet: View {
    let task: TaskRecord
    let busy: Bool
    let action: () -> Void

    /// The bullet grows with the title's text size so it stays a visible
    /// target beside large type.
    @ScaledMetric(relativeTo: .body) private var glyphSize: CGFloat = 21
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 28

    var body: some View {
        Button(action: action) {
            glyph
                .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .frame(width: Theme.tapTarget, height: rowHeight)
        .accessibilityLabel(task.isResolved ? "Reopen \(task.title)" : "Complete \(task.title)")
        .accessibilityHint(task.isSuggestion ? "Marks the suggestion as already done" : "")
    }

    @ViewBuilder
    private var glyph: some View {
        switch task.state {
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: glyphSize))
                .foregroundStyle(Theme.success)
        case .dismissed:
            Image(systemName: "minus.circle")
                .font(.system(size: glyphSize))
                .foregroundStyle(Theme.textMuted)
        default:
            Image(systemName: task.isSuggestion ? "circle.dashed" : "circle")
                .font(.system(size: glyphSize, weight: .light))
                .foregroundStyle(task.isSuggestion ? Theme.accent : task.carried ? Theme.warning : Theme.textSecondary)
        }
    }
}

// MARK: - Meta line

/// The context under a title: plan, deadline, people, where it came from.
/// Wraps onto further lines rather than truncating.
@available(iOS 17.0, *)
private struct TaskMetaLine: View {
    enum Tone { case neutral, warning, danger }

    struct Item: Hashable {
        let icon: String?
        let text: String
        let tone: Tone
    }

    let items: [Item]

    var body: some View {
        TaskFlowLayout(spacing: 10, lineSpacing: 2) {
            ForEach(items, id: \.self) { item in
                HStack(spacing: 3) {
                    if let icon = item.icon {
                        Image(systemName: icon)
                            .imageScale(.small)
                            .accessibilityHidden(true)
                    }
                    Text(item.text)
                }
                .font(.footnote)
                .foregroundStyle(color(item.tone))
            }
        }
    }

    private func color(_ tone: Tone) -> Color {
        switch tone {
        case .neutral: Theme.textSecondary
        case .warning: Theme.warning
        case .danger: Theme.danger
        }
    }
}

/// Lays its children out left to right, wrapping to a new line when the next
/// one would overflow.
@available(iOS 17.0, *)
struct TaskFlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.init(width: width, height: nil))
            if x > 0, x + size.width > width {
                y += lineHeight + lineSpacing
                x = 0
                lineHeight = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: min(widest, width), height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var lineHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.init(width: bounds.width, height: nil))
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += lineHeight + lineSpacing
                x = bounds.minX
                lineHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: .init(width: min(size.width, bounds.width), height: nil))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

// MARK: - Proposal

/// A change Omnesis proposes. The task keeps its values until Confirm.
@available(iOS 17.0, *)
private struct TaskProposalView: View {
    let change: TaskProposedChange
    let today: String
    let busy: Bool
    let onConfirm: () -> Void
    let onKeep: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "sparkles")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.accent)
                    .accessibilityHidden(true)
                (
                    Text(TaskJournal.proposalHeadline(change)).fontWeight(.semibold)
                        + Text(change.reason.isEmpty ? "" : ": \(change.reason)")
                )
                .font(.footnote)
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            }
            if change.kind == .edit,
               let fields = TaskJournal.proposalFields(change.fields, schedule: TaskSchedule(), today: today) {
                Text(fields)
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
            }
            // Side by side when they fit, stacked at large text sizes.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Theme.Spacing.sm) { buttons }
                VStack(alignment: .leading, spacing: 0) { buttons }
            }
            .disabled(busy)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.large).fill(Theme.accent.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large).stroke(Theme.accent.opacity(0.25), lineWidth: 1)
        )
        .padding(.top, Theme.Spacing.xs)
    }

    @ViewBuilder
    private var buttons: some View {
        Button("Confirm", action: onConfirm)
            .buttonStyle(TaskPillButtonStyle(prominent: true))
            .fixedSize()
        Button("Keep", action: onKeep)
            .buttonStyle(TaskPillButtonStyle(prominent: false))
            .fixedSize()
            .accessibilityLabel("Keep as it is")
    }
}

/// The Tasks screen's compact capsule button: accent-filled when prominent,
/// a quiet outline otherwise. Keeps a 44pt touch height at every text size.
@available(iOS 17.0, *)
struct TaskPillButtonStyle: ButtonStyle {
    let prominent: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .labelStyle(.titleAndIcon)
            .lineLimit(1)
            .foregroundStyle(prominent ? Color.white : Theme.textPrimary)
            .padding(.horizontal, 14)
            .frame(minHeight: 36)
            .background(
                Capsule().fill(prominent ? Theme.accent : Theme.bgPrimary)
            )
            .overlay(Capsule().stroke(prominent ? Color.clear : Theme.border, lineWidth: 1))
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.45)
            .contentShape(Capsule())
            .padding(.vertical, 4)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("TaskRowView — states") {
    ScrollView {
        VStack(spacing: 0) {
            TaskRowView(task: PreviewMocks.taskCarried, view: .today, today: "2026-10-14")
            TaskRowView(
                task: PreviewMocks.taskProposal,
                view: .today,
                today: "2026-10-14",
                showsBrainProposals: true
            )
            TaskRowView(task: PreviewMocks.taskWithPerson, view: .today, today: "2026-10-14", fanOpen: true)
            TaskRowView(task: PreviewMocks.taskWithDescription, view: .today, today: "2026-10-14")
            TaskRowView(task: PreviewMocks.taskDueToday, view: .today, today: "2026-10-14")
            TaskRowView(task: PreviewMocks.taskDoneToday, view: .today, today: "2026-10-14")
            TaskRowView(task: PreviewMocks.taskStruckToday, view: .today, today: "2026-10-14")
            TaskRowView(
                task: PreviewMocks.tasksSuggested[0],
                view: .suggested,
                today: "2026-10-14",
                showsBrainProposals: true
            )
        }
    }
    .background(Theme.bgPrimary)
}
#endif
/// Resolved rows keep their existing tap/bullet behavior and offer a small contextual menu.
@available(iOS 17.0, *)
private struct ResolvedTaskMenu: ViewModifier {
    let resolved: Bool
    let tell: () -> Void
    let reopen: () -> Void

    func body(content: Content) -> some View {
        if resolved {
            content.contextMenu {
                Button("Tell Omnesis", systemImage: "mic", action: tell)
                Button("Reopen", systemImage: "arrow.uturn.backward", action: reopen)
            }
        } else {
            content
        }
    }
}

#endif
