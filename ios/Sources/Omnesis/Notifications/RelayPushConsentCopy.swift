// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What Omnesis says when asking to use the push relay. The consent sheet and
/// phone setup's relay consent step both ask with these words.
enum RelayPushConsentCopy {
    static let title = "Allow private notification wakes"
    static let explanation = "This App Store build is not covered by your gateway’s direct push credentials. "
        + "With your permission, it can use the Omnesis relay to receive content-blind wakes."
    static let neverReceivesTitle = "The relay never receives"
    static let neverReceivesDetail = "Notification text, your gateway address, your account, or which notification fired."
    static let allow = "Allow relay notifications"
    static let allowing = "Allowing relay notifications…"
    static let notNow = "Not now"
}
