// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import DesktopCore
import Foundation
import XCTest

/// Latest fixed phase only; an I/O failure disables observation, never fixture cleanup.
final class DesktopFixturePhaseJournal: @unchecked Sendable {
    enum Phase: String, Codable {
        case coreLifecycle = "core-lifecycle"
        case exclusiveAvailableReadyEnter = "exclusive-available-ready-enter"
        case exclusiveAvailableReadyReturned = "exclusive-available-ready-returned"
        case exclusiveAvailableStartEnter = "exclusive-available-start-enter"
        case exclusiveAvailableStartReturned = "exclusive-available-start-returned"
        case exclusiveChildCleanupEnter = "exclusive-child-cleanup-enter"
        case exclusiveChildCleanupReturned = "exclusive-child-cleanup-returned"
        case exclusiveChildTrackEnter = "exclusive-child-track-enter"
        case exclusiveChildTrackReturned = "exclusive-child-track-returned"
        case exclusiveControllerKillEnter = "exclusive-controller-kill-enter"
        case exclusiveControllerKillReturned = "exclusive-controller-kill-returned"
        case exclusiveDeniedExitEnter = "exclusive-denied-exit-enter"
        case exclusiveDeniedExitReturned = "exclusive-denied-exit-returned"
        case exclusiveDeniedStartEnter = "exclusive-denied-start-enter"
        case exclusiveDeniedStartReturned = "exclusive-denied-start-returned"
        case exclusiveHomeRemoveEnter = "exclusive-home-remove-enter"
        case exclusiveHomeRemoveReturned = "exclusive-home-remove-returned"
        case exclusiveObserverCloseEnter = "exclusive-observer-close-enter"
        case exclusiveObserverCloseReturned = "exclusive-observer-close-returned"
        case exclusiveOperationExitEnter = "exclusive-operation-exit-enter"
        case exclusiveOperationExitReturned = "exclusive-operation-exit-returned"
        case exclusiveOperationReadyEnter = "exclusive-operation-ready-enter"
        case exclusiveOperationReadyReturned = "exclusive-operation-ready-returned"
        case exclusiveOperationStartEnter = "exclusive-operation-start-enter"
        case exclusiveOperationStartReturned = "exclusive-operation-start-returned"
        case exclusiveParentJoinEnter = "exclusive-parent-join-enter"
        case exclusiveParentJoinReturned = "exclusive-parent-join-returned"
        case exclusiveParentWaitEnter = "exclusive-parent-wait-enter"
        case exclusiveParentWaitReturned = "exclusive-parent-wait-returned"
        case exclusiveReadersEnter = "exclusive-readers-enter"
        case exclusiveReadersReturned = "exclusive-readers-returned"
        case exclusiveRetireEnter = "exclusive-retire-enter"
        case exclusiveRetireReturned = "exclusive-retire-returned"
        case exclusiveRuntimePrepareEnter = "exclusive-runtime-prepare-enter"
        case exclusiveRuntimePrepareReturned = "exclusive-runtime-prepare-returned"
        case exclusiveSetupEnter = "exclusive-setup-enter"
        case exclusiveSetupReturned = "exclusive-setup-returned"
        case exclusiveSocketAbsentEnter = "exclusive-socket-absent-enter"
        case exclusiveSocketAbsentReturned = "exclusive-socket-absent-returned"
        case exclusiveSocketExitEnter = "exclusive-socket-exit-enter"
        case exclusiveSocketExitReturned = "exclusive-socket-exit-returned"
        case exclusiveTeardownChildEnter = "exclusive-teardown-child-enter"
        case exclusiveTeardownChildReturned = "exclusive-teardown-child-returned"
        case exclusiveTeardownEnter = "exclusive-teardown-enter"
        case exclusiveTeardownProcessEnter = "exclusive-teardown-process-enter"
        case exclusiveTeardownProcessReturned = "exclusive-teardown-process-returned"
        case exclusiveTeardownReturned = "exclusive-teardown-returned"
        case exclusiveTeardownSocketExitEnter = "exclusive-teardown-socket-exit-enter"
        case exclusiveTeardownSocketExitReturned = "exclusive-teardown-socket-exit-returned"
        case exclusiveTeardownSocketsEnter = "exclusive-teardown-sockets-enter"
        case exclusiveTeardownSocketsReturned = "exclusive-teardown-sockets-returned"
        case exclusiveWorkerWaitEnter = "exclusive-worker-wait-enter"
        case exclusiveWorkerWaitReturned = "exclusive-worker-wait-returned"

