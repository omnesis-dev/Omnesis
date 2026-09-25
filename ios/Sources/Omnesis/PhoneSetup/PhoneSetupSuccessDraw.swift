// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// When a step's outcome mark draws its success ring in.
public enum PhoneSetupSuccessDraw {
    /// On every change into a success outcome: when the page opens on one
    /// (`old` is nil), and when the outcome changes in place on the same page,
    /// as when the step carries on by itself after the user returns from iOS
    /// Settings. A success that stays a success is already drawn.
    public static func drawsIn(from old: PhoneSetupOutcome?, to new: PhoneSetupOutcome) -> Bool {
        new.isContributing && old?.isContributing != true
    }
}
