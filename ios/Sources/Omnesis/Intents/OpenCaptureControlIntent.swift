// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(iOS)
import AppIntents
import Foundation

/// The intent behind the Control Center / Lock Screen "Tell Omnesis"
/// button. This file is compiled into BOTH the app target and the
/// `OmnesisWidgets` extension — target membership in both is what lets
/// a control launch its container app (see `ios/project.yml`).
///
/// Belt and braces for the launch → capture hand-off, because where
/// `perform()` runs depends on which process the system picks:
///   - Running in the app (the usual case for dual-membership intents):
///     `CaptureRouter` flips directly and the returned `OpenURLIntent`
///     resolves to our own scheme, which the app also routes to capture.
///   - Running in the widget extension: the router bump is a no-op in
///     that process, and the `OpenURLIntent` result is what opens the
///     app at `omnesis://capture`.
///
/// Hidden from the Shortcuts app (`isDiscoverable = false`) — this
/// exists only so the control has an intent it can share with the
/// extension. Siri's background note capture uses `CaptureNoteIntent`.
@available(iOS 18.0, *)
public struct OpenCaptureControlIntent: AppIntent {
    public static let title: LocalizedStringResource = "Tell Omnesis"
    public static let isDiscoverable = false
    public static let openAppWhenRun = true

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult & OpensIntent {
        CaptureRouter.shared.requestCapture(surfaceSlug: "ios-control")
        return .result(opensIntent: OpenURLIntent(URL(string: "omnesis://capture?surface=ios-control")!))
    }
}
#endif
