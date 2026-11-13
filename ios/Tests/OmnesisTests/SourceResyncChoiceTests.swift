// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// What a source's Resync action offers, says and sends, from the
/// `resyncModes` its gateway lists.
final class SourceResyncChoiceTests: XCTestCase {
    private func record(_ extra: String) throws -> SourceRecord {
        let json = """
        {"id":"gmail:maya.reeves@example.org","type":"gmail","accountId":"maya.reeves@example.org",
        "deviceId":"dev_1","config":{},"enabled":true,"createdAt":0,"updatedAt":0\(extra)}
        """
        return try JSONDecoder().decode(SourceRecord.self, from: Data(json.utf8))
    }

    private func status(experimental: Bool, lab: LabFlags?) -> StatusSnapshot {
        StatusSnapshot(
            documents: StatusSnapshot.Documents(total: 0, bySource: [:], unitCountBySource: nil),
            dbSizeBytes: nil,
            latestActivityBySource: nil,
            experimental: experimental,
            lab: lab
        )
    }

    func testListingDecodesResyncModes() throws {
        XCTAssertEqual(try record(#","resyncModes":["in-place","from-scratch"]"#).resyncModes, ["in-place", "from-scratch"])
        XCTAssertEqual(try record(#","resyncModes":[]"#).resyncModes, [])
        XCTAssertNil(try record("").resyncModes)
    }

    func testOfferFollowsTheListing() {
        XCTAssertEqual(SourceResyncOffer(resyncModes: nil), .wipeOnly)
        XCTAssertEqual(SourceResyncOffer(resyncModes: []), .unavailable)
        XCTAssertEqual(SourceResyncOffer(resyncModes: ["from-scratch", "in-place"]), .choice([.inPlace, .fromScratch]))
        XCTAssertEqual(SourceResyncOffer(resyncModes: ["in-place"]), .choice([.inPlace]))
        XCTAssertEqual(SourceResyncOffer(resyncModes: ["from-scratch", "sideways"]), .choice([.fromScratch]))
        XCTAssertEqual(SourceResyncOffer(resyncModes: ["sideways"]), .unavailable)
    }

    func testChoiceOpensOnInPlace() {
        XCTAssertEqual(SourceResyncOffer.choice([.inPlace, .fromScratch]).defaultMode, .inPlace)
        XCTAssertEqual(SourceResyncOffer.choice([.fromScratch]).defaultMode, .fromScratch)
        XCTAssertNil(SourceResyncOffer.wipeOnly.defaultMode)
        XCTAssertNil(SourceResyncOffer.unavailable.defaultMode)
    }

    func testGatewayWithModesGetsOneRequestCarryingTheMode() throws {
        let offer = SourceResyncOffer.choice([.inPlace, .fromScratch])
        XCTAssertEqual(try sourceResyncSteps(offer: offer, mode: .inPlace), [.resync(.inPlace)])
        XCTAssertEqual(try sourceResyncSteps(offer: offer, mode: .fromScratch), [.resync(.fromScratch)])
    }

    func testOlderGatewayGetsTheDeleteThenTheSync() throws {
        XCTAssertEqual(try sourceResyncSteps(offer: .wipeOnly, mode: .fromScratch), [.deleteAll, .sync])
    }

    func testAModeTheGatewayCannotDoIsRefused() {
        XCTAssertThrowsError(try sourceResyncSteps(offer: .wipeOnly, mode: .inPlace)) {
            XCTAssertEqual($0 as? SourceResyncError, .notOffered)
        }
        XCTAssertThrowsError(try sourceResyncSteps(offer: .unavailable, mode: .fromScratch))
        XCTAssertThrowsError(try sourceResyncSteps(offer: .choice([.inPlace]), mode: .fromScratch))
    }

    func testCopyNamesTheSourceAndMatchesThePortal() {
        XCTAssertEqual(SourceResyncCopy.title(sourceName: "Gmail"), "Resync Gmail")
        let inPlace = SourceResyncCopy.option(.inPlace, sourceName: "Gmail", brainNote: true)
        XCTAssertEqual(inPlace.title, "In place")
        XCTAssertEqual(
            inPlace.body,
            "Reads Gmail again and updates what is already here. Your records keep their place, "
                + "anything you deleted stays deleted, and search keeps working meanwhile."
        )
        XCTAssertNil(inPlace.note)
        let fromScratch = SourceResyncCopy.option(.fromScratch, sourceName: "Gmail", brainNote: false)
        XCTAssertEqual(fromScratch.title, "From scratch")
        XCTAssertEqual(
            fromScratch.body,
            "Deletes everything indexed from Gmail, then imports it again. Search for this source "
                + "is empty until it finishes, and items you had deleted one by one come back."
        )
        XCTAssertNil(fromScratch.note)
        XCTAssertEqual(SourceResyncCopy.confirm(.inPlace), "Resync")
        XCTAssertEqual(SourceResyncCopy.confirm(.fromScratch), "Delete and resync")
    }

    func testBrainLineSitsUnderFromScratchOnlyWhenAsked() {
        XCTAssertEqual(
            SourceResyncCopy.option(.fromScratch, sourceName: "Gmail", brainNote: true).note,
            "What the Brain built from Gmail will point at records that no longer exist."
        )
        XCTAssertNil(SourceResyncCopy.option(.fromScratch, sourceName: "Gmail", brainNote: false).note)
    }

    func testFootnoteNeedsBothModes() {
        XCTAssertEqual(
            SourceResyncCopy.footnote(modes: [.inPlace, .fromScratch]),
            "In place never deletes, so it does not clear duplicate or stray records. From scratch is the tool for that."
        )
        XCTAssertNil(SourceResyncCopy.footnote(modes: [.inPlace]))
        XCTAssertNil(SourceResyncCopy.footnote(modes: [.fromScratch]))
    }

    func testBrainNoteNeedsAnExperimentalGatewayWithTheBrainOn() {
        XCTAssertTrue(sourceResyncBrainNote(status: status(experimental: true, lab: LabFlags(brain: true))))
        XCTAssertFalse(sourceResyncBrainNote(status: status(experimental: true, lab: LabFlags(brain: false, tasks: true))))
        XCTAssertFalse(sourceResyncBrainNote(status: status(experimental: false, lab: LabFlags(brain: true))))
        XCTAssertFalse(sourceResyncBrainNote(status: status(experimental: false, lab: nil)))
        XCTAssertFalse(sourceResyncBrainNote(status: nil))
    }
}
