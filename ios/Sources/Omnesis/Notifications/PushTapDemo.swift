// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// DEBUG-only root for `PushTapUITests` — a real APNs push cannot reach
/// the simulator, so this harness drives the production tap chain from
/// the point the notification-center delegate hands the payload over:
/// `OmnesisAppDelegate.handleNotificationTap` → `NotificationRouter` →
/// `HomeView` section flip → destination-view consumption.
///
/// Launching with `DEMO_PUSH_TAP=<mode>` boots the real `HomeView` over
/// a preview store, wires the real `OmnesisAppDelegate` callbacks (the
/// same `bindAppDelegate` path the production root uses), then feeds the
/// delegate the exact `omnesis` payload a gateway push carries. Modes:
///
///   - `warm` — warm app: `/status` already resolved (experimental
///     gateway), callbacks bound, then a trigger-firing tap lands.
///   - `cold` — cold tap-launch: the trigger-firing tap lands BEFORE
///     the callbacks are bound (exercising the delegate's pre-bind
///     buffer) and `/status` never resolves. The tap must still
///     navigate: the push's existence is itself proof the gateway runs
///     the feature.
///   - `privacy-cold` — a privacy-approval tap with `/status` never
///     resolving: the Privacy section must mount and consume even
///     though the drawer would not show its entry yet.
@available(iOS 17.0, *)
struct PushTapDemoRoot: View {
    // @State so re-evaluations of the WindowGroup body reuse one store
    // (and one NotificationRouter) instead of discarding queued state.
    @State private var store: AppStore
    private let mode: String
    private let delegate: OmnesisAppDelegate

    init(mode: String, delegate: OmnesisAppDelegate) {
        self.mode = mode
        self.delegate = delegate
        self._store = State(
            wrappedValue: AppStore.preview(
                statusSnapshot: mode == "warm" ? PreviewMocks.statusSnapshotExperimental : nil
            )
        )
    }

    /// The `userInfo` a gateway push arrives with (the `aps` alert plus
    /// the top-level `omnesis` dict the APNs client embeds).
    private var probePayload: [AnyHashable: Any] {
        let omnesis: [String: Any] = mode == "privacy-cold"
            ? ["kind": "privacy-approval", "approvalId": "approval-demo"]
            : ["kind": "watch-firing", "watchId": "w_demo", "firingKey": "w_demo:1"]
        return [
            "aps": ["alert": ["title": "Omnesis: Demo watch", "body": "1 matched"]],
            "omnesis": omnesis,
        ]
    }

    var body: some View {
        HomeView()
            .environment(store)
            .environment(store.notificationRouter)
            .task {
                if mode == "cold" {
                    // Cold shape: the tap arrives before the SwiftUI task
                    // binds the delegate — buffered, then drained by the
                    // bind. The drain hands the target over via a deferred
                    // main-actor Task (bindAppDelegate), so pendingTarget
                    // lands on a later turn and HomeView's onChange — not
                    // its onAppear — performs the flip.
                    delegate.handleNotificationTap(userInfo: probePayload)
                    store.bindAppDelegate(delegate)
                } else {
                    // Bound-callback shape: the tap lands after wiring.
                    store.bindAppDelegate(delegate)
                    delegate.handleNotificationTap(userInfo: probePayload)
                }
            }
    }
}
#endif
#endif
