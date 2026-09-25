// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The conversation list's unread flag on the wire, and the optimistic clear
/// the list applies the moment this app puts a conversation on screen.
///
/// All fixture data is invented.
final class ConversationUnreadDecodeTests: XCTestCase {
    private func decode(_ json: String) throws -> ConversationSummary {
        try JSONDecoder().decode(ConversationSummary.self, from: Data(json.utf8))
    }

    func testUnreadConversationDecodesAsUnread() throws {
        let summary = try decode(
            """
            {"id":"conv_a","title":"Permit decision","model":"m","backend":"b",
             "createdAt":"2026-05-10T09:00:00Z","updatedAt":"2026-05-10T09:05:00Z",
             "messageCount":2,"unread":true}
            """
        )
        XCTAssertTrue(summary.unread)
    }

    func testConversationWithoutTheFieldDecodesAsRead() throws {
        // A gateway that predates read state omits it entirely; the phone must
        // show no dot rather than failing to decode the list at all.
        let summary = try decode(
            """
            {"id":"conv_a","title":"Permit decision","model":"m","backend":"b",
             "createdAt":"2026-05-10T09:00:00Z","updatedAt":"2026-05-10T09:05:00Z",
             "messageCount":2}
            """
        )
        XCTAssertFalse(summary.unread)
    }

    func testMarkedReadClearsOnlyTheUnreadFlag() throws {
        let summary = try decode(
            """
            {"id":"conv_a","title":"Permit decision","model":"m","backend":"b",
             "createdAt":"2026-05-10T09:00:00Z","updatedAt":"2026-05-10T09:05:00Z",
             "messageCount":2,"pinned":true,"unread":true}
            """
        )
        let read = summary.markedRead()
        XCTAssertFalse(read.unread)
        // Everything else about the row survives, so an optimistic clear cannot
        // drop the pin or retitle the row on its way past.
        XCTAssertTrue(read.pinned)
        XCTAssertEqual(read.sessionId, summary.sessionId)
        XCTAssertEqual(read.title, summary.title)
        XCTAssertEqual(read.messageCount, summary.messageCount)
    }

    func testPinToggleCarriesTheUnreadFlagThrough() throws {
        // `withPinned` predates read state; a row pinned from the list must not
        // silently lose its dot.
        let summary = try decode(
            """
            {"id":"conv_a","title":"Permit decision","model":"m","backend":"b",
             "createdAt":"2026-05-10T09:00:00Z","updatedAt":"2026-05-10T09:05:00Z",
             "messageCount":2,"unread":true}
            """
        )
        XCTAssertTrue(summary.withPinned(true).unread)
    }
}
