// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppIntents
import SwiftUI
import WidgetKit

/// Widget extension for the Control Center / Lock Screen "Tell the
/// Brain" control. Its button fires the shared
/// `OpenCaptureControlIntent` (compiled into both the app and this
/// extension — see `ios/project.yml`).
///
/// This extension is deliberately dumb: no gateway access, no keychain,
/// no shared state. It only launches the app into capture, so it needs
/// no entitlements and can't leak anything.
@main
struct OmnesisWidgetsBundle: WidgetBundle {
    var body: some Widget {
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
                // Custom monochrome symbol: the Omnesis mark with a
                // microphone inside (`Resources/BrandSymbols.xcassets`).
                // Control Center renders control glyphs as a tinted
                // template, so this is the brand mark's silhouette, not
                // the full-color logo.
                Label("Tell Omnesis", image: "omnesis.mic")
            }
        }
        .displayName("Tell Omnesis")
        .description("Open Omnesis quick capture, listening immediately.")
    }
}
