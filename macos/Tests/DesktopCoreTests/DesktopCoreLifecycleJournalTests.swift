// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import DesktopCore
import Foundation
import XCTest

struct DesktopCoreLifecycleMetadata: Codable {
    enum Event: String, Codable { case registrationPrepared, caseBegin, caseEnd, suiteEnd, observationFinished }
    let event: Event
    let identifier: String?
    let scope: String
    let preparationOrdinal: Int

    init(event: Event, identifier: String?) {
        self.event = event
        self.identifier = identifier
        scope = "callbacks-after-background-observer-setup"
        preparationOrdinal = 1
    }

    var isValid: Bool {
        guard scope == "callbacks-after-background-observer-setup", preparationOrdinal == 1 else { return false }
        return switch event {
        case .registrationPrepared, .suiteEnd, .observationFinished: identifier == nil
        case .caseBegin, .caseEnd: identifier.flatMap(Self.normalize) == identifier && identifier != nil
        }
    }

    static func normalize(_ name: String) -> String? {
        guard name.utf8.count <= 320 else { return nil }
        let component = "([A-Za-z][A-Za-z0-9_]{0,79}Tests)"
        let method = "(test[A-Za-z0-9_]{1,179})"
        for pattern in [
            "^-\\[(?:DesktopCoreTests\\.)?" + component + " " + method + "\\]\\z",
            "^(?:DesktopCoreTests\\.)?" + component + "\\." + method + "\\z",
        ] {
            guard let expression = try? NSRegularExpression(pattern: pattern),
                  let match = expression.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)),
                  let classRange = Range(match.range(at: 1), in: name),
                  let methodRange = Range(match.range(at: 2), in: name) else { continue }
            let normalized = String(name[classRange]) + "." + String(name[methodRange])
            return normalized.utf8.count <= 256 ? normalized : nil
        }
        return nil
    }
}

/// A last callback is an observation, never proof of one exclusively active case or successful cleanup.
final class DesktopCoreLifecycleSink: @unchecked Sendable {
    private let owner = getpid()
    private let lock = NSLock()
    private var journal: DesktopFixturePhaseJournal?
    private var prepared = false

    init(journal: DesktopFixturePhaseJournal) {
        self.journal = journal
    }

    @discardableResult
    func record(_ event: DesktopCoreLifecycleMetadata.Event, name: String? = nil) -> Bool {
        guard getpid() == owner else { return false }
        let identifier = name.flatMap(DesktopCoreLifecycleMetadata.normalize)
        let metadata = DesktopCoreLifecycleMetadata(event: event, identifier: identifier)
        guard name == nil || identifier != nil, metadata.isValid else { return false }
        lock.lock()
        defer { lock.unlock() }
        guard event == .registrationPrepared ? !prepared : prepared else { return false }
        let written = journal?.record(.coreLifecycle, lifecycle: metadata) ?? false
        if written, event == .registrationPrepared { prepared = true }
        return written
    }

    func close() {
        guard getpid() == owner else { return }
        lock.lock()
        defer { lock.unlock() }
        journal = nil
    }
}

final class DesktopCoreLifecycleObserver: NSObject, XCTestObservation {
    private static let registrationOwner = getpid()
    private static let registrationLock = NSLock()
    private static var retained: DesktopCoreLifecycleObserver?
    private let owner = getpid()
    private let sink: DesktopCoreLifecycleSink
    private let bundle: Bundle

    private init(sink: DesktopCoreLifecycleSink, bundle: Bundle) {
        self.sink = sink
        self.bundle = bundle
    }

    static func registerAfterBackgroundObserverSetup() {
        guard getpid() == registrationOwner else { return }
        registrationLock.lock()
        defer { registrationLock.unlock() }
        guard retained == nil else { return }
        var checkout = URL(fileURLWithPath: #filePath)
        for _ in 0 ..< 4 {
            checkout.deleteLastPathComponent()
        }
        guard let path = try? DesktopCanonicalPath.resolve(checkout.path),
              let journal = try? DesktopFixturePhaseJournal(checkout: URL(fileURLWithPath: path, isDirectory: true)) else { return }
        let sink = DesktopCoreLifecycleSink(journal: journal)
        guard sink.record(.registrationPrepared) else { sink.close()
            return
        }
        let observer = DesktopCoreLifecycleObserver(sink: sink, bundle: Bundle(for: BackgroundObserverTests.self))
        retained = observer
        XCTestObservationCenter.shared.addTestObserver(observer)
    }

    func testCaseWillStart(_ testCase: XCTestCase) {
        guard getpid() == owner, String(reflecting: type(of: testCase)).hasPrefix("DesktopCoreTests.") else { return }
        sink.record(.caseBegin, name: testCase.name)
    }

    func testCaseDidFinish(_ testCase: XCTestCase) {
        guard getpid() == owner, String(reflecting: type(of: testCase)).hasPrefix("DesktopCoreTests.") else { return }
        sink.record(.caseEnd, name: testCase.name)
    }

    func testSuiteDidFinish(_ testSuite: XCTestSuite) {
        sink.record(.suiteEnd)
    }

    func testBundleDidFinish(_ testBundle: Bundle) {
        guard getpid() == owner, testBundle == bundle else { return }
        sink.record(.observationFinished)
        XCTestObservationCenter.shared.removeTestObserver(self)
        sink.close()
    }
}

final class DesktopCoreLifecycleJournalTests: XCTestCase {
    private func root() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-core-journal-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return try URL(fileURLWithPath: DesktopCanonicalPath.resolve(root.path), isDirectory: true)
    }

