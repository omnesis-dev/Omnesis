// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
import Foundation

/// What a target in a task's action fan does. On a suggestion, a target
/// that names a time (Today, Tomorrow, a month, Someday) accepts it for that
/// time; on one of the person's own tasks it moves the task there.
public enum TaskFanAction: Hashable, Sendable {
    /// Completes the task; on a suggestion, marks it already done.
    case done
    /// Opens a note composer; saving completes the task with the note.
    case doneWithNote
    case today
    case tomorrow
    case thisMonth
    case nextMonth
    case someday
    /// Opens the month fan.
    case otherMonth
    /// Strikes the task: it leaves the lists but keeps its history.
    case cancelTask
    /// Moves the task to a month, `YYYY-MM`.
    case month(String)
    /// Takes on a suggestion as it stands.
    case accept
    /// Opens a note composer; saving accepts the suggestion with the note.
    case acceptWithNote
    /// Opens the fan of times to accept a suggestion for.
    case acceptFor
    /// Takes a suggestion out of the person's tasks; Omnesis keeps tracking it.
    case ignore
    /// Back to the fan this one was opened from.
    case back
    /// The next page of months.
    case laterMonths
    /// The previous page of months.
    case earlierMonths

    /// Whether the target changes what the fan shows rather than the task.
    public var isNavigation: Bool {
        switch self {
        case .otherMonth, .acceptFor, .back, .laterMonths, .earlierMonths: true
        default: false
        }
    }
}

/// One labelled target, placed in the overlay's coordinates.
public struct TaskFanTarget: Equatable, Sendable, Identifiable {
    public let action: TaskFanAction
    public let label: String
    public let frame: CGRect

    public var id: TaskFanAction {
        action
    }

    public var center: CGPoint {
        CGPoint(x: frame.midX, y: frame.midY)
    }
}

/// The action fan a long press on a task's row opens: where its targets go,
/// which one the finger is over, and what lifting the finger does. Pure, so
/// the gesture's rules are covered by the logic lane and the SwiftUI layer
/// only draws and forwards touches.
///
/// The fan is anchored where the finger pressed and laid out for a right
/// thumb: a column of labelled targets up and to the left of the touch, so
/// the thumb, which reaches in from the lower right, never covers a label.
/// The column leans further left as it rises, following the thumb's arc. Its
/// order is fixed and counted outwards from the thumb — Done (Accept, on a
/// suggestion) is always nearest. Near the top of the list the column flips
/// downwards (mirrored, so the order by distance never changes); near the
/// left edge it slides right to stay on screen.
///
/// The fan lives only while the finger is down: slide onto a target and lift
/// to act; lift anywhere else and nothing changes. A suggestion's fan offers
/// to take it on instead (`Kind.suggestion`); resting on its Accept for…
/// opens the times to accept it for. Resting on Other month…
/// opens the month fan in place; its targets wait for a deliberate movement
/// before they can be selected, so the one that appears under the finger is
/// never chosen by accident. VoiceOver, which cannot hold and slide, opens
/// the fan without a finger (`tracking` false) and taps its targets.
public struct TaskFanSession: Sendable {
    public enum Mode: Equatable, Sendable {
        case main
        /// When to accept a suggestion for.
        case when
        case months(page: Int)
    }

    /// What was pressed: one of the person's own tasks, or a suggestion,
    /// whose fan offers to take it on instead.
    public enum Kind: Equatable, Sendable {
        case task
        case suggestion
    }

    public enum Event: Equatable, Sendable {
        /// The finger entered a different target — a haptic tick.
        case selectionChanged(TaskFanAction)
        case modeChanged(Mode)
    }

    public enum Outcome: Equatable, Sendable {
        case perform(TaskFanAction)
        /// The fan stays on screen: a tap followed a navigation target.
        case stayOpen
        /// The fan closes and the task is unchanged.
        case dismiss
    }

