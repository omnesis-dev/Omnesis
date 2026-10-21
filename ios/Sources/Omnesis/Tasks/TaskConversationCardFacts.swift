// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// One fact on the card at the top of a chat about a task: its state, when
/// it is due, or how many documents it refers to.
public struct TaskConversationCardFact: Equatable, Sendable, Hashable {
    public enum Tone: Sendable, Hashable { case neutral, danger }

    public let icon: String
    public let text: String
    public let tone: Tone
}

extension TaskConversationOriginSnapshot {
    /// The facts under the card's title, in reading order. `today` is the
    /// device's local day (`YYYY-MM-DD`), against which the due day reads as
    /// "Due today", "Due tomorrow" or a date.
    public func cardFacts(today: String, schedule: TaskSchedule = TaskSchedule()) -> [TaskConversationCardFact] {
        let known = TaskRecord.State(rawValue: state)
        var facts = [TaskConversationCardFact(icon: Self.stateIcon(known), text: stateLabel, tone: .neutral)]
        if let label = schedule.deadlineLabel(nil, dueDay: due, today: today) {
            let unresolved = known != .done && known != .dismissed
            let overdue = unresolved && schedule.isOverdue(dueDay: due, today: today)
            facts.append(.init(icon: "flag", text: label, tone: overdue ? .danger : .neutral))
        }
        if sourceCount > 0 {
            facts.append(.init(
                icon: "doc.text",
                text: sourceCount == 1 ? "1 source" : "\(sourceCount) sources",
                tone: .neutral
            ))
        }
        return facts
    }

    /// The state in the words the task's details use; a state this build does
    /// not know reads as the gateway wrote it.
    public var stateLabel: String {
        switch TaskRecord.State(rawValue: state) {
        case .open: "Open"
        case .snoozed: "Snoozed"
        case .done: "Done"
        case .dismissed: "Struck"
        case nil: state.prefix(1).uppercased() + state.dropFirst()
        }
    }

    private static func stateIcon(_ state: TaskRecord.State?) -> String {
        switch state {
        case .done: "checkmark.circle"
        case .dismissed: "xmark.circle"
        case .snoozed: "moon.zzz"
        case .open, nil: "circle"
        }
    }
}
