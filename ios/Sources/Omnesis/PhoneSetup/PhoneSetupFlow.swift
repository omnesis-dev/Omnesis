// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The page phone setup is showing.
public enum PhoneSetupScreen: Equatable, Codable, Sendable {
    case connected
    case choose
    /// The selected step at `index`, in selection order.
    case step(index: Int)
    case finish
}

/// Where a run of phone setup stands: the page on screen, the steps the user
/// selected, and how each step ended. A value type with no knowledge of any
/// particular source, so it persists as JSON and resumes after the app is
/// killed.
public struct PhoneSetupFlow: Equatable, Codable, Sendable {
    public private(set) var screen: PhoneSetupScreen
    /// Selected step ids, kept in the order Choose lists them.
    public private(set) var selection: [String] = []
    public private(set) var outcomes: [String: PhoneSetupOutcome] = [:]
    /// Whether the run opened on Connected. A run started from Settings opens
    /// on Choose instead.
    public let includesConnected: Bool

    public init(includesConnected: Bool) {
        self.includesConnected = includesConnected
        screen = includesConnected ? .connected : .choose
    }

    public var currentStepId: String? {
        guard case .step(let index) = screen, selection.indices.contains(index) else { return nil }
        return selection[index]
    }

    public var isOnLastStep: Bool {
        guard case .step(let index) = screen else { return false }
        return index == selection.count - 1
    }

    /// Progress segments: the current step's position, or nil off the steps.
    public var currentStepIndex: Int? {
        guard case .step(let index) = screen else { return nil }
        return index
    }

    /// Whether any selected step left its source contributing.
    public var contributed: Bool {
        selection.contains { outcomes[$0]?.isContributing == true }
    }

    public func isSelected(_ id: String) -> Bool {
        selection.contains(id)
    }

    public mutating func showChoose() {
        screen = .choose
    }

    /// Selects or deselects `id`. The selection keeps `order`, the order Choose
    /// lists its rows in, whatever order the rows were tapped in.
    public mutating func toggle(_ id: String, order: [String]) {
        var selected = Set(selection)
        if selected.contains(id) {
            selected.remove(id)
            outcomes[id] = nil
        } else {
            selected.insert(id)
        }
        selection = order.filter(selected.contains)
    }

    /// Moves from Choose to the first selected step. Returns false when
    /// nothing is selected.
    @discardableResult
    public mutating func startSteps() -> Bool {
        guard !selection.isEmpty else { return false }
        screen = .step(index: 0)
        return true
    }

    /// Records how a selected step ended; `nil` returns it to its unanswered
    /// page.
    public mutating func record(_ outcome: PhoneSetupOutcome?, for id: String) {
        guard selection.contains(id) else { return }
        outcomes[id] = outcome
    }

    /// Moves to the next selected step, or to Finish after the last one.
    public mutating func advance() {
        guard case .step(let index) = screen else { return }
        screen = index + 1 < selection.count ? .step(index: index + 1) : .finish
    }

    /// Brings the automatic steps in the selection to `wanted`, in `order`. A
    /// wanted step is only added after the page on screen, never behind it or
    /// once Finish shows. An automatic step no longer wanted stays only when the
    /// user has passed it, or it is the answered page on screen; otherwise it
    /// leaves, and if it is the page on screen, what followed it takes its place.
    public mutating func setAutomaticSteps(_ wanted: Set<String>, automatic: Set<String>, order: [String]) {
        let current = currentStepId
        let reached: Int = switch screen {
        case .connected, .choose: -1
        case .step(let index): index
        case .finish: selection.count
        }
        var ids = Set(selection.enumerated().compactMap { index, id in
            !automatic.contains(id) || wanted.contains(id) || index < reached
                || (index == reached && outcomes[id] != nil) ? id : nil
        })
        let currentPosition = current.flatMap { order.firstIndex(of: $0) }
        for id in wanted where !ids.contains(id) {
            guard let position = order.firstIndex(of: id) else { continue }
            switch screen {
            case .connected, .choose:
                ids.insert(id)
            case .step:
                if let currentPosition, position > currentPosition {
                    ids.insert(id)
                }
            case .finish:
                break
            }
        }
        let updated = order.filter(ids.contains)
        guard updated != selection else { return }
        selection = updated
        outcomes = outcomes.filter { ids.contains($0.key) }
        guard case .step = screen, let current, let currentPosition else { return }
        if let index = selection.firstIndex(of: current) {
            screen = .step(index: index)
        } else {
            let next = selection.firstIndex { order.firstIndex(of: $0).map { $0 > currentPosition } ?? false }
            screen = next.map { .step(index: $0) } ?? .finish
        }
    }

    /// This run without `ids`, as saved progress keeps it. A run on one of
    /// those pages resumes on Finish.
    public func removingSteps(_ ids: Set<String>) -> PhoneSetupFlow {
        var trimmed = self
        let current = currentStepId
        trimmed.dropSteps(ids)
        guard case .step = screen else { return trimmed }
        if let current, let index = trimmed.selection.firstIndex(of: current) {
            trimmed.screen = .step(index: index)
        } else {
            trimmed.screen = .finish
        }
        return trimmed
    }

    /// Removes `ids` from the selection, as returning to Choose does for the
    /// steps the flow added itself.
    public mutating func dropSteps(_ ids: Set<String>) {
        selection.removeAll { ids.contains($0) }
        outcomes = outcomes.filter { !ids.contains($0.key) }
    }

    /// Returns from a step to the previous step, or to Choose from the first.
    public mutating func back() {
        guard case .step(let index) = screen else { return }
        screen = index == 0 ? .choose : .step(index: index - 1)
    }
}
