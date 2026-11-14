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
/// portal use the same ones: a question about the device, with a code the owner looks at.
public enum PairingApprovalPresentation {
    public static let approve = "Yes, approve"
    public static let deny = "No, deny"
    public static let title = "Waiting for your OK"
    public static let empty = "No devices are waiting for your OK."
    /// On the waiting device itself, above its code.
    public static let waitingDevice = "Approve this device from a device you already use. Make sure it shows this same code."
    /// Above the code of a device the owner removed before.
    public static let revoked = "You removed this device before. Approve only if it's back in your hands."
    /// What the owner can do right after denying a device they don't recognise.
    public static let denied = "Denied. If you didn't try to connect a device, someone may know your Google password."
    public static let askFirst = "Make new devices always ask me"
    public static let askingFirst = "New devices now always ask you first."
    public static let rememberDetail = "Next time you sign in with it in the Omnesis app, your device connects without asking."

    /// The headline of one waiting device: its own name, which it chose, so only ever shown as a name.
    public static func headline(_ name: String) -> String {
        "\(name) wants to connect"
    }

    /// The question above the code, naming the kind of device the owner should look at.
    public static func question(kind: String) -> String {
        "Does the \(deviceNoun(kind)) show this code?"
    }

    /// "Remember this Google account" or "Remember this passkey": the sign-in, not the device.
    public static func remember(signIn: String?) -> String {
        signIn == "passkey" ? "Remember this passkey" : "Remember this Google account"
    }

    /// The kind of device in words a person uses for the thing in their hand.
    public static func deviceNoun(_ kind: String) -> String {
        switch kind {
        case "ios": "iPhone"
        case "android": "phone"
        case "portal": "browser"
        default: "computer"
        }
    }
}

/// The waiting screen on the device that asks to connect: one state, one code, one way out.
public enum PairingWaitingPresentation {
    public static let title = "Waiting for your OK"
    /// Approval happens on something the owner already has; this iPhone says where.
    public static let fromAnotherDevice = "Approve this iPhone from a device you already use:"
    public static let places = ["the Omnesis portal on your computer, or", "the Omnesis app on another phone."]
    public static let codeLead = "It will show this code:"
    /// When the gateway can approve with the owner's confirmed passkey on its own page.
    public static let withFaceID = "Approve this iPhone with Face ID on your gateway's secure page. It will show this code:"
    public static let approveWithFaceID = "Approve with Face ID"
    /// Approved by a gateway this iPhone could not verify on its own: the person confirms the codes.
    public static let compare = "Approved. Continue only if the device you approved on showed this same code."
    public static let confirm = "Codes match, connect this iPhone"
    public static let connecting = "Connecting…"
    public static let approved = "Approved. Connecting this iPhone…"
    public static let cancel = "Cancel"

    /// "Expires in 4:32", or "Expired" once the gateway stopped waiting.
    public static func expiry(remaining: TimeInterval) -> String {
        let seconds = Int(remaining.rounded(.down))
        guard seconds > 0 else { return "Expired. Cancel and sign in again." }
        return String(format: "Expires in %d:%02d", seconds / 60, seconds % 60)
    }
}
