// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import DesktopCore
import Foundation
import XCTest

final class CatalogFixtureChildTests: XCTestCase {
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
        let fixture = try Fixture()
        addTeardownBlock { try await fixture.cleanup() }
        let socket = fixture.home.appendingPathComponent("child.sock").path
        let literal = try String(decoding: JSONEncoder().encode(socket), as: UTF8.self)
        try fixture.startChild(
            "import net from'node:net';import fs from'node:fs';let server=net.createServer(c=>c.once('data',()=>{c.end();server.close(()=>{try{fs.unlinkSync(\(literal))}catch{};process.exit(0)})}));server.listen(\(literal));",
            socket: socket
        )
        try await fixture.wait {
            try fixture.owner?.tryAdopt()
            return fixture.owner?.identity != nil && fixture.output.text.contains("catalog-ready-written")
        }
        try fixture.owner?.killControllerAfterReady()
        try await fixture.wait { !fixture.parent.isRunning }
        fixture.parent.waitUntilExit()
        var shutdownCalls = 0
        try await fixture.owner?.cleanup {
            shutdownCalls += 1
            try Self.exitSocket(socket)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: socket))
        try await fixture.owner?.cleanup {
            shutdownCalls += 1
            throw Fixture.Failure.unavailable
        }
        XCTAssertEqual(shutdownCalls, 1, "Repeated cleanup must use proven child exit without contacting a removed socket")
        try fixture.removeAfterJoined()
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

        func cleanup() async throws {
            if let owner {
                try await owner.cleanup {
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