        case exclusiveReaderCloseEnter = "exclusive-reader-close-enter"
        case exclusiveReaderCloseReturned = "exclusive-reader-close-returned"
        case exclusiveTeardownProcessJoinEnter = "exclusive-teardown-process-join-enter"
        case exclusiveTeardownProcessJoinReturned = "exclusive-teardown-process-join-returned"
        case setupEnter = "setup-enter", setupReturned = "setup-returned", teardownEnter = "teardown-enter"
        case catalogJoined = "catalog-joined", processJoinEnter = "process-join-enter", processJoinReturned = "process-join-returned"
        case readersRetired = "readers-retired", readerEOF = "reader-eof", readerDisarmed = "reader-disarmed"
        case readerCloseGateEntered = "reader-close-gate-entered", readerCloseEnter = "reader-close-enter", readerCloseReturned = "reader-close-returned"
    }

    private struct Directory {
        let url: URL
        let fd: Int32
        let identity: stat
        let privateMode: Bool
    }

    struct Record: Codable {
        let format: Int
        let phase: Phase
        let sequence: Int
        let elapsedMs: Int
        let mainThread: Bool
        let lifecycle: DesktopCoreLifecycleMetadata?
    }

    private enum Failure: Error { case refused }
    private let directories: [Directory]
    let directory: URL
    private let owner = getpid()
    private let began = ContinuousClock.now
    private let lock = NSLock()
    private var sequence = 0
    private var disabled = false
    private var published: stat?
    private var lifecyclePreparationOrdinal: Int?
    private static let temporaryName = "phase.next"
    private static let recordName = "latest.json"

    init(checkout: URL) throws {
        guard try DesktopCanonicalPath.resolve(checkout.path) == checkout.path else { throw Failure.refused }
        var opened: [Directory] = []
        var accepted = false
        defer { if !accepted { opened.forEach { Darwin.close($0.fd) } } }
        func retain(_ url: URL, descriptor: Int32, privateMode: Bool) throws {
            guard descriptor >= 0 else { throw Failure.refused }
            var info = stat()
            guard fstat(descriptor, &info) == 0 else { Darwin.close(descriptor)
                throw Failure.refused
            }
            let entry = Directory(url: url, fd: descriptor, identity: info, privateMode: privateMode)
            guard Self.valid(entry) else { Darwin.close(descriptor)
                throw Failure.refused
            }
            opened.append(entry)
        }
        try retain(checkout, descriptor: Darwin.open(checkout.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), privateMode: false)
        let leaf = "fixture-phase-" + UUID().uuidString
        for component in ["evidence", "readiness-diagnostics", leaf] {
            guard let parent = opened.last, opened.allSatisfy(Self.valid) else { throw Failure.refused }
            let created = mkdirat(parent.fd, component, 0o700)
            guard created == 0 || (component != leaf && errno == EEXIST) else { throw Failure.refused }
            try retain(
                parent.url.appendingPathComponent(component, isDirectory: true),
                descriptor: openat(parent.fd, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC),
                privateMode: true
            )
        }
        directories = opened
        directory = opened.last!.url
        accepted = true
    }

    deinit { directories.forEach { Darwin.close($0.fd) } }

