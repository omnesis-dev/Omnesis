// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The `progress` object of a `sync.status` event, derived from the lifecycle
/// event the phone is publishing.
///
/// Two things share the object. `processed` is how far the cycle got, and it
/// is what a live sync reports on every page. `coverage` plus `detail` is the
/// claim a cycle makes about the history behind it, and only a cycle with
/// something to say carries one — a source that kept everything it captured
/// sends neither key, because a coverage line on a healthy source reads as a
/// warning about nothing.
///
/// The object is omitted entirely when neither applies, which is what a
/// `started` or `error` event sends.
///
/// Lives apart from `AdminCoordinator` because that type is compiled only
/// where UIKit is, and the mapping from a lifecycle event to the bytes the
/// gateway reads is worth checking without a simulator.
func syncStatusProgressPayload(
    for event: CollectorCore.Lifecycle,
    processed: Int?
)
    -> [String: JSONValue]? {
    var progress: [String: JSONValue] = [:]
    if let processed {
        progress["processed"] = .int(Int64(processed))
    }
    if case .completed(_, _, _, _, let claim) = event, let claim {
        progress["coverage"] = .string(claim.coverage.rawValue)
        progress["detail"] = .string(claim.detail)
    }
    return progress.isEmpty ? nil : progress
}