    func testPartialPreparationAndUnmatchedEndAreRecordedWithoutInventingABegin() throws {
        let home = try root()
        defer { try? FileManager.default.removeItem(at: home) }
        let journal = try DesktopFixturePhaseJournal(checkout: home)
        let sink = DesktopCoreLifecycleSink(journal: journal)
        defer { sink.close() }
        XCTAssertFalse(sink.record(.caseBegin, name: "BackgroundObserverTests.testInventedCase"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.directory.appendingPathComponent("latest.json").path))
        XCTAssertTrue(sink.record(.registrationPrepared))
        let file = journal.directory.appendingPathComponent("latest.json")
        let registration = try JSONDecoder().decode(DesktopFixturePhaseJournal.Record.self, from: Data(contentsOf: file))
        XCTAssertEqual(registration.lifecycle?.event, .registrationPrepared)
        XCTAssertEqual(registration.lifecycle?.scope, "callbacks-after-background-observer-setup")
        XCTAssertNil(registration.lifecycle?.identifier)
        XCTAssertEqual(registration.lifecycle?.preparationOrdinal, 1)
        for invalid in [
            "BackgroundObserverTests.testInventedCase\n",
            "OtherModule.BackgroundObserverTests.testInventedCase",
            "BackgroundObserverTests.testInventedCase/private",
        ] {
            XCTAssertNil(DesktopCoreLifecycleMetadata.normalize(invalid))
        }
        XCTAssertTrue(sink.record(.caseEnd, name: "-[DesktopCoreTests.BackgroundObserverTests testInventedCase]"))
        let end = try JSONDecoder().decode(DesktopFixturePhaseJournal.Record.self, from: Data(contentsOf: file))
        XCTAssertEqual(end.sequence, registration.sequence + 1)
        XCTAssertEqual(end.lifecycle?.event, .caseEnd)
        XCTAssertEqual(end.lifecycle?.identifier, "BackgroundObserverTests.testInventedCase")
        XCTAssertEqual(end.lifecycle?.preparationOrdinal, registration.sequence)
        let before = try Data(contentsOf: file)
        XCTAssertFalse(sink.record(.caseBegin, name: "invented private message https://example.com"))
        XCTAssertFalse(sink.record(.caseBegin, name: String(repeating: "a", count: 321)))
        XCTAssertEqual(try Data(contentsOf: file), before)
        sink.close()
        XCTAssertFalse(sink.record(.caseBegin, name: "BackgroundObserverTests.testInventedCase"))
        XCTAssertEqual(try Data(contentsOf: file), before)
    }

