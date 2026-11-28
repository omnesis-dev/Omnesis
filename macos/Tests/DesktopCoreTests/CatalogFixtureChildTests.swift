// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class CatalogFixtureChildTests: XCTestCase {
    private var parentKillJournal: DesktopFixturePhaseJournal?
    private var parentKillObservationSelected = false
    private var parentKillObservationRefused = false

    static func observesParentKillOperation(_ name: String) -> Bool {
        DesktopCoreLifecycleMetadata.normalize(name) ==
            "CatalogFixtureChildTests.testIntentionalParentKillRetainsChildUntilOwnedSocketExit"
    }

    private func prepareParentKillJournal() {
        guard Self.observesParentKillOperation(name) else { refuseParentKillObservation()
            return
        }
        parentKillObservationSelected = true
        do {
            var checkout = URL(fileURLWithPath: #filePath)
            for _ in 0 ..< 4 {
                checkout.deleteLastPathComponent()
            }
            let canonical = try DesktopCanonicalPath.resolve(checkout.path)
            parentKillJournal = try DesktopFixturePhaseJournal(checkout: URL(fileURLWithPath: canonical, isDirectory: true))
        } catch { refuseParentKillObservation() }
    }

    private func refuseParentKillObservation() {
        guard !parentKillObservationRefused else { return }
        parentKillObservationRefused = true
        let bytes = Array("catalog-parent-kill-observation=refused\n".utf8)
        _ = bytes.withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress, $0.count) }
    }

    private func parentKillPhase(_ phase: DesktopFixturePhaseJournal.Phase) {
        guard parentKillObservationSelected, !parentKillObservationRefused else { return }
        guard parentKillJournal?.record(phase) == true else {
            refuseParentKillObservation()
            return
        }
    }

    private func parentKillCleanupPhase(_ phase: CatalogFixtureChild.CleanupPhase) {
        switch phase {
        case .parentWaitEnter: parentKillPhase(.catalogParentKillOwnedParentWaitEnter)
        case .parentWaitReturned: parentKillPhase(.catalogParentKillOwnedParentWaitReturned)
        case .parentJoinEnter: parentKillPhase(.catalogParentKillOwnedParentJoinEnter)
        case .parentJoinReturned: parentKillPhase(.catalogParentKillOwnedParentJoinReturned)
        case .workerWaitEnter: parentKillPhase(.catalogParentKillOwnedWorkerWaitEnter)
        case .workerWaitReturned: parentKillPhase(.catalogParentKillOwnedWorkerWaitReturned)
        case .socketExitEnter: parentKillPhase(.catalogParentKillOwnedSocketExitEnter)
        case .socketExitReturned: parentKillPhase(.catalogParentKillOwnedSocketExitReturned)
        }
    }

    func testFailureBeforeAdoptionTermJoinsTheParentsExactChild() async throws {
        let fixture = try Fixture()
        addTeardownBlock { try await fixture.cleanup() }
        try fixture.startChild("setInterval(()=>{},100)")
        try await fixture.wait { fixture.output.text.contains("catalog-child-spawned") }
        XCTAssertNil(fixture.owner?.identity)
        try await fixture.owner?.cleanup(sendExit: {})
        XCTAssertFalse(fixture.parent.isRunning)
        XCTAssertTrue(fixture.output.text.contains("catalog-child-joined"))
        try fixture.removeAfterJoined()
    }

    func testAdoptedPreListenFailureStillUsesParentJoin() async throws {
        let fixture = try Fixture()
        addTeardownBlock { try await fixture.cleanup() }
        try fixture.startChild("setInterval(()=>{},100)")
        try await fixture.wait { try fixture.owner?.tryAdopt()
            return fixture.owner?.identity != nil
        }
        XCTAssertFalse(fixture.output.text.contains("catalog-ready-written"))
        try await fixture.owner?.cleanup(sendExit: {})
        XCTAssertTrue(fixture.output.text.contains("catalog-child-joined"))
        try fixture.removeAfterJoined()
    }

    func testIntentionalParentKillRetainsChildUntilOwnedSocketExit() async throws {
        prepareParentKillJournal()
        parentKillPhase(.catalogParentKillMethodEnter)
        var teardownRegistered = false
        defer {
            parentKillPhase(.catalogParentKillMethodExit)
            if !teardownRegistered { parentKillJournal = nil }
        }
        parentKillPhase(.catalogParentKillFixtureEnter)
        let fixture = try Fixture()
        parentKillPhase(.catalogParentKillFixtureReturned)
        addTeardownBlock {
            self.parentKillPhase(.catalogParentKillTeardownEnter)
            var returned = false
            defer {
                if !returned { self.parentKillPhase(.catalogParentKillTeardownUnwound) }
                self.parentKillJournal = nil
            }
            try await fixture.cleanup(observe: self.parentKillCleanupPhase)
            self.parentKillPhase(.catalogParentKillTeardownReturned)
            returned = true
        }
        teardownRegistered = true
        let socket = fixture.home.appendingPathComponent("child.sock").path
        let literal = try String(decoding: JSONEncoder().encode(socket), as: UTF8.self)
        parentKillPhase(.catalogParentKillStartEnter)
        try fixture.startChild(
            "import net from'node:net';import fs from'node:fs';let server=net.createServer(c=>c.once('data',()=>{c.end();server.close(()=>{try{fs.unlinkSync(\(literal))}catch{};process.exit(0)})}));server.listen(\(literal));",
            socket: socket
        )
        parentKillPhase(.catalogParentKillStartReturned)
        parentKillPhase(.catalogParentKillReadyEnter)
        try await fixture.wait {
            try fixture.owner?.tryAdopt()
            return fixture.owner?.identity != nil && fixture.output.text.contains("catalog-ready-written")
        }
        parentKillPhase(.catalogParentKillReadyReturned)
        parentKillPhase(.catalogParentKillControllerKillEnter)
        try fixture.owner?.killControllerAfterReady()
        parentKillPhase(.catalogParentKillControllerKillReturned)
        parentKillPhase(.catalogParentKillDirectParentWaitEnter)
        try await fixture.wait { !fixture.parent.isRunning }
        parentKillPhase(.catalogParentKillDirectParentWaitReturned)
        parentKillPhase(.catalogParentKillDirectJoinEnter)
        fixture.parent.waitUntilExit()
        parentKillPhase(.catalogParentKillDirectJoinReturned)
        var shutdownCalls = 0
        parentKillPhase(.catalogParentKillFirstCleanupEnter)
        try await fixture.owner?.cleanup(observe: parentKillCleanupPhase) {
            shutdownCalls += 1
            try Self.exitSocket(socket)
        }
        parentKillPhase(.catalogParentKillFirstCleanupReturned)
        XCTAssertFalse(FileManager.default.fileExists(atPath: socket))
        parentKillPhase(.catalogParentKillRepeatCleanupEnter)
        try await fixture.owner?.cleanup(observe: parentKillCleanupPhase) {
            shutdownCalls += 1
            throw Fixture.Failure.unavailable
        }
        parentKillPhase(.catalogParentKillRepeatCleanupReturned)
        XCTAssertEqual(shutdownCalls, 1, "Repeated cleanup must use proven child exit without contacting a removed socket")
        parentKillPhase(.catalogParentKillRemoveEnter)
        try fixture.removeAfterJoined()
        parentKillPhase(.catalogParentKillRemoveReturned)
    }

    func testJoinedAdoptedChildCanLeaveSocketEntryRetiredWithItsPrivateHome() async throws {
        let fixture = try Fixture()
        addTeardownBlock { try await fixture.cleanup() }
        let socket = fixture.home.appendingPathComponent("stale.sock").path
        let literal = try String(decoding: JSONEncoder().encode(socket), as: UTF8.self)
        try fixture.startChild("import net from'node:net';net.createServer().listen(\(literal));", socket: socket)
        try await fixture.wait {
            try fixture.owner?.tryAdopt()
            return fixture.owner?.identity != nil && fixture.output.text.contains("catalog-ready-written")
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: socket))
        try await fixture.owner?.cleanup {
            XCTFail("A live owned controller must physically join its child before filesystem cleanup")
            throw Fixture.Failure.unavailable
        }
        XCTAssertFalse(fixture.parent.isRunning)
        XCTAssertTrue(fixture.output.text.contains("catalog-child-joined"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: socket), "A stale Unix entry is not proof of a live child")
        try fixture.removeAfterJoined()
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.home.path))
    }

    func testMissingJoinProofRefusesCleanupAndRetainsFixture() async throws {
        let fixture = try Fixture()
        addTeardownBlock { try await fixture.cleanup() }
        try fixture.startRaw("process.stderr.write('entered');setInterval(()=>{},100)")
        try await fixture.wait { fixture.output.text.contains("entered") }
        let owner = try CatalogFixtureChild(
            parent: fixture.parent,
            receipt: fixture.receipt,
            images: [fixture.node.path],
            node: fixture.node,
            joined: { false }
        )
        let hint = try JSONSerialization.data(withJSONObject: ["pid": getpid()])
        try hint.write(to: fixture.receipt)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fixture.receipt.path)
        XCTAssertThrowsError(try owner.tryAdopt(), "A private PID hint must not adopt a process with the wrong kernel parent/image")
        XCTAssertNil(owner.identity)
        do { try await owner.cleanup(sendExit: {})
            XCTFail("A missing child-join proof must not certify cleanup")
        } catch CatalogFixtureChild.Failure.uncertainDrain {
            XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.home.path))
        }
        // This explicitly child-free fixture can be retired after its one exact Process joined.
        XCTAssertFalse(fixture.parent.isRunning)
        fixture.parent.waitUntilExit()
        try fixture.removeAfterJoined()
    }

    func testUnknownChildObservationCanBecomeGoneWithinTheOriginalDeadline() async throws {
        let clock = ObservationClock(step: .seconds(1))
        let drain = clock.drain()
        var observations = 0, exits = 0
        try await drain.waitForChild(observe: {
            observations += 1
            return observations < 3 ? .unknown(probeStatus: 0, probeError: 0) : .gone
        }, sendExit: { exits += 1 })
        XCTAssertEqual(observations, 3)
        XCTAssertEqual(exits, 0, "Unknown metadata cannot authorize the existing exit callback")
        XCTAssertEqual(clock.elapsed, .seconds(2))
    }

    func testVerifiedLiveObservationRequestsExitOnlyOnceAcrossLaterUnknowns() async throws {
        let clock = ObservationClock(step: .seconds(1))
        let states: [CatalogFixtureChild.ChildObservation] = [
            .unknown(probeStatus: 0, probeError: 0), .live,
            .unknown(probeStatus: -1, probeError: EPERM), .live, .gone,
        ]
        var observations = 0, exits = 0
        try await clock.drain().waitForChild(observe: {
            guard observations < states.count else {
                XCTFail("The confirmed exit must finish observation without another probe")
                return .live
            }
            let state = states[observations]
            observations += 1
            return state
        }, sendExit: { exits += 1 })
        XCTAssertEqual(observations, states.count)
        XCTAssertEqual(exits, 1)
        XCTAssertEqual(clock.elapsed, .seconds(4))
    }

    func testPersistentUnknownRefusesWithoutRenewingTheCleanupDeadline() async throws {
        let clock = ObservationClock(step: .seconds(1))
        var observations = 0, exits = 0
        do {
            try await clock.drain().waitForChild(observe: {
                observations += 1
                return .unknown(probeStatus: -1, probeError: EPERM)
            }, sendExit: { exits += 1 })
            XCTFail("Uncertain child identity must never certify exit")
        } catch CatalogFixtureChild.Failure.uncertainChildObservation(let status, let error) {
            XCTAssertEqual(status, -1)
            XCTAssertEqual(error, EPERM)
        }
        XCTAssertEqual(observations, 5)
        XCTAssertEqual(exits, 0)
        XCTAssertEqual(clock.elapsed, .seconds(5))
    }

    func testGoneObservationCompletingAtTheDeadlineCannotPass() async throws {
        let clock = ObservationClock(step: .seconds(1))
        var observations = 0
        do {
            try await clock.drain().waitForChild(observe: {
                observations += 1
                clock.elapsed = .seconds(5)
                return .gone
            })
            XCTFail("A slow observation must not accept exit at the deadline")
        } catch CatalogFixtureChild.Failure.uncertainDrain {}
        XCTAssertEqual(observations, 1)
        XCTAssertEqual(clock.pauses, 0)
    }

    func testCleanupDoesNotResampleAfterTheDeadlineToAcceptLateExit() async throws {
        let clock = ObservationClock(step: .seconds(5))
        var observations = 0
        do {
            try await clock.drain().waitForChild(observe: {
                observations += 1
                return observations == 1 ? .live : .gone
            })
            XCTFail("A future gone observation cannot rescue an expired drain")
        } catch CatalogFixtureChild.Failure.uncertainDrain {}
        XCTAssertEqual(observations, 1, "No final post-deadline probe may turn failure into success")
        XCTAssertEqual(clock.elapsed, .seconds(5))
    }

    func testParentJoinAndChildObservationShareTheRemainingFiveSecondBudget() async throws {
        for finishesInTime in [true, false] {
            let clock = ObservationClock(step: .milliseconds(4900))
            let drain = clock.drain()
            var parentObservations = 0, childObservations = 0
            try await drain.waitForParent {
                parentObservations += 1
                return parentObservations == 2
            }
            XCTAssertEqual(clock.elapsed, .milliseconds(4900))
            clock.step = finishesInTime ? .milliseconds(50) : .milliseconds(200)
            do {
                try await drain.waitForChild(observe: {
                    childObservations += 1
                    return childObservations == 1 ? .unknown(probeStatus: 0, probeError: 0) : .gone
                })
                XCTAssertTrue(finishesInTime)
                XCTAssertEqual(childObservations, 2)
            } catch CatalogFixtureChild.Failure.uncertainChildObservation {
                XCTAssertFalse(finishesInTime)
                XCTAssertEqual(childObservations, 1)
            }
            XCTAssertEqual(parentObservations, 2)
        }
    }

    func testMissingParentJoinCannotReachChildExitObservation() async throws {
        let clock = ObservationClock(step: .seconds(1))
        let drain = clock.drain()
        var childObservations = 0
        do {
            try await drain.waitForParent { false }
            try await drain.waitForChild(observe: { childObservations += 1
                return .gone
            })
            XCTFail("Missing parent join must refuse before child evidence can bypass it")
        } catch CatalogFixtureChild.Failure.uncertainDrain {}
        XCTAssertEqual(childObservations, 0)
        XCTAssertEqual(clock.elapsed, .seconds(5))
    }

    func testChildObservationKeepsUnreadableIdentityDistinctFromGone() {
        let expected = DesktopBackgroundProcessIdentity(pid: 42, parent: 7, startedSeconds: 1, startedMicroseconds: 2)
        let reparented = DesktopBackgroundProcessIdentity(pid: 42, parent: 1, startedSeconds: 1, startedMicroseconds: 2)
        let replaced = DesktopBackgroundProcessIdentity(pid: 42, parent: 1, startedSeconds: 2, startedMicroseconds: 2)
        XCTAssertEqual(CatalogFixtureChild.childObservation(expected: expected, current: reparented), .live)
        XCTAssertEqual(CatalogFixtureChild.childObservation(expected: expected, current: replaced), .gone)
        XCTAssertEqual(CatalogFixtureChild.childObservation(expected: expected, current: nil, probeStatus: -1, probeError: ESRCH), .gone)
        XCTAssertEqual(
            CatalogFixtureChild.childObservation(expected: expected, current: nil, probeStatus: 0, probeError: 0),
            .unknown(probeStatus: 0, probeError: 0)
        )
        XCTAssertEqual(
            CatalogFixtureChild.childObservation(expected: expected, current: nil, probeStatus: -1, probeError: EPERM),
            .unknown(probeStatus: -1, probeError: EPERM)
        )
    }

    private final class ObservationClock {
        private let origin = ContinuousClock.now
        var elapsed = Duration.zero
        var step: Duration
        private(set) var pauses = 0
        init(step: Duration) {
            self.step = step
        }

        func drain() -> CatalogFixtureChild.Drain {
            CatalogFixtureChild.Drain(now: { self.origin.advanced(by: self.elapsed) }, pause: {
                self.pauses += 1
                self.elapsed += self.step
            })
        }
    }

    private static func exitSocket(_ path: String) throws {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Fixture.Failure.unavailable }
        defer { Darwin.close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw Fixture.Failure.unavailable }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes.map { UInt8(bitPattern: $0) }) }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else { throw Fixture.Failure.unavailable }
        var byte: UInt8 = 1
        guard Darwin.write(fd, &byte, 1) == 1 else { throw Fixture.Failure.unavailable }
    }

    private final class Capture: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ""
        func append(_ data: Data) {
            lock.lock()
            defer { lock.unlock() }
            value = String((value + String(decoding: data, as: UTF8.self)).suffix(4096))
        }

        var text: String {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }

    private final class Fixture {
        enum Failure: Error { case unavailable, timedOut }
        let home: URL
        let node: URL
        let receipt: URL
        let parent = Process()
        let output = Capture()
        let pipe = Pipe()
        var owner: CatalogFixtureChild?
        private var childWasRequested = false
        private var socket: String?

        init() throws {
            let temporary = URL(fileURLWithPath: "/tmp").appendingPathComponent("omnesis-catalog-child-" + UUID().uuidString)
            try FileManager.default.createDirectory(
                at: temporary,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
            home = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(temporary.path), isDirectory: true)
            receipt = home.appendingPathComponent("child.json")
            let input = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent(".node-fixture")
            node = input.appendingPathComponent("node")
            let metadata = try JSONSerialization
                .jsonObject(with: Data(contentsOf: input.appendingPathComponent("node-fixture.json"))) as? [String: Any]
            let digest = try SHA256.hash(data: Data(contentsOf: node)).map { String(format: "%02x", $0) }.joined()
            guard digest == metadata?["executableSha256"] as? String else { throw Failure.unavailable }
        }

        func startChild(_ script: String, socket: String? = nil) throws {
            childWasRequested = true
            self.socket = socket
            try startRaw(CatalogFixtureChild.script(command: node.path, arguments: ["-e", script], receipt: receipt, socket: socket))
            owner = try CatalogFixtureChild(
                parent: parent,
                receipt: receipt,
                images: [node.path],
                node: node,
                joined: { [output] in output.text.contains("catalog-child-joined") }
            )
        }

        func startRaw(_ script: String) throws {
            parent.executableURL = node
            parent.arguments = ["-e", script]
            parent.environment = ["PATH": "/usr/bin:/bin"]
            parent.standardInput = FileHandle.nullDevice
            parent.standardOutput = pipe
            parent.standardError = pipe
            pipe.fileHandleForReading.readabilityHandler = { [output] in output.append($0.availableData) }
            try parent.run()
        }

        func wait(_ condition: () throws -> Bool) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while try !condition(), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            guard try condition() else { throw Failure.timedOut }
        }

        func cleanup(observe: ((CatalogFixtureChild.CleanupPhase) -> Void)? = nil) async throws {
            if let owner {
                try await owner.cleanup(observe: observe) {
                    if let socket = self.socket, FileManager.default.fileExists(atPath: socket) {
                        try CatalogFixtureChildTests.exitSocket(socket)
                    }
                }
            } else if childWasRequested { throw Failure.unavailable }
            else if parent.isRunning {
                parent.terminate()
                try await wait { !self.parent.isRunning }
                parent.waitUntilExit()
            }
            try removeAfterJoined()
        }

        func removeAfterJoined() throws {
            guard !parent.isRunning else { throw Failure.unavailable }
            pipe.fileHandleForReading.readabilityHandler = nil
            if FileManager.default.fileExists(atPath: home.path) { try FileManager.default.removeItem(at: home) }
        }
    }
}
