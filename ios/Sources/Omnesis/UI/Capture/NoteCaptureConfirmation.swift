// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
extension CaptureView {
    func confirmationTitle(_ outcome: NoteCaptureService.Outcome) -> String {
        switch outcome {
        case .saved: "Saved"
        case .queued(.unreachable): "Queued"
        case .queued(.featureOff), .queued(.unauthorized): "Saved on device"
        case .rejected, .failed: "Not saved"
        }
    }

    /// Honest per-cause copy for the queued confirmations, so the user
    /// knows whether waiting will fix it or whether the gateway needs
    /// their attention.
    func confirmationSubtitle(_ outcome: NoteCaptureService.Outcome) -> String? {
        switch outcome {
        case .saved: nil
        case .queued(.unreachable): "Delivers when your gateway is reachable"
        case .queued(.featureOff): "Update your gateway to sync quick captures"
        case .queued(.unauthorized): "Re-pair with your gateway to sync"
        case .rejected, .failed: nil
        }
    }
}
#endif
