// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How a device joined, in the words the Devices screen uses. The portal uses the same ones.
public enum DeviceJoinPresentation {
    /// A device that joined by signing in reads the same whatever the sign-in was.
    public static func joinLabel(_ enrollment: DeviceEnrollmentInfo) -> String? {
        switch enrollment.method {
        case "approved": "Approved"
        case "automatic": "Joined with Omnesis account"
        default: nil
        }
    }

    /// The sign-in a waiting device used, as one word beside its kind.
    public static func signInMethod(_ signIn: String?) -> String? {
        switch signIn {
        case "google": "Google"
        case "passkey": "Passkey"
        default: nil
        }
    }
}

/// The words for a device that signed in and waits for the owner. The Android app and the
/// portal use the same ones.
public enum PairingApprovalPresentation {
    public static let explanation = "A device signed in to your Omnesis account and is waiting for your approval to pair "
        + "to this gateway. Approve if the code below matches the code shown on the device."
    /// On the waiting device itself, above its code.
    public static let waitingDevice = "Check that this code matches the one shown on your other device, then approve it there."
    public static let approve = "Approve"
    public static let deny = "Deny"
    public static let title = "Pairing requests"
    public static let empty = "No pending pairing requests."
}
