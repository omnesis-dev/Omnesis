// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The card pinned above a conversation that is about something: the watch
/// firing that opened it, or the task it was started from. Nothing for an
/// origin without a card of its own, such as the Morning brief, or one this
/// build does not know.
@available(iOS 17.0, *)
struct ConversationOriginCard: View {
    let origin: ConversationOrigin

    var body: some View {
        if let watch = origin.watch {
            WatchFiringContextCard(snapshot: watch, watchId: origin.watchId)
        } else if let task = origin.taskCard {
            TaskContextCard(snapshot: task, taskId: origin.taskId)
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("ConversationOriginCard — task") {
    ConversationOriginCard(origin: PreviewMocks.taskConversationOrigin)
        .padding()
        .background(Theme.bgPrimary)
        .environment(NotificationRouter())
}

@available(iOS 17.0, *)
#Preview("ConversationOriginCard — watch firing") {
    ConversationOriginCard(origin: ConversationOrigin(
        kind: "watch_firing",
        watchId: PreviewMocks.watchFiringOriginWatchId,
        runId: "run_preview",
        watch: PreviewMocks.watchFiringOrigin
    ))
    .padding()
    .background(Theme.bgPrimary)
    .environment(NotificationRouter())
}
#endif
#endif
