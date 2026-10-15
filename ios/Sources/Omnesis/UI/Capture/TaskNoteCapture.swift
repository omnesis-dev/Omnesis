// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// What the capture screen (`CaptureView`) does on Done when its note is
/// about a task rather than a note on its own: completing the task with the
/// note, or accepting a suggestion with it. It names the task, words the
/// screen for the purpose, and makes the call — returning whether the
/// gateway took it.
@available(iOS 17.0, *)
struct TaskNoteCapture {
    let taskTitle: String
    /// The screen's title.
    let heading: String
    let placeholder: String
    /// Shown when the gateway did not take it; the text stays for a retry.
    let failure: String
    let save: (String) async -> Bool

    /// "Done + note": completes the task with the note.
    static func completing(_ taskTitle: String, save: @escaping (String) async -> Bool) -> TaskNoteCapture {
        TaskNoteCapture(
            taskTitle: taskTitle,
            heading: "Done with a note",
            placeholder: "What happened?",
            failure: "Couldn't complete the task — try again.",
            save: save
        )
    }

    /// "Accept with note": takes on a suggestion, and Omnesis applies the
    /// note to it.
    static func accepting(_ taskTitle: String, save: @escaping (String) async -> Bool) -> TaskNoteCapture {
        TaskNoteCapture(
            taskTitle: taskTitle,
            heading: "Accept with a note",
            placeholder: "Anything Omnesis should know about it?",
            failure: "Couldn't accept the task — try again.",
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
#endif
#endif
