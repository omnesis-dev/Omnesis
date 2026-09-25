// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

extension WatchNoteOutcome {
    /// The watch-facing outcome for a phone-side capture result, used by
    /// the relay receiver to answer a watch note.
    ///
    /// Lives on the phone (not in the shared `WatchNote` contract) because
    /// it maps `NoteCaptureService.Outcome`, which the watch target does
    /// not compile. The watch-only relay outcomes (`reachedPhone`,
    /// `phoneUnreachable`, `watchLinkInactive`, `relayFailed`,
    /// `queuedForPhone`) are produced on the watch and never come from a
    /// capture.
    init(capture outcome: NoteCaptureService.Outcome) {
        switch outcome {
        case .saved: self = .saved
        case .queued: self = .queuedOnPhone
        case .rejected: self = .rejected
        case .failed: self = .captureFailed
        }
    }
}
