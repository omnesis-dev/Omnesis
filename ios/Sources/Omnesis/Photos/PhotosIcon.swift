// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Self-owned glyph for the Photos source, pushed to the gateway on
/// source registration so the portal/iOS app/iTerm CLI render the same
/// icon. Not Apple's Photos app icon — see `AppleHealthIcon` for why
/// (Apple's trademark guidelines forbid third-party use of their
/// first-party app icons, even via hotlink) and `TRADEMARKS.md`.
public enum PhotosIcon {
    /// Lucide `image` (ISC) tinted to system blue.
    private static let svg: String = """
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0A84FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
    """

    public static let dataUri: String =
        "data:image/svg+xml;base64," + Data(svg.utf8).base64EncodedString()
}
