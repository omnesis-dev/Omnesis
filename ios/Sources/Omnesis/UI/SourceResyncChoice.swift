// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// What the Resync action of a source offers, in which words, and which
// gateway requests carry it out. UIKit-free so the `swift test` lane covers
// it; the portal and Android print the same strings.

/// How a resync treats what the source already indexed.
public enum SourceResyncMode: String, CaseIterable, Equatable, Sendable {
    /// Nothing is deleted: the source is read again and each item updates
    /// the record it already has.
    case inPlace = "in-place"
    /// Everything the source indexed is deleted, then imported again.
    case fromScratch = "from-scratch"
}

/// What the Resync action of one source can do on the paired gateway.
enum SourceResyncOffer: Equatable {
    /// The source cannot be resynced: no Resync action is shown.
    case unavailable
    /// The gateway predates resync modes. Its resync always deletes first,
    /// so only that is offered, behind a plain confirmation.
    case wipeOnly
    /// The gateway resyncs in any of `modes`, listed in the order shown.
    case choice([SourceResyncMode])

    /// The offer for a source whose listing carries `resyncModes`: nil from
    /// a gateway that predates the field, empty for a source that cannot be
    /// resynced. A mode this build does not know is not offered.
    init(resyncModes: [String]?) {
        guard let resyncModes else {
            self = .wipeOnly
            return
        }
        let known = SourceResyncMode.allCases.filter { resyncModes.contains($0.rawValue) }
        self = known.isEmpty ? .unavailable : .choice(known)
    }

    /// The mode a choice opens on: in place when offered, since it is the
    /// one that deletes nothing.
    var defaultMode: SourceResyncMode? {
        guard case .choice(let modes) = self else { return nil }
        return modes.contains(.inPlace) ? .inPlace : modes.first
    }
}

/// One gateway request of a resync.
enum SourceResyncStep: Equatable {
    /// `POST /admin/sources/:id/resync` with the mode.
    case resync(SourceResyncMode)
    /// `POST /documents/delete-all/source/:id`.
    case deleteAll
    /// `POST /admin/sources/:id/sync`.
    case sync
}

enum SourceResyncError: Error, Equatable {
    /// The gateway cannot resync this source the way that was asked.
    case notOffered
}

/// The requests that resync a source in `mode`. A gateway with resync modes
/// takes the mode on its resync route. One that predates them has no route
/// that takes a mode, so it gets the delete followed by a sync, and only for
/// a resync from scratch: it cannot resync in place.
func sourceResyncSteps(offer: SourceResyncOffer, mode: SourceResyncMode) throws -> [SourceResyncStep] {
    switch offer {
    case .choice(let modes) where modes.contains(mode):
        return [.resync(mode)]
    case .wipeOnly where mode == .fromScratch:
        return [.deleteAll, .sync]
    default:
        throw SourceResyncError.notOffered
    }
}

/// One mode as the Resync sheet lists it.
struct SourceResyncOption: Equatable, Identifiable {
    let mode: SourceResyncMode
    let title: String
    let body: String
    /// A caution shown under the body, when there is one.
    let note: String?

    var id: SourceResyncMode {
        mode
    }
}

enum SourceResyncCopy {
    static let cancel = "Cancel"
    static let footnote = "In place never deletes, so it does not clear duplicate or stray records. "
        + "From scratch is the tool for that."

    /// The confirmation on a gateway that predates resync modes, where a
    /// resync always deletes first.
    static let wipeOnlyTitle = "Resync this source?"
    static let wipeOnlyMessage = "All ingested documents for this source will be deleted and re-fetched from scratch. "
        + "Large sources can take a while."

    static func title(sourceName: String) -> String {
        "Resync \(sourceName)"
    }

    static func confirm(_ mode: SourceResyncMode) -> String {
        mode == .fromScratch ? "Delete and resync" : "Resync"
    }

    /// The sheet's entry for `mode`. `brainNote` says whether the gateway
    /// runs the Brain, so that from scratch says what it does to what the
    /// Brain built.
    static func option(_ mode: SourceResyncMode, sourceName: String, brainNote: Bool) -> SourceResyncOption {
        switch mode {
        case .inPlace:
            SourceResyncOption(
                mode: mode,
                title: "In place",
                body: "Reads \(sourceName) again and updates what is already here. Your records keep their place, "
                    + "anything you deleted stays deleted, and search keeps working meanwhile.",
                note: nil
            )
        case .fromScratch:
            SourceResyncOption(
                mode: mode,
                title: "From scratch",
                body: "Deletes everything indexed from \(sourceName), then imports it again. Search for this source "
                    + "is empty until it finishes, and items you had deleted one by one come back.",
                note: brainNote
                    ? "What the Brain built from \(sourceName) will point at records that no longer exist."
                    : nil
            )
        }
    }

    /// The line under the options: shown when both modes are offered, since
    /// it tells them apart.
    static func footnote(modes: [SourceResyncMode]) -> String? {
        modes.contains(.inPlace) && modes.contains(.fromScratch) ? footnote : nil
    }
}

/// Whether a from-scratch resync should say what it does to what the Brain
/// built: only on an experimental gateway with the Brain switched on.
func sourceResyncBrainNote(status: StatusSnapshot?) -> Bool {
    guard let status else { return false }
    return status.experimental && status.brainEnabled
}