    public struct Metrics: Equatable, Sendable {
        public var targetWidth: CGFloat = 176
        public var targetHeight: CGFloat = 44
        public var spacing: CGFloat = 6
        /// From the touch point to the near (trailing) edge of the column.
        public var lead: CGFloat = 26
        /// How far the middle of the column bows out from the touch.
        public var curve: CGFloat = 10
        /// How much further left the far end of the column sits than the
        /// near end — the lean that follows a right thumb's arc.
        public var sweep: CGFloat = 24
        /// Inside this radius of the touch point the finger selects nothing.
        public var originRadius: CGFloat = 26
        public var hitSlop: CGFloat = 3
        public var edgeMargin: CGFloat = 8
        /// How long the finger rests on a navigation target to follow it.
        public var dwell: TimeInterval = 0.45
        /// How far the finger must move after a fan changes under it before
        /// anything can be selected.
        public var armDistance: CGFloat = 22
        public var monthsPerPage = 6

        public init() {}
    }

    /// Where the finger pressed.
    public let anchor: CGPoint
    public let bounds: CGRect
    public let metrics: Metrics
    public let today: String
    public let kind: Kind
    private let schedule: TaskSchedule

    public private(set) var mode: Mode = .main
    public private(set) var targets: [TaskFanTarget] = []
    public private(set) var highlighted: TaskFanAction?
    /// A finger is down and driving the fan.
    public private(set) var tracking: Bool
    /// A finger opened the fan (rather than VoiceOver): lifting it always
    /// closes the fan, whatever state it reached.
    public let touchDriven: Bool
    /// Where the finger was last seen.
    private var lastPoint: CGPoint
    private var hoverSince: Date?
    /// Set when a fan changed under the finger: nothing is selectable until
    /// the finger has moved `armDistance` from here.
    private var armPoint: CGPoint?

    /// - Parameters:
    ///   - anchor: where the finger pressed.
    ///   - bounds: where targets may go — the visible list, inside its safe area.
    ///   - today: the device's local day, `YYYY-MM-DD`.
    ///   - tracking: whether a finger is down driving the fan; false when
    ///     VoiceOver opened it for taps.
    public init(
        anchor: CGPoint,
        bounds: CGRect,
        today: String,
        kind: Kind = .task,
        schedule: TaskSchedule = TaskSchedule(),
        metrics: Metrics = Metrics(),
        mode: Mode = .main,
        tracking: Bool = true
    ) {
        self.anchor = anchor
        self.bounds = bounds
        self.today = today
        self.kind = kind
        self.schedule = schedule
        self.metrics = metrics
        self.tracking = tracking
        self.touchDriven = tracking
        self.lastPoint = anchor
        show(mode)
    }

    // MARK: - Touches

    /// The finger moved. Returns what the view should react to.
    @discardableResult
    public mutating func move(to point: CGPoint, at time: Date) -> [Event] {
        guard tracking else { return [] }
        lastPoint = point
        if let armPoint {
            if distance(point, armPoint) < metrics.armDistance {
                highlighted = nil
                hoverSince = nil
                return []
            }
            self.armPoint = nil
        }
        var events: [Event] = []
        let hit = target(at: point)?.action
        if hit != highlighted {
            highlighted = hit
            hoverSince = hit == nil ? nil : time
            if let hit { events.append(.selectionChanged(hit)) }
        }
        return events + tick(at: time)
    }

    /// When a resting finger will have dwelt long enough to follow the
    /// navigation target under it; the view calls `tick` then.
    public var dwellDeadline: Date? {
        guard tracking, let highlighted, highlighted.isNavigation, let hoverSince else { return nil }
        return hoverSince.addingTimeInterval(metrics.dwell)
    }

    /// Time passed without movement: follow a navigation target the finger
    /// has rested on long enough.
    @discardableResult
    public mutating func tick(at time: Date) -> [Event] {
        guard let deadline = dwellDeadline, time >= deadline, let highlighted else { return [] }
        navigate(highlighted)
        armPoint = lastPoint
        return [.modeChanged(mode)]
    }

