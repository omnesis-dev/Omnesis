// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class KeyRecoveryWriterTests: XCTestCase {
    private let scope = DesktopDataUsageLease.Scope(
        configDir: "/example/library",
        instance: "desktop-" + String(repeating: "a", count: 16),
        secretService: "dev.omnesis.desktop." + String(repeating: "b", count: 64)
    )
    private let value = "omn_root_v1_" + Data(repeating: 7, count: 32).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")

    func testFixedPrivateCommandQuotesUnicodeAndEscapesWithoutVerboseOrUpdate() throws {
        let path = "/example/Library/Keychains/fictional é \\\".keychain-db"
        let line = try DesktopKeyRecoveryWriteOnly.line(
            account: "install-root-key-v1",
            scope: scope,
            value: Data(value.utf8),
            keychainPath: path
        )
        let text = String(decoding: line, as: UTF8.self)
        XCTAssertEqual(DesktopKeyRecoveryWriteOnly.arguments, ["/usr/bin/security", "-q", "-i"])
        XCTAssertFalse(DesktopKeyRecoveryWriteOnly.arguments.joined().contains(value))
        XCTAssertTrue(text.hasPrefix("\"add-generic-password\" \"-a\" \"install-root-key-v1\" "))
        XCTAssertTrue(text.contains("\"-T\" \"/usr/bin/security\""))
        XCTAssertFalse(text.contains("\"-U\""))
        XCTAssertFalse(text.contains("\"-A\""))
        XCTAssertTrue(text.contains("é"))
        XCTAssertTrue(text.contains("\\\\\\\""))
        let expected = #""add-generic-password" "-a" "install-root-key-v1" "-s" "#
            + "\"" + scope.secretService + "\" "
            + #""-l" "Omnesis install-root-key-v1" "-w" "#
            + "\"" + value + "\" "
            + #""-T" "/usr/bin/security" "/example/Library/Keychains/fictional é \\\".keychain-db""#
            + "\n"
        XCTAssertEqual(text, expected)
        XCTAssertEqual(line.filter { $0 == 10 }.count, 1)
        XCTAssertEqual(line.last, 10)
        XCTAssertFalse(text.contains("quit"))
    }

    func testForeignSelectorsDifferentMarkerAndControlOrOverlongPathRefuse() throws {
        for path in ["relative", "/example/\nother", "/example/\r", "/example/\0", "/" + String(repeating: "x", count: 4095)] {
            XCTAssertThrowsError(try DesktopKeyRecoveryWriteOnly.line(
                account: "install-root-key-v1",
                scope: scope,
                value: Data(value.utf8),
                keychainPath: path
            ))
        }
        XCTAssertThrowsError(try DesktopKeyRecoveryWriteOnly.line(
            account: "foreign",
            scope: scope,
            value: Data(value.utf8),
            keychainPath: "/example/keychain"
        ))
        let foreign = DesktopDataUsageLease.Scope(configDir: scope.configDir, instance: scope.instance, secretService: "foreign-service")
        XCTAssertThrowsError(try DesktopKeyRecoveryWriteOnly.line(
            account: "install-root-key-v1",
            scope: foreign,
            value: Data(value.utf8),
            keychainPath: "/example/keychain"
        ))
        for kind in ["storage-encryption", "secret-files"] {
            let suffix = Data(SHA256.hash(data: Data(scope.configDir.utf8))).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            let account = kind + "-state-v1:" + String(suffix.prefix(12))
            XCTAssertThrowsError(try DesktopKeyRecoveryWriteOnly.line(
                account: account,
                scope: scope,
                value: Data("different".utf8),
                keychainPath: "/example/keychain"
            ))
            XCTAssertNoThrow(try DesktopKeyRecoveryWriteOnly.line(
                account: account,
                scope: scope,
                value: Data("required".utf8),
                keychainPath: "/example/keychain"
            ))
        }
        XCTAssertThrowsError(try DesktopKeyRecoveryWriteOnly.line(
            account: "install-root-key-v1",
            scope: scope,
            value: Data("invalid-root".utf8),
            keychainPath: "/example/keychain"
        ))
    }

    func testCompleteLineBoundaryIsCheckedBeforeAnyChildCanStart() throws {
        let short = try DesktopKeyRecoveryWriteOnly.line(
            account: "install-root-key-v1",
            scope: scope,
            value: Data(value.utf8),
            keychainPath: "/a"
        )
        let path = "/a" + String(repeating: "x", count: 4095 - short.count)
        XCTAssertEqual(
            try DesktopKeyRecoveryWriteOnly.line(account: "install-root-key-v1", scope: scope, value: Data(value.utf8), keychainPath: path)
                .count,
            4095
        )
        XCTAssertThrowsError(try DesktopKeyRecoveryWriteOnly.line(
            account: "install-root-key-v1",
            scope: scope,
            value: Data(value.utf8),
            keychainPath: path + "x"
        ))
    }

    /// No Keychain command is sent: actual security -i receives only EOF after the lock assertion.
    func testFixedEmptyChildRetainsDataDescriptorUntilPhysicalExit() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("writer-fd-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let path = root.appendingPathComponent("lease").path
        var descriptor = Darwin.open(path, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
        var safeToRemove = true
        defer { if descriptor >= 0 { Darwin.close(descriptor) }
            if safeToRemove { try? FileManager.default.removeItem(at: root) }
        }
        XCTAssertEqual(flock(descriptor, LOCK_SH | LOCK_NB), 0)
        let competitor = Darwin.open(path, O_RDWR | O_CLOEXEC)
        guard competitor >= 0 else { throw DesktopKeyRecoveryAuthority.Failure.invalidRequest }
        defer { Darwin.close(competitor) }
        let child = try DesktopKeyRecoveryWriteOnly.launch(dataDescriptor: descriptor)
        safeToRemove = false
        Darwin.close(descriptor)
        descriptor = -1
        XCTAssertNotEqual(flock(competitor, LOCK_EX | LOCK_NB), 0, "Only the actual fixed child still owns DATA SH")
        let outcome = DesktopKeyRecoveryWriteOnly.drive(child, bytes: Data(), validate: {})
        safeToRemove = outcome.joined
        XCTAssertTrue(outcome.joined)
        XCTAssertFalse(outcome.success, "Empty input never proves a successful insertion")
        XCTAssertEqual(flock(competitor, LOCK_EX | LOCK_NB), 0, "Only physical child closure releases DATA SH")
    }

    func testActualClosedPrivatePipeFailsWithoutTerminatingTheWriterWithSigpipe() throws {
        var descriptors: [Int32] = [-1, -1]
        XCTAssertEqual(pipe(&descriptors), 0)
        defer { if descriptors[0] >= 0 { Darwin.close(descriptors[0]) }
            if descriptors[1] >= 0 { Darwin.close(descriptors[1]) }
        }
        try DesktopKeyRecoveryWriteOnly.prepareWriter(descriptors[1])
        Darwin.close(descriptors[0])
        descriptors[0] = -1
        if case .failed = DesktopKeyRecoveryWriteOnly.System.live.write(descriptors[1], Data("invented".utf8), 0) {} else {
            XCTFail("A closed private reader must be a bounded write failure")
        }
    }

    func testShortWritesDeliverOneCompleteLineAndCloseBeforePhysicalJoin() {
        let fixture = WriterSystem(writes: [.progress(2), .retry, .progress(2)], waits: [.running, .running, .joined(0, nil)])
        let outcome = DesktopKeyRecoveryWriteOnly.drive(
            .init(pid: 123, input: 45),
            bytes: Data("abc\n".utf8),
            validate: {},
            system: fixture.system
        )
        XCTAssertTrue(outcome.success)
        XCTAssertEqual(fixture.offsets, [0, 2, 2])
        XCTAssertEqual(fixture.closed, [45])
        XCTAssertTrue(fixture.signals.isEmpty)
    }

    func testPartialWriteFailureAndDeadlineStillEscalateAndJoinWithoutSuccess() {
        let fixture = WriterSystem(writes: [.progress(1), .failed], waits: [.running, .running, .running, .joined(nil, SIGKILL)], step: 3)
        let outcome = DesktopKeyRecoveryWriteOnly.drive(
            .init(pid: 123, input: 45),
            bytes: Data("abc\n".utf8),
            validate: {},
            system: fixture.system
        )
        XCTAssertTrue(outcome.joined)
        XCTAssertFalse(outcome.success)
        XCTAssertFalse(outcome.completeInput)
        XCTAssertEqual(fixture.signals, [SIGTERM, SIGKILL])
        XCTAssertEqual(fixture.closed, [45])
    }

    func testClockJumpPastDeadlinePreventsFurtherInputAndStillJoins() {
        let fixture = WriterSystem(
            writes: [.retry, .progress(4)],
            waits: [.running, .running, .joined(nil, SIGKILL)],
            step: 6
        )
        let outcome = DesktopKeyRecoveryWriteOnly.drive(
            .init(pid: 123, input: 45), bytes: Data("abc\n".utf8), validate: {}, system: fixture.system
        )
        XCTAssertEqual(fixture.offsets, [0], "No remaining command bytes may be written after the deadline")
        XCTAssertEqual(fixture.writes.count, 1)
        XCTAssertEqual(fixture.signals, [SIGTERM, SIGKILL])
        XCTAssertTrue(outcome.joined)
        XCTAssertFalse(outcome.success)
        XCTAssertEqual(fixture.closed, [45])
    }

    func testNoProgressTimesOutAndEarlyExitOrUncertainJoinNeverSucceed() {
        let deadline = WriterSystem(
            writes: [.retry, .retry, .retry, .retry],
            waits: [.running, .running, .running, .joined(nil, SIGKILL)],
            step: 3
        )
        XCTAssertFalse(DesktopKeyRecoveryWriteOnly.drive(
            .init(pid: 123, input: 45),
            bytes: Data("abc\n".utf8),
            validate: {},
            system: deadline.system
        ).success)
        XCTAssertEqual(deadline.signals, [SIGTERM, SIGKILL])
        let early = WriterSystem(writes: [.progress(1)], waits: [.joined(0, nil)])
        XCTAssertFalse(DesktopKeyRecoveryWriteOnly.drive(
            .init(pid: 123, input: 45),
            bytes: Data("abc\n".utf8),
            validate: {},
            system: early.system
        ).success)
        let unknown = WriterSystem(writes: [.progress(4)], waits: [.uncertain])
        XCTAssertFalse(DesktopKeyRecoveryWriteOnly.drive(
            .init(pid: 123, input: 45),
            bytes: Data("abc\n".utf8),
            validate: {},
            system: unknown.system
        ).joined)
    }

    func testContextChangeBeforeInputWritesNothingAndAfterJoinRefuses() {
        enum Changed: Error { case changed }
        let before = WriterSystem(writes: [], waits: [.joined(0, nil)])
        XCTAssertFalse(DesktopKeyRecoveryWriteOnly.drive(
            .init(pid: 123, input: 45),
            bytes: Data("abc\n".utf8),
            validate: { throw Changed.changed },
            system: before.system
        ).success)
        XCTAssertTrue(before.offsets.isEmpty)
        let after = WriterSystem(writes: [.progress(4)], waits: [.joined(0, nil)])
        var calls = 0
        let outcome = DesktopKeyRecoveryWriteOnly.drive(.init(pid: 123, input: 45), bytes: Data("abc\n".utf8), validate: { calls += 1
            if calls > 1 { throw Changed.changed }
        }, system: after.system)
        XCTAssertTrue(outcome.joined)
        XCTAssertFalse(outcome.success)
    }
}

private final class WriterSystem {
    var writes: [DesktopKeyRecoveryWriteOnly.Write]
    var waits: [DesktopKeyRecoveryWriteOnly.Wait]
    var offsets: [Int] = [], closed: [Int32] = [], signals: [Int32] = []
    var clock: TimeInterval = 0
    let step: TimeInterval
    init(writes: [DesktopKeyRecoveryWriteOnly.Write], waits: [DesktopKeyRecoveryWriteOnly.Wait], step: TimeInterval = 0.1) {
        self.writes = writes
        self.waits = waits
        self.step = step
    }

    var system: DesktopKeyRecoveryWriteOnly.System {
        .init(
            write: { _, _, offset in self.offsets.append(offset)
                return self.writes.isEmpty ? .retry : self.writes.removeFirst()
            },
            wait: { _ in self.waits.removeFirst() },
            signal: { _, signal in self.signals.append(signal) },
            close: { self.closed.append($0) },
            now: { self.clock },
            pause: { self.clock += self.step }
        )
    }
}
