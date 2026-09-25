// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Self-owned glyph for Activity Segments, pushed to the gateway on
/// source registration — mirrors `AppleHealthIcon`'s rationale: Core
/// Motion is an Apple OS feature, not a third-party service, but it has
/// no first-party icon of its own to hotlink, so this package owns a
/// generic glyph instead.
public enum ActivitySegmentsIcon {
    /// Lucide `footprints` (ISC, see `TRADEMARKS.md`) tinted iOS system
    /// green — evocative of movement without colliding with Apple
    /// Health's red.
    private static let svg: String = """
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#30D158" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/></svg>
    """

    public static let dataUri: String =
        "data:image/svg+xml;base64," + Data(svg.utf8).base64EncodedString()
}
