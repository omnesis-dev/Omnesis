// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What the Photos setup step needs from the app.
@MainActor
public protocol PhotosSetupHost: AnyObject {
    var photosEnabled: Bool { get }
    var photosAccess: PhotosAccessState { get }
    func enablePhotos(activationChoice: MobileSourceActivationChoice?) async -> MobileSourceEnableResult
}

/// Photos' page in phone setup.
public struct PhotosSetupStep: PhoneSetupStep {
    public static let sourceId = "photos:local"

    public static let copy = PhoneSetupCopy(
        title: "Photos",
        row: "What's in them, never the images",
        value: "Find anything you photographed by what's in it. "
            + "Omnesis looks at your photos on this iPhone and sends only what it finds.",
        ask: "Find the receipt from the bike shop.",
        ledger: PhoneSetupLedger(
            sent: [
                "Text found in the image",
                "A one-sentence description",
                "Scene labels",
                "QR and barcode contents",
                "Date taken",
                "Place and coordinates",
            ],
            staysLabel: "Stays on this iPhone",
            stays: ["The photos themselves"]
        ),
        fine: "You can allow all photos or a selection, and add more later.",
        permissionLabel: "photo access",
        onBody: "Your photos are read in the background, even while Omnesis is closed.",
        limitedBody: "Omnesis can read the photos you chose.",
        onTitle: "Photos are on",
        offTitle: "Photos are off",
        notAllowedSettingsSteps: "In Settings, tap Photos and choose Full Access.",
        tint: 0x0A84FF,
        symbol: "photo.on.rectangle"
    )

    unowned let host: any PhotosSetupHost

    public var id: String {
        Self.sourceId
    }

    public var group: PhoneSetupStepGroup {
        .source
    }

    public var copy: PhoneSetupCopy {
        Self.copy
    }

    public var rowState: PhoneSetupRowState {
        host.photosEnabled ? .alreadyOn : .selectable
    }

    public var authorization: MobileSourceAuthorization? {
        host.photosAccess.setupAuthorization
    }

    public var needsBackgroundRefresh: Bool {
        true
    }

    public func enable(choice: MobileSourceActivationChoice?) async -> PhoneSetupOutcome {
        await PhoneSetupOutcome(host.enablePhotos(activationChoice: choice))
    }

    public func currentOutcome() -> PhoneSetupOutcome? {
        .live(enabled: host.photosEnabled, authorization: host.photosAccess.setupAuthorization)
    }

    public func choices(for mode: SourceMultiDeviceMode) -> [PhoneSetupChoice] {
        Self.choices(for: mode)
    }

    /// Photo-library identifiers differ between devices, so only one device
    /// indexes Photos at a time. Setup and Settings offer the same two ways
    /// out.
    public static func choices(for _: SourceMultiDeviceMode) -> [PhoneSetupChoice] {
        [
            PhoneSetupChoice(
                choice: .keepOther,
                title: "Keep using the other device",
                detail: "Nothing changes, and this iPhone will not ask for photo access."
            ),
            PhoneSetupChoice(
                choice: .takeOver,
                title: "Use only this iPhone",
                detail: "Photos moves to this iPhone, and the other device stops indexing them."
            ),
        ]
    }
}

extension PhotosAccessState {
    /// What this access level means for turning Photos on, or `nil` before
    /// iOS has asked.
    public var setupAuthorization: MobileSourceAuthorization? {
        switch self {
        case .full: .granted(.full)
        case .limited: .granted(.limited)
        case .denied, .restricted: .notAllowed
        case .notDetermined: nil
        }
    }
}
