// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import XCTest

final class TarCompletionTests: XCTestCase {
    private func archive() throws -> Data {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("artifact-framing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data(repeating: 65, count: 1300).write(to: root.appendingPathComponent("fixture.txt"))
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = ["-cf", root.appendingPathComponent("fixture.tar").path, "-C", root.path, "fixture.txt"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        return try Data(contentsOf: root.appendingPathComponent("fixture.tar"))
    }

    func testSystemCreatedArchiveCompletesAcrossArbitraryStreamingBoundaries() throws {
        let bytes = try archive()
        for width in [1, 511, 513, 65536] {
            var verifier = DesktopTarCompletion()
            for index in stride(from: 0, to: bytes.count, by: width) {
                try verifier.append(bytes.subdata(in: index ..< min(index + width, bytes.count)))
            }
            try verifier.finish()
        }
    }

    func testCleanTruncationNeverBecomesACompletedArchive() throws {
        let bytes = try archive()
        for count in [1, 511, 512, 1024, bytes.count - 1] {
            var verifier = DesktopTarCompletion()
            try verifier.append(Data(bytes.prefix(count)))
            XCTAssertThrowsError(try verifier.finish(), "A clean transport EOF is not an archive terminator")
        }
    }

    func testCorruptHeaderAndBytesAfterTerminatorAreRefused() throws {
        var bytes = try archive()
        bytes[0] ^= 1
        var corrupt = DesktopTarCompletion()
        XCTAssertThrowsError(try corrupt.append(bytes))
        var complete = DesktopTarCompletion()
        try complete.append(Data(repeating: 0, count: 1024))
        try complete.finish()
        XCTAssertThrowsError(try complete.append(Data([1])))
        XCTAssertThrowsError(try complete.finish())
    }

    func testOversizedBinarySizeCannotOverflowFramingArithmetic() throws {
        var header = try Data(archive().prefix(512))
        header.replaceSubrange(124 ..< 136, with: [0x80, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0])
        header.replaceSubrange(148 ..< 156, with: Data(repeating: 32, count: 8))
        let checksum = header.reduce(UInt64(0)) { $0 + UInt64($1) }
        let field = String(format: "%06llo", checksum) + "\0 "
        header.replaceSubrange(148 ..< 156, with: Data(field.utf8))
        var verifier = DesktopTarCompletion()
        XCTAssertThrowsError(try verifier.append(header))
    }
}
