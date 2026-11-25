// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

@MainActor
final class BridgeReplyWaiterTests: XCTestCase {
    private func envelope(_ id: String, result: String) throws -> BridgeEnvelope {
        try JSONDecoder().decode(BridgeEnvelope.self, from: Data("{\"version\":1,\"id\":\"\(id)\",\"ok\":true,\"result\":\(result)}".utf8))
    }

    func testUnrelatedAcknowledgmentNeverCompletesTheOriginalRequest() async throws {
        var sent: [String] = []
        let waiter = DesktopBridgeReplyWaiter { name, _ in sent.append(name)
            return "original"
        }
        var finished = false
        let task = Task { defer { finished = true }
            return try await waiter.request("restorePreview")
        }
        for _ in 0 ..< 100 where sent.isEmpty {
            await Task.yield()
        }
        XCTAssertEqual(sent, ["restorePreview"])
        XCTAssertFalse(try waiter.receive(envelope("other", result: "null")))
        XCTAssertFalse(finished)
        XCTAssertTrue(try waiter.receive(envelope("original", result: #"{"verified":true}"#)))
        let value = try await task.value
        XCTAssertEqual(value, .object(["verified": .bool(true)]))
    }

    func testCancellationWaitsForActualReplyAndPreservesACommittedSuccess() async throws {
        var sent: [String] = []
        let waiter = DesktopBridgeReplyWaiter { name, _ in sent.append(name)
            return name == "cancel" ? "ack" : "operation"
        }
        var finished = false
        let task = Task { defer { finished = true }
            return try await waiter.request("restoreApply")
        }
        for _ in 0 ..< 100 where sent.isEmpty {
            await Task.yield()
        }
        task.cancel()
        for _ in 0 ..< 100 where !sent.contains("cancel") {
            await Task.yield()
        }
        XCTAssertTrue(sent.contains("cancel"))
        XCTAssertFalse(try waiter.receive(envelope("ack", result: #"{"cancelled":true}"#)))
        XCTAssertFalse(finished)
        try waiter.receive(envelope("operation", result: #"{"status":"restored"}"#))
        let value = try await task.value
        XCTAssertEqual(value, .object(["status": .string("restored")]))
    }

    func testLostPipeResumesAwaitersWithAnError() async throws {
        var sent = false
        let waiter = DesktopBridgeReplyWaiter { _, _ in sent = true
            return "request"
        }
        let task = Task { try await waiter.request("restoreImport") }
        for _ in 0 ..< 100 where !sent {
            await Task.yield()
        }
        waiter.failAll("The background connection ended.")
        do { _ = try await task.value
            XCTFail("Lost pipe must refuse success")
        } catch { XCTAssertEqual(error.localizedDescription, "The background connection ended.") }
    }
}
