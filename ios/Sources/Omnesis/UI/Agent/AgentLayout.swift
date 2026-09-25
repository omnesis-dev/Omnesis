// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// How the agent screen arranges the conversation and the Timeline
/// (citations) panel relative to one another.
///
///   - `overlay`: the Timeline slides in from the trailing edge *over*
///     the conversation as a near-full-width drawer; the conversation
///     stays full-width underneath, dimmed by a scrim. This is the
///     iPhone — and iPad-portrait — presentation.
///   - `sidePanel`: the Timeline is docked as a fixed ~⅓-width column on
///     the trailing edge and the conversation shrinks to give way, so
///     both are legible at once. Used on iPad in landscape, where there
///     is room for a true split.
@available(iOS 17.0, *)
enum AgentLayoutMode: Equatable {
    case overlay
    case sidePanel
}

/// Single decision point for the agent screen's adaptive layout.
///
/// Centralising the gate here — rather than scattering size-class and
/// orientation checks across the views — means the whole iPad split can
/// be reverted with a one-line change: flip `iPadSplitEnabled` to
/// `false` and every consumer falls back to the iPhone overlay on every
/// device and orientation.
@available(iOS 17.0, *)
enum AgentLayout {
    /// Master switch for the iPad-landscape split. Set to `false` to
    /// ship the iPhone-style overlay everywhere, reverting the entire
    /// feature.
    static let iPadSplitEnabled = true

    /// Fraction of the total width the docked Timeline panel occupies in
    /// `sidePanel` mode, before clamping. ~⅓ so the conversation keeps
    /// the majority of the screen.
    static let sidePanelFraction: CGFloat = 0.34
    /// Lower clamp on the docked panel — below this the Timeline rows
    /// get too cramped to read.
    static let sidePanelMinWidth: CGFloat = 340
    /// Upper clamp — keeps the panel from ballooning on a 13" iPad while
    /// still reading as "a third".
    static let sidePanelMaxWidth: CGFloat = 480
    /// Minimum total width before a split is worth doing. Below this — an
    /// iPad multitasking pane, say — the overlay reads better. Sits above
    /// every iPhone's portrait width and below every iPad's full-screen
    /// landscape width.
    static let minTotalWidthForSplit: CGFloat = 768

    /// Test seam. Snapshot tests render iPad-sized canvases on an iPhone
    /// simulator, where `userInterfaceIdiom` is `.phone`; setting this to
    /// `true`/`false` overrides the live idiom check so those tests can
    /// exercise both layouts deterministically. `nil` (the default) uses
    /// the real device idiom.
    static var idiomOverride: Bool?

    private static var idiomSupportsSplit: Bool {
        idiomOverride ?? (UIDevice.current.userInterfaceIdiom == .pad)
    }

    /// Resolve the layout mode for a given available size. `sidePanel`
    /// only when the split is enabled, the device is an iPad (or a test
    /// forces it), there is enough width, and the geometry is landscape
    /// (wider than tall). Everything else — iPhone in any orientation,
    /// iPad portrait, narrow iPad panes — uses `overlay`.
    static func mode(for size: CGSize) -> AgentLayoutMode {
        guard iPadSplitEnabled,
              idiomSupportsSplit,
              size.width >= minTotalWidthForSplit,
              size.width > size.height
        else { return .overlay }
        return .sidePanel
    }

    /// Width of the docked Timeline panel for a given total width,
    /// clamped to a comfortable band around ~⅓.
    static func sidePanelWidth(forTotalWidth total: CGFloat) -> CGFloat {
        min(sidePanelMaxWidth, max(sidePanelMinWidth, total * sidePanelFraction))
    }
}
#endif
