// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreFoundation
import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class BackgroundReferenceRepresentationTests: XCTestCase {
    private func fixture(_ body: (URL, URL) throws -> Void) throws {
        let temporary = URL(fileURLWithPath: "/tmp", isDirectory: true)
            .appendingPathComponent("origin-reference-regression-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let root = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(temporary.path))
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root, root.appendingPathComponent("archive"))
    }

    private func app(_ root: URL, name: String) throws -> URL {
        let application = root.appendingPathComponent(name + ".app", isDirectory: true)
        let runtime = application.appendingPathComponent("Contents/Resources/runtime", isDirectory: true)
        try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
        try Data("invented-identical-signed-payload".utf8).write(to: runtime.appendingPathComponent("desktop-runtime.json"))
        return application
    }

    func testProductionWireRemainsAReferenceAndResolvesMovedObjectInsteadOfIdenticalReplacement() throws {
        try fixture { root, archive in
            let original = try app(root, name: "Original")
            let record = try DesktopBackgroundApplicationOrigin.capture(original, archiveRoot: archive, validate: { _ in })
            let decoded = try JSONDecoder().decode(DesktopBackgroundApplicationOrigin.Record.self, from: JSONEncoder().encode(record))
            let reference = try XCTUnwrap(CFURLCreateWithString(kCFAllocatorDefault, decoded.referenceURL as CFString, nil))
            XCTAssertTrue(CFURLIsFileReferenceURL(reference), "The production wire must identify an object, not its former pathname")
            let moved = root.appendingPathComponent("Moved.app", isDirectory: true)
            try FileManager.default.moveItem(at: original, to: moved)
            let replacement = try app(root, name: "Original")
            XCTAssertEqual(
                try DesktopApplicationArchive.runtimeEpoch(replacement),
                record.observedEpoch,
                "Epoch alone cannot distinguish the replacement"
            )
            let resolved = try DesktopBackgroundApplicationOrigin.resolve(decoded, archiveRoot: archive, validate: { _ in })
            XCTAssertEqual(resolved.path, moved.path)
            XCTAssertNotEqual(resolved.path, replacement.path)
            try FileManager.default.removeItem(at: moved)
            XCTAssertThrowsError(try DesktopBackgroundApplicationOrigin.resolve(decoded, archiveRoot: archive, validate: { _ in }))
        }
    }

    func testReferenceCodecRefusesPathFallbackAndReferenceQueryOrFragment() throws {
        try fixture { root, archive in
            let original = try app(root, name: "Original")
            let record = try DesktopBackgroundApplicationOrigin.capture(original, archiveRoot: archive, validate: { _ in })
            for text in [original.absoluteString, record.referenceURL + "?untrusted=1", record.referenceURL + "#untrusted"] {
                let changed = DesktopBackgroundApplicationOrigin.Record(
                    version: record.version,
                    referenceURL: text,
                    device: record.device,
                    inode: record.inode,
                    observedEpoch: record.observedEpoch,
                    revision: record.revision
                )
                XCTAssertThrowsError(try DesktopBackgroundApplicationOrigin.resolve(changed, archiveRoot: archive, validate: { _ in }))
            }
        }
    }
}
