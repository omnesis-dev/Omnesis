// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(UIKit)
import UIKit

/// Wraps an async block in a `UIApplication.beginBackgroundTask` / `endBackgroundTask`
/// pair so iOS doesn't suspend the process while the block is mid-flight.
///
/// Why this matters: when the user backgrounds the app mid-sync, iOS
/// normally suspends us within seconds. Any in-flight `URLSession.shared`
/// upload is killed. `beginBackgroundTask` requests a grace window —
/// typically ~30 s — so the current sync cycle can finish cleanly. This
/// covers the common "user tapped Sync Now, then switched apps" case
/// where our batches are small (KB-sized) and would finish well within
/// the window.
///
/// Not a substitute for:
///   - `BGTaskScheduler` / `HKObserverQuery` — those cause iOS to wake
///     us later; this just extends the *current* execution.
///   - A full `URLSession(configuration: .background(…))` delegate
///     setup — which survives true app kill. Escalation path tracked
///     in #195 — revisit if we ever see uploads routinely exceed 30 s
///     or if we add a source with large payloads (audio / images).
///
/// Usage:
///
///   await BackgroundTaskGuard.run(name: "syncAll") {
///     await core.syncAll()
///   }
///
/// Returns the block's return value. If the OS expires the task before
/// the block finishes, the expiration handler calls `endBackgroundTask`
/// and the block continues until it returns — iOS will then suspend us
/// at the next opportunity.
/// Swift doesn't allow nested types inside generic functions, so the
/// mutable taskId holder lives at file scope.
@available(iOS 17.0, *)
private final class BackgroundTaskIDHolder: @unchecked Sendable {
    var taskId: UIBackgroundTaskIdentifier = .invalid
}

@available(iOS 17.0, *)
public enum BackgroundTaskGuard {
    @discardableResult
    public static func run<T: Sendable>(
        name: String,
        _ block: @Sendable () async -> T
    ) async
        -> T {
        let app = UIApplication.shared
        let holder = BackgroundTaskIDHolder()

        holder.taskId = await MainActor.run {
            app.beginBackgroundTask(withName: name) {
                // Expiration — iOS is about to suspend us. End the
                // task so we don't leak; the caller's block keeps
                // running but the OS may suspend shortly after.
                if holder.taskId != .invalid {
                    app.endBackgroundTask(holder.taskId)
                    holder.taskId = .invalid
                }
            }
        }

        let result = await block()

        await MainActor.run {
            if holder.taskId != .invalid {
                app.endBackgroundTask(holder.taskId)
                holder.taskId = .invalid
            }
        }
        return result
    }
}
#endif