    /// The finger lifted at `point`: an action under it runs; anywhere else —
    /// the touch point, a gap, a navigation target, outside the fan — closes
    /// the fan with nothing changed.
    public mutating func release(at point: CGPoint, at time: Date) -> Outcome {
        guard tracking else { return .dismiss }
        move(to: point, at: time)
        tracking = false
        guard let highlighted, !highlighted.isNavigation else { return .dismiss }
        return .perform(highlighted)
    }

    /// A tap on a target of a fan VoiceOver opened.
    public mutating func tap(_ action: TaskFanAction) -> Outcome {
        tracking = false
        if action.isNavigation {
            navigate(action)
            return .stayOpen
        }
        return .perform(action)
    }

    // MARK: - Geometry

    /// The target under `point`, if any. The touch point itself selects
    /// nothing.
    public func target(at point: CGPoint) -> TaskFanTarget? {
        guard distance(point, anchor) > metrics.originRadius else { return nil }
        return targets.first { $0.frame.insetBy(dx: -metrics.hitSlop, dy: -metrics.hitSlop).contains(point) }
    }

    /// Whether the column rises from the touch or, near the top, hangs below it.
    public var upwards: Bool {
        Self.upwards(count: targets.count, anchor: anchor, bounds: bounds, metrics: metrics)
    }

    static func upwards(count: Int, anchor: CGPoint, bounds: CGRect, metrics: Metrics) -> Bool {
        let extent = CGFloat(count) * (metrics.targetHeight + metrics.spacing) + metrics.edgeMargin
        let roomAbove = anchor.y - bounds.minY
        let roomBelow = bounds.maxY - anchor.y
        return roomAbove >= extent || (roomBelow < extent && roomAbove >= roomBelow)
    }

    /// Lays out `labelled` as the column: the first nearest the thumb.
    static func layout(
        _ labelled: [(TaskFanAction, String)],
        anchor: CGPoint,
        bounds: CGRect,
        metrics: Metrics
    )
        -> [TaskFanTarget] {
        let count = labelled.count
        guard count > 0 else { return [] }
        let rising = upwards(count: count, anchor: anchor, bounds: bounds, metrics: metrics)
        let step = metrics.targetHeight + metrics.spacing
        let halfW = metrics.targetWidth / 2
        let halfH = metrics.targetHeight / 2
        var centers: [CGPoint] = (0 ..< count).map { index in
            let along = CGFloat(index) + 0.5
            let progress = count > 1 ? CGFloat(index) / CGFloat(count - 1) : 0
            let bow = metrics.curve * sin(.pi * progress)
            let lean = metrics.sweep * progress
            return CGPoint(
                x: anchor.x - metrics.lead - halfW - bow - lean,
                y: rising ? anchor.y - along * step : anchor.y + along * step
            )
        }
        // Keep the whole column inside the bounds by sliding it, never by
        // reordering it.
        let inner = bounds.insetBy(dx: metrics.edgeMargin, dy: metrics.edgeMargin)
        let minY = centers.map(\.y).min()! - halfH
        let maxY = centers.map(\.y).max()! + halfH
        let dy: CGFloat = minY < inner.minY ? inner.minY - minY : (maxY > inner.maxY ? inner.maxY - maxY : 0)
        let minX = centers.map(\.x).min()! - halfW
        let maxX = centers.map(\.x).max()! + halfW
        let dx: CGFloat = minX < inner.minX ? inner.minX - minX : (maxX > inner.maxX ? inner.maxX - maxX : 0)
        centers = centers.map { CGPoint(x: $0.x + dx, y: $0.y + dy) }
        return zip(labelled, centers).map { item, center in
            TaskFanTarget(
                action: item.0,
                label: item.1,
                frame: CGRect(
                    x: center.x - halfW,
                    y: center.y - halfH,
                    width: metrics.targetWidth,
                    height: metrics.targetHeight
                )
            )
        }
    }

    // MARK: - Content

