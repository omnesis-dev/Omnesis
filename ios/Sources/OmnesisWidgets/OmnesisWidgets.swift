// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppIntents
import SwiftUI
import WidgetKit

/// Tasks and voice capture, hosted in the app's WidgetKit extension.
/// Task data uses a dedicated device-only shared Keychain group.
@main
struct OmnesisWidgetsBundle: WidgetBundle {
    var body: some Widget {
        TaskWidget()
        if #available(iOSApplicationExtension 18.0, *) {
            TellBrainControl()
        }
    }
}

// MARK: - Control Center / Lock Screen control (iOS 18+)

@available(iOSApplicationExtension 18.0, *)
struct TellBrainControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "dev.omnesis.ios.widgets.tell-control") {
            ControlWidgetButton(action: OpenCaptureControlIntent()) {
                // Custom monochrome symbol: the Omnesis logo.
                // Control Center renders control glyphs as a tinted
                // template, so this is the brand mark's silhouette, not
                // the full-color logo.
                Label("Omnesis", image: "omnesis.mark")
                    .labelStyle(.iconOnly)
            }
        }
        .displayName("Omnesis")
        .description("Speak to Omnesis to ask a question or save a note.")
    }
}
