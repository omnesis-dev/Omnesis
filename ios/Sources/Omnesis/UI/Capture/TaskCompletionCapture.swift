// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
/// What the capture screen (`CaptureView`) does on Done when it completes a
/// task rather than saving a note: the task it names, and the call that
/// completes it with the note — returning whether the gateway took it.
@available(iOS 17.0, *)
struct TaskCompletionCapture {
    let taskTitle: String
    let save: (String) async -> Bool
}
#endif
