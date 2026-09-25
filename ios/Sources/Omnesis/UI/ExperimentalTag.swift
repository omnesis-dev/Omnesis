// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Small unobtrusive "Experimental" capsule, shared by every surface gated on
/// experimental mode — the Watches menu entry and capability cards whose
/// feature is not yet battle-tested. One source of truth so the tag reads
/// identically everywhere it appears.
struct ExperimentalTag: View {
    var body: some View {
        Text("Experimental")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(
                Capsule().fill(Theme.textMuted.opacity(0.14))
            )
            .accessibilityLabel("Experimental")
    }
}
#endif
