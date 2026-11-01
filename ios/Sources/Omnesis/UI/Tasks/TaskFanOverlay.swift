// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Drives one task's action fan on screen: it opens a `TaskFanSession` where
/// a row was pressed, feeds it the finger, wakes it when a resting finger has
/// dwelt on a navigation target, and hands the chosen action back. The rules
/// themselves — layout, hit-testing, dwell, release — live in the session.
@available(iOS 17.0, *)
@MainActor
@Observable
final class TaskFanController {
    private(set) var session: TaskFanSession?
    private(set) var task: TaskRecord?
    /// The fanned row, kept lit while the rest of the list dims.
    var rowFrame: CGRect? {
        task.flatMap { rowFrames[$0.id] }
    }

    /// Bumped on each change of target, for the selection haptic.
    private(set) var selectionTicks = 0
    /// Bumped each time a fan opens, for the opening haptic.
    private(set) var openings = 0

    /// Where targets may go: the visible list, in `TaskFanOverlay.space`.
    @ObservationIgnored var bounds: CGRect = .zero
    /// Every row's frame in `TaskFanOverlay.space`, by task id: what a press
    /// lands on, and the row to keep lit.
    var rowFrames: [String: CGRect] = [:]
    @ObservationIgnored var metrics = TaskFanSession.Metrics()
    /// Whether a task's fan offers Chat about this.
    @ObservationIgnored var offersChat = false
    @ObservationIgnored var offersTell = false
    /// Runs a chosen action on its task.
    @ObservationIgnored var perform: (TaskFanAction, TaskRecord) -> Void = { _, _ in }
    @ObservationIgnored private var dwellTask: Task<Void, Never>?

    var isOpen: Bool {
        session != nil
    }

    /// The task whose row is under `point`, if its fan can open there: an
    /// open task, or a suggestion, whose fan offers to take it on.
    func pressedTask(at point: CGPoint, in tasks: [TaskRecord]) -> TaskRecord? {
        tasks.first { task in
            !task.isResolved && (rowFrames[task.id]?.contains(point) ?? false)
        }
    }

    /// Opens the fan for `task` at `point`, where the finger pressed.
    /// `tracking` is false when no finger drives it (VoiceOver): it opens
    /// ready for taps.
    func open(
        _ task: TaskRecord,
        at point: CGPoint,
        today: String,
        mode: TaskFanSession.Mode = .main,
        tracking: Bool = true
    ) {
        guard bounds.width > 0 else { return }
        withAnimation(.spring(duration: 0.22, bounce: 0.15)) {
            session = TaskFanSession(
                anchor: point,
                bounds: bounds,
                today: today,
                kind: task.isSuggestion ? .suggestion : .task,
                offersChat: offersChat,
                offersTell: offersTell,
                metrics: metrics,
                mode: mode,
                tracking: tracking
            )
            self.task = task
        }
        openings &+= 1
    }

    /// Opens the fan without a finger, for VoiceOver: anchored where a right
    /// thumb would press the row, ready for taps.
    func openForAccessibility(_ task: TaskRecord, today: String, mode: TaskFanSession.Mode) {
        guard let row = rowFrames[task.id] else { return }
        open(task, at: CGPoint(x: row.maxX - 48, y: row.midY), today: today, mode: mode, tracking: false)
    }

    func move(_ point: CGPoint) {
        guard var session, session.tracking else { return }
        let events = session.move(to: point, at: Date())
        apply(session, events)
    }

    /// The finger lifted at `point`, or the system took the touch away
    /// (nil, which never acts). A fan a finger drove always closes here, in
    /// one change to `session`: the view never sees a released-but-open fan.
    func end(_ point: CGPoint?) {
        guard var session, session.touchDriven else { return }
        let outcome: TaskFanSession.Outcome = point.map { session.release(at: $0, at: Date()) } ?? .dismiss
        let task = task
        dismiss()
        if case .perform(let action) = outcome, let task { perform(action, task) }
    }

    func tap(_ action: TaskFanAction) {
        guard var session else { return }
        let outcome = session.tap(action)
        withAnimation(.spring(duration: 0.22, bounce: 0.15)) { apply(session, [.modeChanged(session.mode)]) }
        finish(outcome)
    }

    func dismiss() {
        dwellTask?.cancel()
        withAnimation(.easeOut(duration: 0.15)) {
            session = nil
            task = nil
        }
    }

    // MARK: - Internals

    private func apply(_ updated: TaskFanSession, _ events: [TaskFanSession.Event]) {
        if events.contains(where: { if case .modeChanged = $0 { true } else { false } }) {
            withAnimation(.spring(duration: 0.22, bounce: 0.15)) { session = updated }
        } else {
            session = updated
        }
        if !events.isEmpty { selectionTicks &+= 1 }
        scheduleDwell()
    }

