// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class ApplicationArchiveTests: XCTestCase {
    private func fixture() throws -> (app: URL, root: URL, publication: URL, epoch: String) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-app-archive-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        let app = directory.appendingPathComponent("source/Omnesis.app")
        let resources = app.appendingPathComponent("Contents/Resources/runtime")
        let binary = app.appendingPathComponent("Contents/MacOS/Omnesis")
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("fictional native executable".utf8).write(to: binary)
        try Data(#"{"fixture":"public code manifest"}"#.utf8).write(to: resources.appendingPathComponent("desktop-runtime.json"))
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return try (
            app,
            directory.appendingPathComponent("code/applications"),
            directory.appendingPathComponent("code/runtime"),
            DesktopApplicationArchive.runtimeEpoch(app)
        )
    }

    private func validateFixture(_ app: URL) throws {
        let bytes = try Data(contentsOf: app.appendingPathComponent("Contents/MacOS/Omnesis"))
        guard bytes == Data("fictional native executable".utf8) else { throw CocoaError(.fileReadCorruptFile) }
    }

    func testRetainsFullApplicationBeforeOriginalIsReplaced() throws {
        let f = try fixture()
        let saved = try DesktopApplicationArchive.retain(
            application: f.app,
            epoch: f.epoch,
            root: f.root,
            publicationRoot: f.publication,
            validate: validateFixture
        )
        try FileManager.default.removeItem(at: f.app)
        XCTAssertEqual(saved, f.root.appendingPathComponent(f.epoch).appendingPathComponent("Omnesis.app"))
        XCTAssertEqual(try DesktopApplicationArchive.runtimeEpoch(saved), f.epoch)
        try validateFixture(saved)
    }

    func testReusesOnlyExistingValidatedCopy() throws {
        let f = try fixture()
        let first = try DesktopApplicationArchive.retain(
            application: f.app,
            epoch: f.epoch,
            root: f.root,
            publicationRoot: f.publication,
            validate: validateFixture
        )
        XCTAssertEqual(
            try DesktopApplicationArchive
                .retain(application: f.app, epoch: f.epoch, root: f.root, publicationRoot: f.publication, validate: validateFixture),
            first
        )
        try Data("tampered".utf8).write(to: first.appendingPathComponent("Contents/MacOS/Omnesis"))
        XCTAssertThrowsError(try DesktopApplicationArchive.retain(
            application: f.app,
            epoch: f.epoch,
            root: f.root,
            publicationRoot: f.publication,
            validate: validateFixture
        ))
        XCTAssertEqual(try String(contentsOf: first.appendingPathComponent("Contents/MacOS/Omnesis"), encoding: .utf8), "tampered")
    }

    func testDifferentRuntimeEpochCannotBorrowArchiveIdentity() throws {
        let f = try fixture()
        XCTAssertThrowsError(try DesktopApplicationArchive.retain(
            application: f.app,
            epoch: String(repeating: "b", count: 64),
            root: f.root,
            publicationRoot: f.publication,
            validate: validateFixture
        ))
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.root.appendingPathComponent(String(repeating: "b", count: 64)).path))
    }

    func testSymbolicLinkCacheRootIsNeverFollowed() throws {
        let f = try fixture()
        let outside = f.root.deletingLastPathComponent().appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: f.root.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: f.root, withDestinationURL: outside)
        XCTAssertThrowsError(try DesktopApplicationArchive.retain(
            application: f.app,
            epoch: f.epoch,
            root: f.root,
            publicationRoot: f.publication,
            validate: validateFixture
        ))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
    }
}