    private static func valid(_ entry: Directory) -> Bool {
        var held = stat(), path = stat()
        return fstat(entry.fd, &held) == 0 && lstat(entry.url.path, &path) == 0 &&
            held.st_mode & S_IFMT == S_IFDIR && held.st_uid == getuid() &&
            held.st_mode & (entry.privateMode ? 0o7777 : 0o022) == (entry.privateMode ? 0o700 : 0) &&
            held.st_dev == entry.identity.st_dev && held.st_ino == entry.identity.st_ino &&
            held.st_dev == path.st_dev && held.st_ino == path.st_ino && path.st_mode & S_IFMT == S_IFDIR
    }

    private static func privateFile(_ info: stat) -> Bool {
        info.st_mode & S_IFMT == S_IFREG && info.st_uid == getuid() && info.st_mode & 0o7777 == 0o600 && info.st_nlink == 1
    }

    @discardableResult
    func record(_ phase: Phase, lifecycle: DesktopCoreLifecycleMetadata? = nil) -> Bool {
        // A fork may inherit this lock while another parent thread held it.
        // Reject before locking or accessing any Foundation/file state.
        guard getpid() == owner else { return false }
        lock.lock()
        defer { lock.unlock() }
        guard !disabled else { return false }
        var succeeded = false
        defer { if !succeeded { disabled = true } }
        guard getpid() == owner, sequence < 65535, directories.allSatisfy(Self.valid), let target = directories.last else { return false }
        if let lifecycle {
            guard phase == .coreLifecycle, lifecycle.isValid,
                  lifecycle.event == .registrationPrepared ? sequence == 0 : lifecyclePreparationOrdinal == lifecycle.preparationOrdinal
            else {
                return false
            }
        }
        var current = stat()
        let exists = fstatat(target.fd, Self.recordName, &current, AT_SYMLINK_NOFOLLOW)
        if let published {
            guard exists == 0, Self.privateFile(current), current.st_dev == published.st_dev,
                  current.st_ino == published.st_ino, current.st_size == published.st_size else { return false }
        } else {
            guard exists != 0, errno == ENOENT else { return false }
        }
        let elapsed = began.duration(to: .now)
        let milliseconds: Int
        if elapsed <= .zero { milliseconds = 0 }
        else if elapsed >= .seconds(3600) { milliseconds = 3_600_000 }
        else { let parts = elapsed.components
            milliseconds = Int(parts.seconds * 1000 + parts.attoseconds / 1_000_000_000_000_000)
        }
        sequence += 1
        guard let bytes = try? JSONEncoder().encode(Record(
            format: 1,
            phase: phase,
            sequence: sequence,
            elapsedMs: milliseconds,
            mainThread: Thread.isMainThread,
            lifecycle: lifecycle
        )),
            bytes.count <= 1024 else { return false }
        let fd = openat(target.fd, Self.temporaryName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return false }
        defer { Darwin.close(fd) }
        var original = stat()
        guard fstat(fd, &original) == 0, Self.privateFile(original) else { return false }
        var renamed = false
        defer {
            if !renamed {
                var temporary = stat()
                if fstatat(target.fd, Self.temporaryName, &temporary, AT_SYMLINK_NOFOLLOW) == 0,
                   temporary.st_dev == original.st_dev, temporary.st_ino == original.st_ino {
                    _ = unlinkat(target.fd, Self.temporaryName, 0)
                }
            }
        }
        let written = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        guard written == bytes.count, fstat(fd, &original) == 0, Self.privateFile(original), original.st_size == bytes.count,
              directories.allSatisfy(Self.valid),
              renameat(target.fd, Self.temporaryName, target.fd, Self.recordName) == 0 else { return false }
        renamed = true
        var result = stat()
        guard fstatat(target.fd, Self.recordName, &result, AT_SYMLINK_NOFOLLOW) == 0, Self.privateFile(result),
              result.st_dev == original.st_dev, result.st_ino == original.st_ino, result.st_size == bytes.count,
              directories.allSatisfy(Self.valid) else { return false }
        published = result
        if lifecycle?.event == .registrationPrepared { lifecyclePreparationOrdinal = sequence }
        succeeded = true
        return true
    }
}

