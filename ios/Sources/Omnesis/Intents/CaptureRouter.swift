// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Observation)
import Observation
#endif

/// Process-wide funnel for the Lock Screen / Control Center "Tell the
/// Brain" control. `HomeView` observes `requestCount` and presents
/// `CaptureView`.
///
/// A monotonically increasing counter (not a Bool) so back-to-back
/// requests each produce an observable change, and so a request that
/// arrives before `HomeView` exists (cold launch) is still visible on
/// its first appearance.
///
/// This file is deliberately UIKit-free: it is compiled into both the
/// app target and the `OmnesisWidgets` extension (the shared control
/// intent references it — see `OpenCaptureControlIntent`).
@available(iOS 17.0, macOS 14.0, *)
@MainActor
@Observable
public final class CaptureRouter {
    public static let shared = CaptureRouter()

    /// Bumped once per capture request. Observers compare against the
    /// value they last consumed.
    public private(set) var requestCount = 0

    /// Surface slug of the most recent request so the capture view
    /// attributes the note to the control that opened it. String-typed
    /// (not `NoteSurface`) because this file also compiles in the widget
    /// extension, which doesn't carry the transport layer.
    public private(set) var lastSurfaceSlug = "ios-app"

    /// When the most recent request was made. Consumers check freshness
    /// before presenting: a request can be consumed long after it was
    /// filed (e.g. a control tap on an unpaired app, consumed only when
    /// `HomeView` first exists after pairing) and popping the capture
    /// surface minutes later would be disorienting.
    public private(set) var lastRequestAt: Date?

    /// How long a request stays actionable.
    public static let freshnessWindow: TimeInterval = 30

    public init() {}

    public func requestCapture(surfaceSlug: String = "ios-app", at date: Date = Date()) {
        lastSurfaceSlug = surfaceSlug
        lastRequestAt = date
        requestCount += 1
    }

    /// Whether the most recent request is recent enough to act on.
    public func isFresh(asOf now: Date = Date()) -> Bool {
        guard let lastRequestAt else { return false }
        return now.timeIntervalSince(lastRequestAt) < Self.freshnessWindow
    }
}
