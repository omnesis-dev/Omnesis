// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
import Foundation

/// The long press on a task row, as the recognizer reports it, turned into
/// what the screen must do. Pure, so every state sequence a recognizer can
/// produce is covered by the logic lane.
///
/// One rule holds it together: a press that began always ends exactly once.
/// The list's own scrolling is suspended when the press begins — so sliding
/// over the fan cannot scroll — and resumed in the same step that ends it,
/// whether the finger lifted, the system cancelled the touch, the recognizer
/// failed, or it was taken off the list. A late or repeated report after
/// that changes nothing.
public struct TaskPressLifecycle: Equatable, Sendable {
    /// What a recognizer reports, reduced to what matters here.
    public enum Report: Equatable, Sendable {
        case began(CGPoint)
        case changed(CGPoint)
        /// The finger lifted where it was.
        case ended(CGPoint?)
        case cancelled
        case failed
        /// The recognizer was taken off the list (the list went away or was
        /// replaced).
        case detached
    }

    public enum Command: Equatable, Sendable {
        case suspendScrolling
        case begin(CGPoint)
        case move(CGPoint)
        /// Close the fan, acting on the target under `point` if there is
        /// one; nil never acts.
        case end(CGPoint?)
        case resumeScrolling
    }

    /// A press began and has not ended.
    public private(set) var active = false

    public init() {}

    public mutating func handle(_ report: Report) -> [Command] {
        switch report {
        case .began(let point):
            // A begin while one is open ends the stale one first.
            let stale = active ? finish(at: nil) : []
            active = true
            return stale + [.suspendScrolling, .begin(point)]
        case .changed(let point):
            return active ? [.move(point)] : []
        case .ended(let point):
            return finish(at: point)
        case .cancelled, .failed, .detached:
            return finish(at: nil)
        }
    }

    private mutating func finish(at point: CGPoint?) -> [Command] {
        guard active else { return [] }
        active = false
        return [.end(point), .resumeScrolling]
    }
}
