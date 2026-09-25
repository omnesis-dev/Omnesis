// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How one step of phone setup ended. The page renders the outcome in place
/// of the step's ledger and action, and Finish summarises them.
public enum PhoneSetupOutcome: Equatable, Codable, Sendable {
    /// The source is on with everything it needs.
    case on
    /// The source is on for a subset the user picked, such as selected photos.
    case limited
    /// The source is on but misses data, such as location only while open.
    case partial
    /// The operating system refused access, so nothing was turned on.
    case notAllowed
    /// This device cannot provide the source.
    case unavailable(reason: String)
    /// Another device hosts the source and the user has to decide how this
    /// one contributes before anything changes.
    case choiceRequired(SourceMultiDeviceMode)
    /// The change did not happen; `message` is readable copy when known.
    case failed(message: String?)
    /// The step ended without turning anything on and needs no page of its
    /// own, such as leaving a source with the device that already sends it.
    case skipped

    public init(_ result: MobileSourceEnableResult) {
        self = switch result {
        case .enabled(let grant): Self(grant)
        case .notAllowed: .notAllowed
        case .unavailable(let reason): .unavailable(reason: reason)
        case .keptOther: .skipped
        case .choiceRequired(let mode): .choiceRequired(mode)
        case .failed(let message): .failed(message: message)
        }
    }

    public init(_ grant: MobileSourceGrant) {
        self = switch grant {
        case .full: .on
        case .limited: .limited
        case .foregroundOnly: .partial
        }
    }

    /// The outcome the device's current state implies, or `nil` when the state
    /// says nothing yet (access never requested, or granted to a source that
    /// is still off). Used when the flow resumes and when the user comes back
    /// from iOS Settings.
    public static func live(enabled: Bool, authorization: MobileSourceAuthorization?) -> PhoneSetupOutcome? {
        switch authorization {
        case nil: nil
        case .granted(let grant): enabled ? Self(grant) : nil
        case .notAllowed: .notAllowed
        case .unavailable(let reason): .unavailable(reason: reason)
        case .failed: nil
        }
    }

    /// The source contributes data, fully or with limits.
    public var isContributing: Bool {
        switch self {
        case .on, .limited, .partial: true
        case .notAllowed, .unavailable, .choiceRequired, .failed, .skipped: false
        }
    }

    /// The outcome to keep for a step that recorded `self`, now that the
    /// device's state implies `live`. An outcome that describes device state
    /// (a permission, a source switch) is replaced by whatever that state now
    /// says, including nothing. A decision or an error stays until the device
    /// says something more specific, and leaving a source with another device
    /// always stands.
    public func reconciled(with live: PhoneSetupOutcome?) -> PhoneSetupOutcome? {
        switch self {
        case .skipped: self
        case .on, .limited, .partial, .notAllowed: live
        case .unavailable, .choiceRequired, .failed: live ?? self
        }
    }
}
