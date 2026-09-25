// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(iOS)
import AppIntents
import Foundation

/// "Ask Omnesis <question>" — put a question to the agent by voice and
/// hear the answer, entirely in the background: no app open, no UI. Runs
/// in-process, delegates to `SiriAskRunner` (open a voice-profile agent
/// session against the gateway, post the question, fold the turn's
/// stream into a spoken reply), and speaks the outcome through Siri. The
/// conversation is a normal persisted one, so it shows up in the app's
/// conversation list; asks within `SiriAskContinuity.window` of each
/// other continue the same thread, so follow-ups keep their context.
///
/// A turn that outlives the spoken-answer budget isn't lost: the send
/// arms `notifyAfterMs`, so a turn still running when the budget ends
/// delivers its finished answer as an `agent-answer` push.
///
/// The same `SiriAskRunner` also answers relayed asks from the Apple
/// Watch (see `WatchRelayReceiver`), so the phone and watch speak identical
/// copy for every outcome via `SiriAskDialog`.
public struct AskOmnesisIntent: AppIntent {
    public static let title: LocalizedStringResource = "Ask Omnesis"
    public static let description = IntentDescription(
        "Ask your Omnesis brain a question and hear the answer. Long answers arrive as a notification."
    )
    // Background by default: openAppWhenRun stays false.

    @Parameter(title: "Question", requestValueDialog: "What would you like to ask?")
    public var question: String

    public init() {}

    public init(question: String) {
        self.question = question
    }

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw $question.needsValueError("What would you like to ask?")
        }
        let outcome = await SiriAskRunner().run(question: trimmed)
        return .result(dialog: "\(SiriAskDialog.text(for: outcome))")
    }
}
#endif