    func testFailedPreparationKeepsTheOldRecordAndCannotAttributeACallback() throws {
        let home = try root()
        defer { try? FileManager.default.removeItem(at: home) }
        let journal = try DesktopFixturePhaseJournal(checkout: home)
        XCTAssertTrue(journal.record(.setupEnter))
        let file = journal.directory.appendingPathComponent("latest.json")
        let before = try Data(contentsOf: file)
        let sink = DesktopCoreLifecycleSink(journal: journal)
        defer { sink.close() }
        XCTAssertFalse(sink.record(.registrationPrepared), "A lifecycle observer requires its own fresh journal")
        XCTAssertFalse(sink.record(.caseEnd, name: "BackgroundObserverTests.testInventedCase"))
        XCTAssertEqual(try Data(contentsOf: file), before)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: before) as? [String: Any])
        XCTAssertNil(object["lifecycle"], "An unregistered journal cannot identify a test")
    }

    func testConcurrentCallbackRecordsRemainPrivateBoundedAndAtomicallyDecodable() async throws {
        let home = try root()
        defer { try? FileManager.default.removeItem(at: home) }
        let journal = try DesktopFixturePhaseJournal(checkout: home)
        let sink = DesktopCoreLifecycleSink(journal: journal)
        defer { sink.close() }
        XCTAssertTrue(sink.record(.registrationPrepared))
        let file = journal.directory.appendingPathComponent("latest.json")
        await withTaskGroup(of: Bool.self) { tasks in
            for index in 0 ..< 32 {
                tasks.addTask {
                    guard sink.record(index.isMultiple(of: 2) ? .caseBegin : .caseEnd, name: "BackgroundObserverTests.testInventedCase"),
                          let bytes = try? Data(contentsOf: file), bytes.count <= 1024,
                          let record = try? JSONDecoder().decode(DesktopFixturePhaseJournal.Record.self, from: bytes) else { return false }
                    return record.lifecycle?.identifier == "BackgroundObserverTests.testInventedCase"
                }
            }
            for await accepted in tasks {
                XCTAssertTrue(accepted)
            }
        }
        let bytes = try Data(contentsOf: file)
        let record = try JSONDecoder().decode(DesktopFixturePhaseJournal.Record.self, from: bytes)
        XCTAssertEqual(record.sequence, 33)
        XCTAssertLessThanOrEqual(bytes.count, 1024)
        for (url, mode) in [
            (journal.directory, mode_t(0o700)),
            (file, mode_t(0o600)),
        ] {
            var info = stat()
            XCTAssertEqual(lstat(url.path, &info), 0)
            XCTAssertEqual(info.st_mode & 0o7777, mode)
            XCTAssertEqual(info.st_uid, getuid())
        }
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["format", "phase", "sequence", "elapsedMs", "mainThread", "lifecycle"])
        let metadata = try XCTUnwrap(object["lifecycle"] as? [String: Any])
        XCTAssertEqual(Set(metadata.keys), ["event", "identifier", "scope", "preparationOrdinal"])
        XCTAssertEqual(
            try Set(FileManager.default.contentsOfDirectory(atPath: journal.directory.path)),
            ["latest.json"]
        )
    }

    func testRemovedRootAndReplacedRecordCannotBeRecreatedOrFollowedByCallbacks() throws {
        let home = try root(), outside = try root()
        defer { try? FileManager.default.removeItem(at: home)
            try? FileManager.default.removeItem(at: outside)
        }
        let journal = try DesktopFixturePhaseJournal(checkout: home)
        let sink = DesktopCoreLifecycleSink(journal: journal)
        defer { sink.close() }
        XCTAssertTrue(sink.record(.registrationPrepared))
        let file = journal.directory.appendingPathComponent("latest.json")
        let sentinel = outside.appendingPathComponent("invented.txt")
        try Data("fictional sentinel".utf8).write(to: sentinel)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: sentinel)
        XCTAssertFalse(sink.record(.caseBegin, name: "BackgroundObserverTests.testInventedCase"))
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("fictional sentinel".utf8))
        try FileManager.default.removeItem(at: home)
        XCTAssertFalse(sink.record(.suiteEnd))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.path))
    }
}

/// Inspect XCTest's discovered names without invoking Data setup or any method.
final class DesktopExclusiveOperationSelectionTests: XCTestCase {
    private let selected = "DataUsageLeaseTests.testExclusiveDescriptorSurvivesOperationParentKillThroughWorkerMapping"

    func testEveryCanonicalSpellingIsSelectedButUnrelatedOrMalformedNamesAreNot() {
        let method = "testExclusiveDescriptorSurvivesOperationParentKillThroughWorkerMapping"
        for name in [
            "DataUsageLeaseTests." + method,
            "DesktopCoreTests.DataUsageLeaseTests." + method,
            "-[DesktopCoreTests.DataUsageLeaseTests " + method + "]",
            "-[DataUsageLeaseTests " + method + "]",
        ] {
            XCTAssertEqual(DesktopCoreLifecycleMetadata.normalize(name), selected)
            XCTAssertTrue(DataUsageLeaseTests.observesExclusiveOperation(name))
            XCTAssertFalse(DataUsageLeaseTests.observesExclusiveOperation("prefix" + name))
            XCTAssertFalse(DataUsageLeaseTests.observesExclusiveOperation(name + "suffix"))
            XCTAssertFalse(DataUsageLeaseTests.observesExclusiveOperation(name + "\n"))
        }
        for name in [
            "OtherModule.DataUsageLeaseTests." + method,
            "-[OtherModule.DataUsageLeaseTests " + method + "]",
            "DataUsageLeaseTests.testAnUnrelatedInventedCase",
            "OtherTests." + method,
            String(repeating: "x", count: 321),
        ] {
            XCTAssertFalse(DataUsageLeaseTests.observesExclusiveOperation(name))
        }
    }

    func testNativeDiscoveredDataCaseNamesIncludeExactlyOneSelectedOperation() throws {
        let discovered = DataUsageLeaseTests.defaultTestSuite.tests
        XCTAssertFalse(discovered.isEmpty, "Native Data discovery must expose its cases")
        var expectedMatches = 0, actualMatches = 0
        for test in discovered {
            let instance = try XCTUnwrap(test as? DataUsageLeaseTests, "Native discovery must return the exact Data test class")
            // No raw name is printed or fabricated with init(selector:).
            let expected = DesktopCoreLifecycleMetadata.normalize(instance.name) == selected
            let actual = DataUsageLeaseTests.observesExclusiveOperation(instance.name)
            XCTAssertEqual(actual, expected, "The actual setup selector must agree with the canonical native name")
            if expected { expectedMatches += 1 }
            if actual { actualMatches += 1 }
        }
        XCTAssertEqual(expectedMatches, 1, "Native discovery must canonically identify exactly one selected operation")
        XCTAssertEqual(actualMatches, 1, "The actual setup selector must admit that discovered operation")
    }
}
