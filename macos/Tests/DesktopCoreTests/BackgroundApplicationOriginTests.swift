// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class BackgroundApplicationOriginTests: XCTestCase {
    private func fixture(_ body: (URL, URL) throws -> Void) throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("owned-app-origin-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let root = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(path.path), isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root, root.appendingPathComponent("retained", isDirectory: true))
    }

    private func app(_ parent: URL, name: String, payload: String) throws -> URL {
        let application = parent.appendingPathComponent(name + ".app", isDirectory: true)
        let runtime = application.appendingPathComponent("Contents/Resources/runtime", isDirectory: true)
        try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
        try Data(payload.utf8).write(to: runtime.appendingPathComponent("desktop-runtime.json"))
        return application
    }

    func testReferenceFollowsExactMovedObjectAndDoesNotAdoptReplacementAtOldPath() throws {
        try fixture { root, archive in
            let original = try app(root, name: "Selected", payload: "invented-version-one")
            let record = try DesktopBackgroundApplicationOrigin.capture(original, archiveRoot: archive, validate: { _ in })
            let moved = root.appendingPathComponent("Moved.app")
            try FileManager.default.moveItem(at: original, to: moved)
            let replacement = try app(root, name: "Selected", payload: "invented-version-two")
            XCTAssertEqual(
                try DesktopBackgroundApplicationOrigin.resolve(record, archiveRoot: archive, validate: { _ in }).path,
                moved.path
            )
            let newer = try DesktopBackgroundApplicationOrigin.capture(replacement, archiveRoot: archive, validate: { _ in })
            XCTAssertNotEqual(record.inode, newer.inode)
            XCTAssertNotEqual(record.observedEpoch, newer.observedEpoch)
            try FileManager.default.removeItem(at: moved)
            XCTAssertThrowsError(try DesktopBackgroundApplicationOrigin.resolve(record, archiveRoot: archive, validate: { _ in }))
        }
    }

    func testRetainedCodeNeverBecomesInstalledOriginAndUnsignedValidationFailurePropagates() throws {
        try fixture { root, archive in
            let retained = try app(archive, name: "Archived", payload: "invented-retained-code")
            var validated = false
            XCTAssertThrowsError(try DesktopBackgroundApplicationOrigin.capture(
                retained,
                archiveRoot: archive,
                validate: { _ in validated = true }
            ))
            XCTAssertFalse(validated)
            let selected = try app(root, name: "Selected", payload: "invented-code")
            XCTAssertThrowsError(try DesktopBackgroundApplicationOrigin.capture(selected, archiveRoot: archive, validate: { _ in
                throw DesktopBackgroundPeerTrust.Failure.untrustedPeer
            }))
        }
    }

    func testCodeAndOriginEpochRemainSeparateAndRetainedRollbackIsInstallationNeeded() throws {
        try fixture { root, archive in
            let installed = try app(root, name: "Installed", payload: "invented-installed-candidate")
            let rollback = try app(archive, name: "Rollback", payload: "invented-recovered-version")
            let record = try DesktopBackgroundApplicationOrigin.capture(installed, archiveRoot: archive, validate: { _ in })
            let code = try DesktopApplicationArchive.runtimeEpoch(rollback)
            let evidence = try DesktopBackgroundApplicationOrigin.evidence(
                record: record,
                codeEpoch: code,
                presentationApplication: rollback,
                awaitingHandoff: false,
                archiveRoot: archive,
                validate: { _ in }
            )
            XCTAssertEqual(evidence.state, .verified)
            XCTAssertEqual(evidence.codeEpoch, code)
            XCTAssertEqual(evidence.originEpoch, record.observedEpoch)
            XCTAssertEqual(evidence.presentation, .retained)
            XCTAssertEqual(evidence.installation, .recoveredVersionInstallNeeded)
            let current = try DesktopBackgroundApplicationOrigin.evidence(
                record: record,
                codeEpoch: record.observedEpoch,
                presentationApplication: installed,
                awaitingHandoff: false,
                archiveRoot: archive,
                validate: { _ in }
            )
            XCTAssertEqual(current.installation, .current)
            let other = try app(root, name: "AnotherCopy", payload: "invented-installed-candidate")
            let unrelated = try DesktopBackgroundApplicationOrigin.evidence(
                record: record,
                codeEpoch: record.observedEpoch,
                presentationApplication: other,
                awaitingHandoff: false,
                archiveRoot: archive,
                validate: { _ in }
            )
            XCTAssertNotEqual(unrelated.installation, .current)
        }
    }

    func testMissingOriginIsIncompleteEvenWithMatchingCodeEpoch() throws {
        let value = try DesktopBackgroundApplicationOrigin.evidence(
            record: nil,
            codeEpoch: String(repeating: "a", count: 64),
            presentationApplication: nil,
            awaitingHandoff: true
        )
        XCTAssertEqual(value.state, .handoffRequired)
        XCTAssertEqual(value.installation, .unknown)
        XCTAssertNil(value.originEpoch)
    }

    func testPlainPathAndChangedManifestCannotForgeOriginContinuity() throws {
        try fixture { root, archive in
            let selected = try app(root, name: "Selected", payload: "invented-original-code")
            let record = try DesktopBackgroundApplicationOrigin.capture(selected, archiveRoot: archive, validate: { _ in })
            let forged = DesktopBackgroundApplicationOrigin.Record(
                version: record.version,
                referenceURL: selected.absoluteString,
                device: record.device,
                inode: record.inode,
                observedEpoch: record.observedEpoch,
                revision: record.revision
            )
            XCTAssertThrowsError(try DesktopBackgroundApplicationOrigin.resolve(forged, archiveRoot: archive, validate: { _ in }))
            try Data("invented-changed-code".utf8)
                .write(to: selected.appendingPathComponent("Contents/Resources/runtime/desktop-runtime.json"))
            XCTAssertThrowsError(try DesktopBackgroundApplicationOrigin.resolve(record, archiveRoot: archive, validate: { _ in }))
        }
    }

    func testCanonicalTrashChecksFollowObjectsInsteadOfAliasLocation() throws {
        try fixture { root, _ in
            let trash = root.appendingPathComponent("InventedTrash")
            try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
            let outside = try app(root, name: "Outside", payload: "invented-code")
            let misleading = trash.appendingPathComponent("Alias.app")
            try FileManager.default.createSymbolicLink(at: misleading, withDestinationURL: outside)
            XCTAssertFalse(try DesktopBackgroundApplicationOrigin.canonicalTrashContains(misleading, trash: trash))
            let inside = try app(trash, name: "Inside", payload: "invented-code")
            let alias = root.appendingPathComponent("OutsideAlias.app")
            try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: inside)
            XCTAssertTrue(try DesktopBackgroundApplicationOrigin.canonicalTrashContains(alias, trash: trash))
            XCTAssertTrue(try DesktopBackgroundApplicationOrigin.canonicalTrashContains(inside, trash: trash))
        }
    }
}