final class DesktopFixturePhaseJournalTests: XCTestCase {
    private func isolatedRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-phase-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return try URL(fileURLWithPath: DesktopCanonicalPath.resolve(root.path), isDirectory: true)
    }

    func testConcurrentAtomicRecordsStayPrivateBoundedAndKeepOnlyTheLatest() async throws {
        let root = try isolatedRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let journal = try DesktopFixturePhaseJournal(checkout: root)
        XCTAssertTrue(journal.record(.setupEnter))
        let file = journal.directory.appendingPathComponent("latest.json")
        await withTaskGroup(of: Bool.self) { tasks in
            for _ in 0 ..< 32 {
                tasks.addTask {
                    guard journal.record(.readerCloseEnter), let data = try? Data(contentsOf: file), data.count <= 1024,
                          let record = try? JSONDecoder().decode(DesktopFixturePhaseJournal.Record.self, from: data) else { return false }
                    return record.format == 1 && (1 ... 33).contains(record.sequence)
                }
            }
            for await accepted in tasks {
                XCTAssertTrue(accepted)
            }
        }
        XCTAssertTrue(journal.record(.teardownEnter))
        let bytes = try Data(contentsOf: file)
        let record = try JSONDecoder().decode(DesktopFixturePhaseJournal.Record.self, from: bytes)
        XCTAssertEqual(record.sequence, 34)
        XCTAssertEqual(record.phase, .teardownEnter)
        XCTAssertTrue((0 ... 3_600_000).contains(record.elapsedMs))
        XCTAssertLessThanOrEqual(bytes.count, 1024)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: journal.directory.path), ["latest.json"])
        for (url, mode) in [(journal.directory, mode_t(0o700)), (file, mode_t(0o600))] {
            var info = stat()
            XCTAssertEqual(lstat(url.path, &info), 0)
            XCTAssertEqual(info.st_uid, getuid())
            XCTAssertEqual(info.st_mode & 0o7777, mode)
        }
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["format", "phase", "sequence", "elapsedMs", "mainThread"])
    }

    func testRemovedScratchIsNeverRecreatedByTheInitializedJournal() throws {
        let root = try isolatedRoot()
        let journal = try DesktopFixturePhaseJournal(checkout: root)
        XCTAssertTrue(journal.record(.setupEnter))
        try FileManager.default.removeItem(at: root)
        XCTAssertFalse(journal.record(.readerEOF))
        XCTAssertFalse(journal.record(.teardownEnter))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }

    func testSymlinkParentAndReplacedRecordAreRefusedWithoutTouchingTheirTarget() throws {
        let root = try isolatedRoot(), outside = try isolatedRoot()
        defer { try? FileManager.default.removeItem(at: root)
            try? FileManager.default.removeItem(at: outside)
        }
        let manager = FileManager.default
        let evidence = root.appendingPathComponent("evidence")
        try manager.createSymbolicLink(at: evidence, withDestinationURL: outside)
        XCTAssertThrowsError(try DesktopFixturePhaseJournal(checkout: root))
        XCTAssertTrue(try manager.contentsOfDirectory(atPath: outside.path).isEmpty)
        try manager.removeItem(at: evidence)
        let journal = try DesktopFixturePhaseJournal(checkout: root)
        XCTAssertTrue(journal.record(.setupEnter))
        let original = outside.appendingPathComponent("invented-record.txt")
        try Data("fictional sentinel".utf8).write(to: original)
        let latest = journal.directory.appendingPathComponent("latest.json")
        try manager.removeItem(at: latest)
        try manager.createSymbolicLink(at: latest, withDestinationURL: original)
        XCTAssertFalse(journal.record(.readerCloseEnter))
        XCTAssertEqual(try Data(contentsOf: original), Data("fictional sentinel".utf8))
        XCTAssertTrue(try manager.destinationOfSymbolicLink(atPath: latest.path) == original.path)
    }
}