    /// A resting finger sends no movement, so the dwell is a timer.
    private func scheduleDwell() {
        dwellTask?.cancel()
        guard let deadline = session?.dwellDeadline else { return }
        dwellTask = Task { [weak self] in
            let wait = max(0, deadline.timeIntervalSinceNow)
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000) + 10_000_000)
            guard !Task.isCancelled, let self, var session = self.session else { return }
            let events = session.tick(at: Date())
            self.apply(session, events)
        }
    }

    private func finish(_ outcome: TaskFanSession.Outcome) {
        switch outcome {
        case .stayOpen:
            break
        case .dismiss:
            dismiss()
        case .perform(let action):
            let task = task
            dismiss()
            if let task { perform(action, task) }
        }
    }

    #if DEBUG
    /// Opens the fan as if the finger had pressed `task`'s row at a fraction
    /// of its width, a little below its top, and slid onto `action` —
    /// previews and snapshots.
    func previewOpen(
        _ task: TaskRecord,
        pressedAt fraction: CGFloat,
        today: String,
        mode: TaskFanSession.Mode,
        highlighting action: TaskFanAction?
    ) {
        guard let row = rowFrames[task.id] else { return }
        open(task, at: CGPoint(x: row.minX + row.width * fraction, y: row.minY + 24), today: today, mode: mode)
        if let action, let target = session?.targets.first(where: { $0.action == action }) {
            move(target.center)
        }
    }
    #endif
}

/// The fan itself, drawn over the list: the list dims except the pressed
/// row, the targets stand in a column up and to the left of the finger, and
/// a dashed ring marks where it pressed — lifting there, or anywhere off a
/// target, closes the fan with nothing changed, which reads nothing like the
/// struck-through "Cancel task".
@available(iOS 17.0, *)
struct TaskFanOverlay: View {
    /// The coordinate space rows report their frames in, presses are read in,
    /// and the fan is laid out in.
    static let space = "tasks.fan"

    let controller: TaskFanController

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let session = controller.session {
                dimming
                ring(session)
                ForEach(session.targets) { target in
                    TaskFanTargetButton(
                        target: target,
                        highlighted: session.highlighted == target.action
                    ) { controller.tap(target.action) }
                        .frame(width: target.frame.width, height: target.frame.height)
                        .position(target.center)
                        .transition(
                            .scale(scale: 0.85, anchor: session.upwards ? .bottomTrailing : .topTrailing)
                                .combined(with: .opacity)
                        )
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .sensoryFeedback(.selection, trigger: controller.selectionTicks)
        .sensoryFeedback(.impact(weight: .medium), trigger: controller.openings)
    }

    /// Everything but the fanned row, dimmed; a tap here closes the fan.
    private var dimming: some View {
        GeometryReader { geometry in
            Path { path in
                path.addRect(CGRect(origin: .zero, size: geometry.size))
                if let row = controller.rowFrame { path.addRect(row) }
            }
            .fill(Color.black.opacity(0.55), style: FillStyle(eoFill: true))
            .contentShape(Rectangle())
            .onTapGesture { controller.dismiss() }
        }
        // Rows scroll on under the home indicator; they dim with the rest.
        .ignoresSafeArea(edges: .bottom)
        .transition(.opacity)
        .accessibilityElement()
        .accessibilityLabel("Close actions")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { controller.dismiss() }
    }

    private func ring(_ session: TaskFanSession) -> some View {
        let abandoning = session.tracking && session.highlighted == nil
        return ZStack {
            Circle()
                .stroke(Theme.textSecondary, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            if abandoning {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Theme.textSecondary)
            }
        }
        .frame(width: session.metrics.originRadius * 1.6, height: session.metrics.originRadius * 1.6)
        .position(session.anchor)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// One labelled target, highlighted under the finger. A button, so VoiceOver
/// can tap it in a fan it opened.
@available(iOS 17.0, *)
private struct TaskFanTargetButton: View {
    let target: TaskFanTarget
    let highlighted: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .frame(width: 20)
                    .accessibilityHidden(true)
                Text(target.label)
                    .font(.subheadline.weight(.semibold))
                    .strikethrough(target.action == .cancelTask)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 0)
                if target.action == .otherMonth || target.action == .acceptFor {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(highlighted ? Color.white : foreground)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Capsule().fill(highlighted ? Theme.accent : Theme.bgTertiary))
            .overlay(Capsule().stroke(highlighted ? Color.clear : Theme.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.3), radius: 8, y: 3)
            .scaleEffect(highlighted ? 1.04 : 1)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }

    private var foreground: Color {
        target.action == .cancelTask ? Theme.danger : Theme.textPrimary
    }

    private var accessibilityLabel: String {
        switch target.action {
        case .month: "Move to \(target.label)"
        case .otherMonth: "Other month"
        case .acceptFor: "Accept for"
        default: target.label
        }
    }

    private var icon: String {
        switch target.action {
        case .done: "checkmark"
        case .doneWithNote, .acceptWithNote: "square.and.pencil"
        case .today: "sun.min"
        case .tomorrow: "sun.max"
        case .thisMonth, .nextMonth: "calendar"
        case .someday: "tray"
        case .otherMonth, .acceptFor: "calendar.badge.clock"
        case .cancelTask: "xmark"
        case .tell: "mic"
        case .chat: "bubble.left.and.bubble.right"
        case .accept: "plus.circle"
        case .ignore: "eye.slash"
        case .month: "calendar"
        case .back: "chevron.backward"
        case .laterMonths: "chevron.down"
        case .earlierMonths: "chevron.up"
        }
    }
}

#endif
