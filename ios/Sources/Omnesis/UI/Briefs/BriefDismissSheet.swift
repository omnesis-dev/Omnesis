// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The dismiss-with-reason modal. Reasons are kind-conditional —
/// loop-kind briefs offer "Already handled", info-kind "Acknowledged"
/// — plus "Snooze" with its re-surface choices, and a free-text field
/// for corrections (the highest-value feedback signal).
/// Confirming closes the sheet immediately; the POST and the card's
/// removal happen in `BriefsView`.
@available(iOS 17.0, *)
struct BriefDismissSheet: View {
    let brief: BriefRecord
    /// (reason, free-text feedback or nil, snoozeUntil or nil).
    let onConfirm: (BriefDismissReason, String?, Date?) -> Void

    @Environment(\.dismiss) private var dismissSheet
    @State private var reason: BriefDismissReason?
    @State private var snoozeChoice: SnoozeOption = .agentDecides
    @State private var pickedTime = Date().addingTimeInterval(3600)
    @State private var feedbackText = ""

    /// Preview/snapshot seam: pre-select a reason so the snooze section
    /// renders without tapping.
    init(
        brief: BriefRecord,
        initialReason: BriefDismissReason? = nil,
        onConfirm: @escaping (BriefDismissReason, String?, Date?) -> Void
    ) {
        self.brief = brief
        self.onConfirm = onConfirm
        self._reason = State(initialValue: initialReason)
    }

    /// The snooze sub-choices, mirrored onto `BriefSnoozeChoice` when
    /// confirming (kept `Hashable`-simple for the ForEach).
    private enum SnoozeOption: String, CaseIterable {
        case laterToday = "Later today"
        case tomorrow = "Tomorrow"
        case pickATime = "Pick a time"
        case agentDecides = "Let the agent decide"
    }

    private var reasons: [(BriefDismissReason, String)] {
        [
            (.notRelevant, "Not relevant"),
            (.wrong, "Wrong"),
            (brief.kind.clearActionReason, brief.kind == .loop ? "Already handled" : "Acknowledged"),
            (.snoozed, "Snooze"),
        ]
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Why dismiss this brief?") {
                    ForEach(reasons, id: \.0) { value, label in
                        Button {
                            reason = value
                        } label: {
                            HStack {
                                Text(label)
                                    .foregroundStyle(Theme.textPrimary)
                                Spacer()
                                if reason == value {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Theme.accent)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                if reason == .snoozed {
                    Section("Remind me") {
                        ForEach(SnoozeOption.allCases, id: \.self) { option in
                            Button {
                                snoozeChoice = option
                            } label: {
                                HStack {
                                    Text(option.rawValue)
                                        .foregroundStyle(Theme.textPrimary)
                                    Spacer()
                                    if snoozeChoice == option {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(Theme.accent)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        if snoozeChoice == .pickATime {
                            DatePicker(
                                "Time",
                                selection: $pickedTime,
                                in: Date()...,
                                displayedComponents: [.date, .hourAndMinute]
                            )
                        }
                    }
                }
                Section("Anything to correct or add? (optional)") {
                    TextField(
                        "e.g. the deadline is actually the 20th",
                        text: $feedbackText,
                        axis: .vertical
                    )
                    .lineLimit(2 ... 4)
                }
            }
            .navigationTitle("Dismiss brief")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismissSheet() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Dismiss") { confirm() }
                        .disabled(reason == nil)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func confirm() {
        guard let reason else { return }
        let trimmed = feedbackText.trimmingCharacters(in: .whitespacesAndNewlines)
        let snoozeUntil: Date? = reason == .snoozed
            ? briefSnoozeChoice.resolvedTime(now: Date())
            : nil
        onConfirm(reason, trimmed.isEmpty ? nil : trimmed, snoozeUntil)
        dismissSheet()
    }

    private var briefSnoozeChoice: BriefSnoozeChoice {
        switch snoozeChoice {
        case .laterToday: .laterToday
        case .tomorrow: .tomorrow
        case .pickATime: .pickATime(pickedTime)
        case .agentDecides: .agentDecides
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("BriefDismissSheet — loop kind, snooze open") {
    BriefDismissSheet(brief: PreviewMocks.briefLoop, initialReason: .snoozed) { _, _, _ in }
        .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("BriefDismissSheet — info kind") {
    BriefDismissSheet(brief: PreviewMocks.briefInfo) { _, _, _ in }
        .preferredColorScheme(.dark)
}
#endif
#endif