    /// The main fan, nearest the finger first. The order never changes.
    public static let mainActions: [(TaskFanAction, String)] = [
        (.done, "Done"),
        (.doneWithNote, "Done + note"),
        (.tomorrow, "Tomorrow"),
        (.nextMonth, "Next month"),
        (.otherMonth, "Other month…"),
        (.cancelTask, "Cancel task"),
    ]

    /// A suggestion's main fan: take it on as it stands, with a note, or for
    /// a time; say it is already done; or ignore it.
    public static let suggestionActions: [(TaskFanAction, String)] = [
        (.accept, "Accept"),
        (.acceptWithNote, "Accept with note"),
        (.acceptFor, "Accept for…"),
        (.done, "Mark as done"),
        (.ignore, "Ignore"),
    ]

    /// When to accept a suggestion for: Back nearest the finger, then the
    /// times from soonest to latest.
    public static let whenActions: [(TaskFanAction, String)] = [
        (.back, "Back"),
        (.today, "Today"),
        (.tomorrow, "Tomorrow"),
        (.thisMonth, "This month"),
        (.nextMonth, "Next month"),
        (.otherMonth, "Other month…"),
        (.someday, "Someday"),
    ]

    /// The month fan for `page`: Back nearest the finger, Earlier when there
    /// is an earlier page, the page's months, then Later.
    public static func monthActions(
        page: Int,
        today: String,
        schedule: TaskSchedule,
        perPage: Int
    )
        -> [(TaskFanAction, String)] {
        var items: [(TaskFanAction, String)] = [(.back, "Back")]
        if page > 0 { items.append((.earlierMonths, "Earlier")) }
        items += months(page: page, today: today, schedule: schedule, perPage: perPage)
            .map { (.month($0.value), $0.label) }
        items.append((.laterMonths, "Later"))
        return items
    }

    /// A page of months to move a task to, each `YYYY-MM` with a label that
    /// always carries its year ("Jan 2027"). Page 0 starts the month after
    /// next — next month has its own target — and the pages run on with no
    /// end, across years.
    public static func months(
        page: Int,
        today: String,
        schedule: TaskSchedule,
        perPage: Int
    )
        -> [(value: String, label: String)] {
        guard let todayDate = schedule.date(fromDay: today) else { return [] }
        let start = schedule.calendar.dateInterval(of: .month, for: todayDate)?.start ?? todayDate
        let formatter = DateFormatter()
        formatter.calendar = schedule.calendar
        formatter.locale = schedule.locale
        formatter.timeZone = schedule.calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate("MMMyyyy")
        return (0 ..< perPage).compactMap { index in
            let offset = 2 + max(page, 0) * perPage + index
            guard let month = schedule.calendar.date(byAdding: .month, value: offset, to: start) else { return nil }
            return (schedule.month(month), formatter.string(from: month))
        }
    }

    // MARK: - Internals

    /// Shows the fan for `mode` directly — VoiceOver's "Move to month…".
    public mutating func show(_ mode: Mode) {
        self.mode = mode
        highlighted = nil
        hoverSince = nil
        let labelled: [(TaskFanAction, String)] = switch mode {
        case .main: kind == .suggestion ? Self.suggestionActions : Self.mainActions
        case .when: Self.whenActions
        case .months(let page):
            Self.monthActions(page: page, today: today, schedule: schedule, perPage: metrics.monthsPerPage)
        }
        targets = Self.layout(labelled, anchor: anchor, bounds: bounds, metrics: metrics)
    }

    private mutating func navigate(_ action: TaskFanAction) {
        switch (action, mode) {
        case (.otherMonth, _): show(.months(page: 0))
        case (.acceptFor, _): show(.when)
        // A suggestion's months were reached from its times.
        case (.back, .months): show(kind == .suggestion ? .when : .main)
        case (.back, _): show(.main)
        case (.laterMonths, .months(let page)): show(.months(page: page + 1))
        case (.earlierMonths, .months(let page)): show(.months(page: max(page - 1, 0)))
        default: break
        }
    }

    private func distance(_ from: CGPoint, _ to: CGPoint) -> CGFloat {
        hypot(from.x - to.x, from.y - to.y)
    }
}
