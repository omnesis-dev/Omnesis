// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Self-owned glyph for Location Visits, pushed to the gateway on source
/// registration — mirrors `ActivitySegmentsIcon`'s rationale: Core Location
/// is an Apple OS feature with no first-party icon to hotlink, so this
/// package owns a generic glyph.
public enum CoreLocationVisitsIcon {
    // swiftlint:disable line_length
    /// Lucide `map-pin` (ISC, see `TRADEMARKS.md`) tinted iOS system orange —
    /// a location pin, distinct from Apple Health's red and Activity
    /// Segments' green.
    private static let svg: String = """
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FF9F0A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>
    """
    // swiftlint:enable line_length

    public static let dataUri: String =
        "data:image/svg+xml;base64," + Data(svg.utf8).base64EncodedString()
}
