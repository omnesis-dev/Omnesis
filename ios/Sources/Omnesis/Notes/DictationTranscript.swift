// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Pure composition rule for resumable dictation: the speech
/// recognizer resets its transcript on every (re)start, so the capture
/// surface snapshots the text committed so far as a `base` and renders
/// each live partial as `base + " " + partial`. Kept UIKit-free so the
/// SwiftPM logic lane can pin the rule.
public enum DictationTranscript {
    /// Join the committed base text with the current recognizer
    /// partial. Empty sides pass through untouched; both non-empty are
    /// joined with a single space (whitespace-normalized at the seam).
    public static func compose(base: String, partial: String) -> String {
        let trimmedPartial = partial.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPartial.isEmpty else { return base }
        let trimmedBase = base.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBase.isEmpty else { return trimmedPartial }
        return "\(trimmedBase) \(trimmedPartial)"
    }
}
