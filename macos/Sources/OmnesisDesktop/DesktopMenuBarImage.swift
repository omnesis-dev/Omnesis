// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit

@MainActor
enum DesktopMenuBarImage {
    static func make() -> NSImage? {
        guard let image = Bundle.main.image(forResource: NSImage.Name("OmnesisMenuMark"))?.copy() as? NSImage else { return nil }
        // Native status controls use the image's description when exposing their label.
        image.accessibilityDescription = "Omnesis"
        image.isTemplate = true
        return image
    }
}
