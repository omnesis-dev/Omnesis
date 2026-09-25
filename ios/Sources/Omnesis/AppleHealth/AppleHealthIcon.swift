// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Self-owned glyph for Apple Health, pushed to the gateway on source
/// registration so the portal/iOS app/iTerm CLI render the same icon
/// for the iPhone-only `apple-health` source.
///
/// Apple's trademark guidelines forbid third-party use of their first-party
/// app icons in other software UIs, even via hotlink — so this package
/// owns its glyph: a Lucide `heart-pulse` SVG (ISC-licensed, see
/// `TRADEMARKS.md`) tinted to Apple's system red. The gateway's icon
/// normalizer rasterizes the SVG to a PNG once on first push; every
/// consumer reads back the same `data:image/png;base64,…` afterward.
public enum AppleHealthIcon {
    /// Lucide `heart-pulse` (ISC) tinted to `#FF2D55`.
    private static let svg: String = """
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FF2D55" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/></svg>
    """

    public static let dataUri: String =
        "data:image/svg+xml;base64," + Data(svg.utf8).base64EncodedString()
}
