// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The watch promised a notification for a queued question. These pin which
/// outcomes the phone announces itself and which it leaves to the gateway's
/// push, so every ending produces exactly one.
final class QueuedAskNoticeTests: XCTestCase {
    func testATurnStillRunningIsLeftToThePush() {
        XCTAssertNil(QueuedAskNotice.notice(for: .stillWorking, conversationId: "c1"))
    }

    func testAnAnswerIsAnnouncedAndOpensItsConversation() throws {
        let notice = try XCTUnwrap(QueuedAskNotice.notice(for: .answered(text: "Friday."), conversationId: "c1"))
        XCTAssertEqual(notice.title, "Answer ready")
        XCTAssertEqual(notice.body, "Friday.")
        let payload = try XCTUnwrap(notice.userInfo["omnesis"] as? [String: String])
        XCTAssertEqual(PushTarget.fromUserInfo(["omnesis": payload]), .agentAnswer(conversationId: "c1"))
    }

    func testAFastFailureSaysWhatBroke() throws {
        let notice = try XCTUnwrap(
            QueuedAskNotice.notice(for: .failed(reason: "No agent model is assigned."), conversationId: "c1")
        )
        XCTAssertEqual(notice.title, "Answer failed")
        XCTAssertEqual(notice.body, "Sorry — No agent model is assigned.")
    }

    /// A question that never reached the gateway has no conversation to open,
    /// and says why it was not asked.
    func testAQuestionThatWasNeverAskedSaysSo() throws {
        for outcome in [SiriAskOutcome.notPaired, .unauthorized, .unreachable, .sendFailed] {
            let notice = try XCTUnwrap(QueuedAskNotice.notice(for: outcome, conversationId: nil))
            XCTAssertEqual(notice.title, "Couldn't ask your watch question")
            XCTAssertEqual(notice.body, SiriAskDialog.text(for: outcome))
            XCTAssertTrue(notice.userInfo.isEmpty)
        }
    }

    func testALongAnswerIsClippedToOneBannerLine() throws {
        let long = String(repeating: "word ", count: 80) + "\nend"
        let notice = try XCTUnwrap(QueuedAskNotice.notice(for: .answered(text: long), conversationId: "c1"))
        XCTAssertEqual(notice.body.count, QueuedAskNotice.maxBodyLength)
        XCTAssertTrue(notice.body.hasSuffix("…"))
        XCTAssertFalse(notice.body.contains("\n"))
    }
}
