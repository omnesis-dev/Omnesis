// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
@testable import DesktopCore
import XCTest

final class ApplicationLaunchReservationTests: XCTestCase {
    private func fixture() throws -> (root: URL, cache: URL, app: URL, runtime: URL, epoch: String) {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-launch-fixture-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        let cache = base.appendingPathComponent("runtime")
        let archives = base.appendingPathComponent("applications")
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: archives, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        addTeardownBlock { try? FileManager.default.removeItem(at: base) }
        let data = Data(
            #"{"format":1,"codeUsageProtocol":1,"runtimeLauncher":"runtime-exec","inventory":[{"path":"node","executable":true},{"path":"runtime-exec","executable":true}]}"#
                .utf8
        )
        let epoch = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let runtime = cache.appendingPathComponent(epoch)
        let app = archives.appendingPathComponent(epoch).appendingPathComponent("Omnesis.app")
        let resources = app.appendingPathComponent("Contents/Resources/runtime")
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
        try data.write(to: resources.appendingPathComponent("desktop-runtime.json"))
        try data.write(to: runtime.appendingPathComponent("desktop-runtime.json"))
        return (archives, cache, app, runtime, epoch)
    }

    func testDurableReservationBlocksGCUntilActualMatchingLeaseAcknowledges() throws {
        let f = try fixture()
        let id = try DesktopApplicationLaunchReservation.reserve(
            application: f.app,
            epoch: f.epoch,
            archiveRoot: f.root,
            publicationRoot: f.cache,
            validate: { _ in }
        )
        let path = f.root.appendingPathComponent(".launch-reservations/\(id).json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: path.path))
        XCTAssertNil(try DesktopRuntimeUsageLease.withReclaimableEpoch(
            cache: f.cache,
            epoch: f.epoch,
            currentEpoch: String(repeating: "0", count: 64),
            operation: { _ in true }
        ))
        let lease = try DesktopRuntimeUsageLease.acquire(runtime: f.runtime)
        try DesktopApplicationLaunchReservation.acknowledge(
            id: id,
            application: f.app,
            runtime: f.runtime,
            lease: lease,
            archiveRoot: f.root,
            publicationRoot: f.cache
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: path.path))
    }

    func testAnotherApplicationCannotClearAnUncertainLaunch() throws {
        let f = try fixture()
        let id = try DesktopApplicationLaunchReservation.reserve(
            application: f.app,
            epoch: f.epoch,
            archiveRoot: f.root,
            publicationRoot: f.cache,
            validate: { _ in }
        )
        let lease = try DesktopRuntimeUsageLease.acquire(runtime: f.runtime)
        XCTAssertThrowsError(try DesktopApplicationLaunchReservation.acknowledge(
            id: id,
            application: f.root.appendingPathComponent("Other.app"),
            runtime: f.runtime,
            lease: lease,
            archiveRoot: f.root,
            publicationRoot: f.cache
        ))
        XCTAssertTrue(FileManager.default.fileExists(atPath: f.root.appendingPathComponent(".launch-reservations/\(id).json").path))
    }

    func testInvalidEpochNeverCreatesAReservation() throws {
        let f = try fixture()
        XCTAssertThrowsError(try DesktopApplicationLaunchReservation.reserve(
            application: f.app,
            epoch: String(repeating: "b", count: 64),
            archiveRoot: f.root,
            publicationRoot: f.cache,
            validate: { _ in }
        ))
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.root.appendingPathComponent(".launch-reservations").path))
    }
}
