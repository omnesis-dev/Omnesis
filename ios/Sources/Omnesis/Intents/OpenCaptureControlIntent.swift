// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(iOS)
import AppIntents
import Foundation

/// Opens unified dictation from Control Center, the Lock Screen, or an
/// Action button shortcut. Shared target membership lets the system open
/// the container app; the URL also covers extension-process execution.
@available(iOS 18.0, *)
public struct OpenCaptureControlIntent: AppIntent {
    public static let title: LocalizedStringResource = "Speak to Omnesis"
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
