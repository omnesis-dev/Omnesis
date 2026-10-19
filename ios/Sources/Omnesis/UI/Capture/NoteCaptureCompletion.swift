// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// What the capture screen (`CaptureView`) does on Done when its words are
/// about something rather than a note on their own: completing a task with
/// a note, accepting a suggestion with one, or explaining a reaction to a
/// morning brief item. It names the subject, words the screen for the
/// purpose, and makes the call — returning whether the gateway took it.
@available(iOS 17.0, *)
struct NoteCaptureCompletion {
    /// Shown under the heading: the task's title, or the brief item's sentence.
    let subject: String
    /// The screen's title.
    let heading: String
    let placeholder: String
    /// Shown when the gateway did not take it; the text stays for a retry.
    let failure: String
    let save: (String) async -> Bool

    /// "Done + note": completes the task with the note.
    static func completing(_ taskTitle: String, save: @escaping (String) async -> Bool) -> NoteCaptureCompletion {
        NoteCaptureCompletion(
            subject: taskTitle,
            heading: "Done with a note",
            placeholder: "What happened?",
            failure: "Couldn't complete the task — try again.",
            save: save
        )
    }

    /// "Accept with note": takes on a suggestion, and Omnesis applies the
    /// note to it.
    static func accepting(_ taskTitle: String, save: @escaping (String) async -> Bool) -> NoteCaptureCompletion {
        NoteCaptureCompletion(
            subject: taskTitle,
            heading: "Accept with a note",
            placeholder: "Anything Omnesis should know about it?",
            failure: "Couldn't accept the task — try again.",
            save: save
        )
    }

    /// After "Not interested" on a brief item: the words are optional, and
    /// the reaction already stands without them.
    static func explainingDisinterest(_ summary: String, save: @escaping (String) async -> Bool) -> NoteCaptureCompletion {
        NoteCaptureCompletion(
            subject: summary,
            heading: "Why not?",
            placeholder: "A few words help Omnesis learn — or just cancel",
            failure: "Couldn't send your words — try again.",
            save: save
        )
    }

    /// After "Factual error" on a brief item: the correction Omnesis keeps.
    static func correcting(_ summary: String, save: @escaping (String) async -> Bool) -> NoteCaptureCompletion {
        NoteCaptureCompletion(
            subject: summary,
            heading: "What's wrong?",
            placeholder: "What is actually the case?",
            failure: "Couldn't send the correction — try again.",
            save: save
        )
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Capture — completing a task, listening") {
    CaptureView(
        completion: .completing(PreviewMocks.taskWithPerson.title) { _ in true },
        speech: .preview(state: .listening, transcript: "Went through it together"),
        previewText: "Went through it together"
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — completing a task, typing") {
    CaptureView(
        completion: .completing(PreviewMocks.taskWithPerson.title) { _ in true },
        speech: .preview(state: .idle),
        previewText: "Signed and scanned, copy sent to the club"
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — accepting a suggestion, typing") {
    CaptureView(
        completion: .accepting(PreviewMocks.tasksSuggested[0].title) { _ in true },
        speech: .preview(state: .idle),
        previewText: "Jamie needs it by Friday, pay from the joint account"
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — why not, nothing said yet") {
    CaptureView(
        completion: .explainingDisinterest(PreviewMocks.dailyBriefToday.items[2].summary) { _ in true },
        speech: .preview(state: .idle)
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — what's wrong, typing") {
    CaptureView(
        completion: .correcting(PreviewMocks.dailyBriefToday.items[0].summary) { _ in true },
        speech: .preview(state: .idle),
        previewText: "The reply is due next Wednesday, not Friday"
    )
    .environment(AppStore.preview())
}
#endif
#endif
